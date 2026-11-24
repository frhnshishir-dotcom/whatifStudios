# ASCII / Point-Cloud Engine: audit and architecture

Phase 1 (audit) and Phase 2 (architecture) of the brief. Written before any engine code.

## 1. Audit (2026-11-24)

### Repository
- `whatifStudios` is a **Blender + Python** production repo (EP001 city shorts). There is no JavaScript, Node
  project, bundler or web code in it. Nothing 3D in the repo can be reused, because all of it is Blender
  (`.blend`, `bpy` scripts). The brief forbids Blender, so the engine is a new, self-contained folder: `ascii-engine/`.
- **Reusable:** `tools/pipeline/` is plain Python + Pillow with no Blender dependency. It validates a frame folder
  (`episodes/<cut>/frames/frame_####.png`), keeps a render manifest, assembles with FFmpeg without overwriting, and
  verifies the MP4 with ffprobe. It is driven by `configs/<cut>.json` (range, fps, size, `audio`). The engine writes
  frames and a config in exactly that convention, so `manifest.py`, `assemble_safe.py` and `verify_mp4.py` work
  unchanged. Audio stays `forbidden` (VO/music/SFX are added in CapCut).
- Repo rules that carry over: never overwrite frames, videos or existing files; one heavy render job at a time;
  inspect real rendered frames; never commit frame sequences (`episodes/*/frames/` is git-ignored); PNG/MP4 go through Git LFS.
- **No reference video was supplied.** It isn't in the message, the repo, or the session's upload folders. Every visual
  judgement below is made against the *written* style description. `tools/compare.mjs` is ready for a side-by-side
  check as soon as the video is added (see section 9).

### Tools
| Tool | Here (cloud container, Linux) | Owner's laptop (Windows, Intel UHD iGPU) |
|---|---|---|
| Node.js | 22.23, npm 10.9, npm registry reachable | install Node 20+ LTS |
| Three.js | 0.187.0 (MIT) installed | `npm install` |
| GSAP | 3.15.1 installed. Free under GSAP's "standard no-charge" licence, which is free to use but not OSI open source | same |
| Browser | Chromium 1243 via Playwright 1.63. WebGL 2 through **SwiftShader** (CPU rasteriser, 4 cores) | Edge or Chrome, already installed; WebGL 2 on the Intel GPU (ANGLE/D3D11) |
| FFmpeg | 6.1.1 with libx264 | Gyan build on the user PATH (see CLAUDE.md) |
| Python | 3.13, for `tools/pipeline` | already used |
| Blender | not used, not installed, not needed | not used |

SwiftShader is a useful worst case: it is slower than the laptop's iGPU, so frame times measured here are
an upper bound. The render tool prints the actual WebGL renderer string, so the laptop run shows whether
it got the GPU.

## 2. Technology choices

| Choice | Decision | Why |
|---|---|---|
| Renderer | **Three.js + WebGL 2**, vanilla ES modules | Mature, MIT, light. The scene graph and math are reused, and all the look comes from our own `ShaderMaterial`s. |
| React Three Fiber | **Not used** | No React app exists. R3F would add React, a bundler and a reconciler for no gain in a frame-by-frame offline renderer. |
| Bundler | **None.** An import map in `index.html` points at `node_modules` | No build step. The same page serves real-time preview and offline rendering. |
| Particles / glyphs | **`THREE.Points` with custom shaders** (one vertex per particle) | A glyph or stroke is a point sprite that samples a glyph atlas and is rotated in the fragment shader. That is 1 vertex per glyph instead of 4-6 for an instanced quad, and one draw call per layer. |
| ASCII on large surfaces | **Shader-based glyph surfaces** (world-space cell grid on meshes) | Facades and terrain get unlimited glyph density with correct perspective and zero vertex cost. They also write depth, so they occlude. |
| Post-processing | **Own minimal chain** (dual-filter bloom + one composite shader), not the `postprocessing` package | Every effect has to be deterministic per frame (grain and glitch seeded by frame number) and art-directable. Bloom, CA, scanlines, grain, block glitch, vignette, AgX tone map and grade fit in ~250 lines with no dependency. |
| Animation | **GSAP paused timeline**, seeked to `frame / fps` | Rich easing and composition, and fully deterministic because nothing reads a wall clock. Keys are written as explicit `fromTo` segments, so rendering can start at any frame. |
| Frame capture | **Playwright** (`playwright-core`) driving a real browser, `canvas.toDataURL('image/png')` per frame | Real WebGL output, no screen capture, and it works headless. On Windows it uses the installed Edge or Chrome, so there is no browser download. |
| Encoding | **FFmpeg** via the repo's `tools/pipeline/assemble_safe.py` (validated, never overwrites, verifies with ffprobe) | Reuse, not reinvention. A Node fallback (`tools/encode.mjs`) covers machines without Python. |
| Procedural textures | **HTML Canvas** glyph atlas built from a bitmap 5x7 font and vector marks | Identical glyphs on every OS (no system-font dependency), crisp at small sizes, and sorted by measured ink coverage to make luminance ramps. |
| Randomness | Seeded PRNG (mulberry32) on the CPU, integer hashes on the GPU | The same seed gives the same frame, every time. |

## 3. Module layout

```
ascii-engine/
  index.html                 host page: real-time preview UI, or render mode (?mode=render)
  src/
    main.js                  URL params -> Engine + scene; preview loop or window.__engine render API
    core/Engine.js           renderer, deterministic clock, shared uniforms, update hooks, renderFrame(n)
    core/presets.js          QUALITY (preview/draft/final/master) and FORMATS (9x16, 16x9, 1x1, HD variants)
    core/random.js           mulberry32, hash, helpers
    core/LightRig.js         up to 8 point lights + key light -> shared uniform arrays
    glyphs/GlyphAtlas.js     canvas atlas: bitmap font, strokes, geometric marks, coverage-sorted sets
    shaders/chunks.js        GLSL library: hash/noise, lighting, fog, flicker, glitch slicing, emergence, skinning
    shaders/ParticleMaterial.js   SYSTEM D: points, glyph points, strokes (defines switch features)
    shaders/GlyphSurfaceMaterial.js SYSTEM A: shader ASCII on meshes (triplanar cell grid, luminance ramp, AA)
    shaders/LineMaterial.js  luminous wireframe edges
    post/PostFX.js           bloom + composite (CA, block glitch, scanlines, grain, vignette, AgX, grade)
    characters/HumanSDF.js   SYSTEM B: procedural anatomy as smooth-union SDF + bone hierarchy
    characters/PointCloudCharacter.js  surface sampling (SDF or GLB), skin weights, feature clusters, halo, GPU skinning
    characters/poses.js      procedural walk / idle / reach cycles (pure functions of time)
    env/*.js                 SYSTEM C: Ground, Street, Building, Vegetation, Atmosphere, EnergySource, Structures
    anim/Timeline.js         SYSTEM E: GSAP wrapper, key() helper, shot list, glitch-cut transitions
    anim/CameraRig.js        spline paths, look-at targets, deterministic handheld noise, focus pulls
  scenes/prototype.js        Phase 3 test scene
  tools/serve.mjs            zero-dependency static server (preview)
  tools/render.mjs           SYSTEM F: deterministic frame renderer -> episodes/<cut>/frames, config, manifest, encode
  tools/encode.mjs           FFmpeg fallback encoder (no overwrite, ffprobe check)
  tools/compare.mjs          reference video vs render side-by-side sheets (needs the reference)
  docs/                      this file, VISUAL_QA.md (inspection log), README usage
```

## 4. Rendering model

**Everything is emissive, and accumulates in HDR.** The scene renders into a half-float target. Particles use additive
blending, so their order doesn't matter: no sorting, and deterministic. Dense regions sum to bright white-silver
cores, and bloom turns them into luminous clusters. Large surfaces are opaque near-black (charcoal) meshes with
emissive glyphs, and they write depth.

**Occlusion keeps characters readable.** A point cloud drawn additively shows its back through its front, and the
figure turns to mush. Each character has a depth-only proxy body (shrunk capsules on the same bones, `colorWrite:false`),
drawn first, so the far side's particles are hidden while the silhouette and front stay crisp.

**Lighting is computed per particle** in the vertex shader from a shared light rig (warm key + up to 8 coloured point
lights with smooth range falloff, wrap diffuse, and a rim term). The lit luminance selects the glyph from a
coverage-sorted ramp, so moving lights literally rewrite the ASCII. Crimson energy sources and amber lamps are entries
in the same rig, so every system picks them up.

**Depth cues** are depth-scaled sprite size (world-unit sizes, so it is resolution-independent), exponential distance
fade toward a charcoal haze, depth-of-field by circle-of-confusion growth of the point size with energy conservation
(defocused particles grow and dim), and glyph LOD (glyphs smaller than ~3 px fall back to coverage-weighted dots, so
there is no moiré).

## 5. The five systems

**A. ASCII renderer.** Two cooperating implementations share one atlas and the same ramps:
1. *Glyph points* (`ParticleMaterial` with `GLYPH`): surface-aware distribution (grid or random samples on mesh faces
   and edges), adjustable density (count) and symbol size (world units), per-set glyph palettes (architecture,
   vegetation, character, terrain, code), and luminance-driven glyph choice.
2. *Glyph surfaces* (`GlyphSurfaceMaterial`): a world-space cell grid on any mesh (triplanar), with cell size, set,
   facade window pattern, fragmentation (noise dropout), and derivative-based AA.

**B. Point-cloud character engine.** Input is either a procedural human (smooth-union SDF of 63 anatomical
primitives: 61 additive, 2 carving the eye sockets; on a 20-bone skeleton) or any skinned/static GLTF/GLB mesh. It samples surface positions uniformly by area,
with normals and skin weights. Extra *feature clusters* are sampled along anatomical curves (eyes, brows, nose, lips,
jaw, collarbones, sternum, ribs, knees, knuckles, spine) at higher brightness, plus hair strokes. GPU skinning runs in
the point vertex shader through a bone texture (the same code path for procedural and GLB). Rim brightening keeps the
silhouette, a halo is built from rings, ticks and dust, and glitch slicing, noise displacement, velocity smear,
flicker and emergence/dissolve are uniforms.

**C. Procedural environment.** Ground and terrain (heightfield, glyph surface, dust), street (lanes as dash glyphs,
curbs, lamps), buildings (stacked volumes, window grid, luminous edges, surface glyph points), vegetation (recursive
trees and shrubs as oriented stroke glyphs, teal leaf clusters, wind sway in the shader), atmosphere (drifting dust,
rising embers), energy sources (pulsing crimson cores, orbit streams, light-rig entries) and structures (arches, pylons,
cables). Every module takes a seed and returns `{ object3D, update(t), lights }`.

**D. Shader engine.** The reusable GLSL chunks cover: hash/value noise, lighting, fog, flicker, glitch slicing,
emergence, sway, drift and skinning. Material factories enable features with `#define`s, so each draw compiles only
what it uses. The post composite does controlled RGB displacement, block fragmentation, scanlines, grain, vignette,
tone map and grade.

**E. Animation engine.** A paused GSAP timeline is seeked to `t = (frame - 1) / fps`. It covers spline camera
moves, slow tracking, focus pulls, handheld noise as a function of `t`, glitch-cut transitions (post and particle
slicing tweened together), light pulses, character locomotion (walk phase tied to the distance travelled, so feet
don't skate), environment sway and drift, and particle emergence and disappearance.

## 6. Video pipeline (deterministic)
1. `node tools/render.mjs --scene prototype --format 9x16 --quality final --cut <name>` starts the static server, a
   browser (headless by default, or `--headed`; `--channel msedge|chrome` uses the installed browser), and loads
   `index.html?mode=render&...`.
2. It writes `configs/<cut>.json` (refuses to change an existing one) and runs `tools/pipeline/manifest.py start`.
3. For each frame it calls `__engine.renderFrameRaw(n)`, which sets the time, updates, renders and returns the raw
   `readPixels` RGBA. Node encodes an **RGB** PNG (`tools/png.mjs`; the browser's own encoder always writes RGBA, which
   the repo validator rejects) while the browser already renders the next frame. The
   frame is written to `episodes/<cut>/frames/frame_####.png` atomically. Existing frames are **skipped** (resume
   after a crash), never overwritten. Per-frame times go to `logs/render_<time>.json`.
4. `--encode` runs `tools/pipeline/assemble_safe.py` (validates every frame, encodes H.264 yuv420p at the config fps,
   never overwrites, verifies with ffprobe).
5. `--still --frames 1,90,180` renders inspection stills to `episodes/<cut>/previews/` (never overwrites; adds `_v2`...).

Formats: 9:16 (720x1280, or 1080x1920 for `-hd`), 16:9 (1280x720 / 1920x1080), 1:1. The fps is configurable (24/25/30/60).

## 7. Presets and performance (integrated graphics, limited RAM)
| Preset | Use | Particle density | Supersample | Bloom mips |
|---|---|---|---|---|
| `preview` | real-time in the browser | 0.35 | 0.6x resolution | 4 |
| `draft` | quick frame checks | 0.65 | 1.0 | 5 |
| `final` | delivery | 1.0 | 1.0 | 6 |
| `master` | best quality, slower | 1.0 | 1.5x (downsampled in composite) | 6 |

Rules: one `Points` draw per layer (about 12-20 draws for a whole scene, plus about 14 small post passes). No per-frame
CPU particle work, since all motion happens in vertex shaders and only bone matrices are uploaded. Particle buffers are
built once (`Float32Array`, about 40 bytes per particle; 250k particles is about 10 MB). Geometry and atlas are shared.
Point size is capped so defocused sprites can't blow up the fill rate. Lower presets scale the particle counts and
enlarge points to keep the same coverage.

## 8. Determinism
No `performance.now()`/`Math.random()` in anything that renders. The time comes from the frame number, the CPU uses a
seeded PRNG, and the GPU hashes are seeded per particle. Grain and glitch use the frame index. Identical inputs give
identical frames on the same machine and browser (verified by rendering a frame twice and hashing it). A different GPU
or driver can differ by rounding, which is not visible.

## 9. Reference comparison (blocked on the video)
When the reference video is added (e.g. `ascii-engine/reference/<name>.mp4`, which goes through Git LFS), run
`node tools/compare.mjs --ref <video> --cut <cut>`. It extracts matching stills and builds side-by-side and contact sheets
for the Phase 4 checklist (character readability, particle density, ASCII pattern quality, environment detail, lighting,
colour balance, depth).
