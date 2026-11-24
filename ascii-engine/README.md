# WhatIf ASCII Engine

A code-only 3D engine for **ASCII art + point-cloud + particle environments + luminous wireframe** visuals, with
deterministic frame rendering and FFmpeg video output. Three.js + WebGL 2 + custom GLSL. **No Blender, no paid
software.** It renders vertical 9:16 (Reels/TikTok/Shorts) and 16:9, previews in real time in a browser, and writes
frames into the repo's existing pipeline (`tools/pipeline/`: manifest, validation, safe assembly, MP4 verification).

Design and decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Reference video breakdown: [`docs/REFERENCE_ANALYSIS.md`](docs/REFERENCE_ANALYSIS.md). What was rendered, inspected and changed: [`docs/VISUAL_QA.md`](docs/VISUAL_QA.md).

## Quick start (Windows laptop)

```bat
cd C:\Users\User\Documents\Blender\WhatIfStudio\ascii-engine
npm install                         :: three, gsap, playwright-core (no browser download)

:: Real-time preview: open the printed URL in Edge/Chrome
npm run preview
::   http://127.0.0.1:5173/?scene=prototype&format=9x16&quality=preview

:: Stills for inspection (never overwritten; written to episodes\<cut>\previews\)
node tools\render.mjs --scene prototype --still --frames 1,90,180,240 --quality draft --channel msedge

:: Full render + encode (frames -> episodes\<cut>\frames, MP4 -> episodes\<cut>\output)
node tools\render.mjs --scene prototype --format 9x16 --quality final --cut my_cut --channel msedge --gpu --encode
```

`--channel msedge` uses the installed Edge (or `chrome`), so nothing has to be downloaded. The first lines of every
render print the WebGL renderer: it should name the Intel GPU. If it says `SwiftShader`, the browser fell back to
the CPU. Try `--gpu`, or `--headed` (a visible window always gets the GPU).

FFmpeg must be on PATH for `--encode` (see the repo `CLAUDE.md` for the Gyan build location), or set `ffmpeg_dir`
in `configs/<cut>.json` and run `python tools\pipeline\assemble_safe.py --config configs\<cut>.json` yourself.

## Render tool (`tools/render.mjs`)

| Option | Default | Meaning |
|---|---|---|
| `--scene` | `prototype` | file in `scenes/` |
| `--format` | `9x16` | `9x16` 720x1280, `9x16-hd` 1080x1920, `16x9` 1280x720, `16x9-hd` 1920x1080, `1x1` 1080x1080 |
| `--size WxH` | | custom size (even numbers) |
| `--quality` | `final` | `preview` / `draft` / `final` / `master` (table below) |
| `--fps` | `30` | any rate (24/25/30/60); the scene duration fixes the frame count |
| `--cut` | `<scene>_<format>_<quality>_<fps>fps` | output folder `episodes/<cut>/` and config `configs/<cut>.json` |
| `--start --end` | whole cut | render a chunk (resumable) |
| `--encode` | off | after rendering, run `tools/pipeline/assemble_safe.py` (or `tools/encode.mjs` without Python) |
| `--still --frames 1,90` | | inspection stills only; `--repeat-check` renders each twice and compares hashes |
| `--channel` / `--executable` | Playwright Chromium | `msedge`, `chrome`, or a browser path |
| `--gpu`, `--headed` | off | GPU flags / visible window |
| `--seed` | `1` | scene seed |
| `--letterbox` | scene's `meta.letterbox` | picture aspect inside the frame, e.g. `4:5` (black bars), `0` = off |
| `--set key=value` | | scene-specific parameter (repeatable), e.g. `--set surface=1` for `glb_test` |

Safety, same rules as the Blender pipeline:
- Existing frames are **skipped, never overwritten**. Re-running after a crash resumes where it stopped.
- `configs/<cut>.json` is written once. If you change the scene, format, fps, quality or seed, the tool refuses and asks for a new `--cut`.
- A `logs/render.lock` stops a second render of the same cut (one heavy job at a time).
- Stills get `_v2`, `_v3` suffixes instead of replacing files.
- Frames are RGB PNG `frame_####.png`, encoded in Node from raw `readPixels`. Encoding overlaps the next frame's render.
- Per-frame timings go to `episodes/<cut>/logs/render_<time>.json`.

Other tools: `tools/serve.mjs` (preview server), `tools/encode.mjs` (FFmpeg fallback with an ffprobe check),
`tools/compare.mjs --ref <video> --cut <cut>` (reference vs render side-by-side sheets),
`tools/fetch_sample_models.mjs` (downloads a CC-BY test GLB to the git-ignored `assets/models/`).

## Presets and measured cost

Measured in the cloud container on **SwiftShader** (a CPU rasteriser, 4 cores: slower than an iGPU, so treat these as upper bounds).
Prototype scene, 720x1280:

| Quality | Particles | Supersample | ms / frame | Use |
|---|---|---|---|---|
| `preview` | ~65k | 0.6x size | real time, 6 fps at 432x768 on SwiftShader | interactive preview |
| `draft` | ~118k | 1.0 | ~500-650 | quick stills and timing tests |
| `final` | ~185k | 1.0 | **~790** (render + encode, pipelined) | delivery |
| `master` | ~185k | 1.5 | ~1330 | marginally smoother edges; rarely worth it |

10 s at 30 fps took about 4 minutes at `final`. Scene build (sampling about 110k character particles with AO
and curvature) takes about 4 s at `final`.

## Writing a scene

A scene is a module in `scenes/` exporting `meta` and `build(engine)`:

```js
import { createSky } from '../src/env/Sky.js';
import { createBuilding } from '../src/env/Building.js';
import { PointCloudCharacter } from '../src/characters/PointCloudCharacter.js';
import { emptyPose, idle, walk, applyPose } from '../src/characters/poses.js';
import { CameraRig } from '../src/anim/CameraRig.js';
import { keys, glitchBurst, extendTimeline } from '../src/anim/Timeline.js';

export const meta = { name: 'my_scene', duration: 8, darkRanges: [] };

export async function build(engine) {
  engine.duration = meta.duration;
  engine.scene.add(createSky(engine, { glowAmount: 0.3 }).object);
  engine.scene.add(createBuilding(engine, { at: [6, -10], size: [8, 30, 8] }).object);
  engine.lightRig.add({ position: [0, 3, -6], color: '#ff2a1f', intensity: 2, range: 12 });

  const hero = PointCloudCharacter.procedural(engine, { seed: 7 });
  engine.scene.add(hero.group);
  engine.onUpdate((t) => {                 // pure function of t: deterministic, resumable
    const pose = emptyPose();
    idle(pose, t);
    applyPose(hero, pose);
    hero.updateHalo(t);
  });
  keys(engine, hero.state, 'emerge', [[0, 0], [2, 1, 'power2.out']]);   // particle emergence
  glitchBurst(engine, 4.0);                                              // glitch transition
  new CameraRig(engine, [{ start: 0, end: 8, pos: [[0, 1.2, 5], [0, 1.4, 3.5]], target: [[0, 1.3, 0]], fov: 45 }]);
  extendTimeline(engine, meta.duration);
}
```

Rules for scenes: no `Math.random()` and no wall-clock time. Use `Rng` from `src/core/random.js`, the `t`
passed to hooks, and `keys()`/GSAP on `engine.timeline`. Every module takes a `seed`.

## Systems (where to look)

| System | Files | Notes |
|---|---|---|
| A. ASCII renderer | `src/glyphs/GlyphAtlas.js`, `src/shaders/GlyphSurfaceMaterial.js`, `ParticleMaterial.js` (glyph/stroke modes) | Canvas-built bitmap font + marks, coverage-sorted ramps (`ramp`, `arch`, `veg`, `terrain`, `char`, `stroke`, `code`, `mark`). Glyph choice follows lit luminance. Surface glyphs are triplanar world-space cells with anisotropic AA |
| B. Point-cloud characters | `src/characters/HumanSDF.js`, `PointCloudCharacter.js`, `poses.js` | Procedural human (SDF anatomy, 20 bones), or any GLTF/GLB via `fromObject()`. GPU skinning from the bone texture, AO and curvature shading, feature clusters, hair strokes, depth-only occluder, halo |
| C. Environment | `src/env/*` | Sky, Ground (terrain, ponds as holes), Street (lanes, curbs, lamps), Building (setbacks, windows, edges, surface glyphs, beacon), Pavilion (curved tiled roof, lit panels), Water (pond, ripples), Vegetation (trees, shrubs, grass, line reeds, pines + wind), Atmosphere (dust, embers, code rain), EnergySource (globe, beam), Structures (pylons, cables, portals, lanterns) |
| D. Shaders | `src/shaders/chunks.js` + materials, `src/post/PostFX.js` | Noise, lighting rig, sky-matched fog, flicker, glitch slicing, emergence, sway, drift, skinning. Post: Karis-average bloom, radial CA + glitch RGB kick, block fragmentation, scanlines, grain, vignette, AgX, grade |
| E. Animation | `src/anim/Timeline.js`, `CameraRig.js` | Paused GSAP timeline seeked per frame. `keys()`, `glitchBurst()`, `pulse()`. Spline shots with handheld noise and auto-focus |
| F. Video | `tools/render.mjs`, `png.mjs`, `encode.mjs`, `compare.mjs` | See above |

Example scenes: `garden_test` (**reference look**: text-textured figure in a night pond, 16 s, 4:5 letterbox),
`prototype` (Phase 3 city test, 10 s), `character_test` (character turntable, 12 s), `glb_test` (GLB import, 6 s; add `&surface=1` for the text-body look).

### Reference-look toolkit (from `docs/REFERENCE_ANALYSIS.md`)
| Want | Use |
|---|---|
| Body made of text | `PointCloudCharacter.procedural(engine, { style: 'glyph' })` or `fromObject(engine, gltf.scene, { surface: true })` |
| Glowing head ring / sash | `hero.addRing({ bone: 'head', plane: 'xz', radius: 0.25 })` |
| Afterimages | `const ghosts = hero.addGhosts(5)`; `applyPose(ghosts[i], poseAt(t - (i + 1) * 0.085))`; tween `hero.ghostState.intensity` |
| Pond + reflections | `createPond(engine, { center, radius })` + `createGround({ holes: [...] })`; `addReflection(engine, points)`, `hero.addSurfaceReflection()` |
| Reeds / grass / pines | `createReeds({ patches })`, `createPines({ pines })` |
| Lanterns, pavilion, energy spire | `createLanterns()`, `createPavilion()`, `createBeam()` (cross flare included) |
| Text fonts | glyph sets `text`, `body`, `tile`, `lamp` (IBM Plex Mono, OFL, bundled via npm) |
| Smear glitch / green terminal phase | tween `engine.post.params.smear` / `.terminal` (`termColor`, `termCell`) |
| 4:5 picture in a 9:16 frame | `export const meta = { letterbox: 0.8 }` or `--letterbox 4:5` |

## Performance notes for integrated graphics
- Lower `--quality` first (particle counts scale with it; sprites grow to keep coverage).
- Particles are `THREE.Points`: one vertex each, one draw call per layer. Motion is in vertex shaders, so the CPU does no per-particle work per frame.
- Fill rate is the main cost on an iGPU. `maxPointPx` in `src/core/presets.js` caps defocused sprites, and depth of field (`engine.params.aperture`) is the costly effect.
- The character build is CPU work at load time (scales with `count`). Lower `count` in `PointCloudCharacter.procedural()` for faster previews.

## Known limitations
- The reference video is not in the repo (third-party content). Keep it in `ascii-engine/reference/` (git-ignored) for `tools/compare.mjs`.
- Measured only on SwiftShader (CPU). The Intel UHD numbers need a run on the laptop (the render log prints the renderer string).
- Procedural hands are mitten-like and fingers aren't articulated. Faces read at medium and close range but aren't portrait-grade.
- Only the depth-only occluder hides the back of a character. Very thin parts (fingers, ears) can show some back-side particles.
- GSAP is free under its "standard no-charge" licence, which is not OSI open source. Three.js is MIT.
