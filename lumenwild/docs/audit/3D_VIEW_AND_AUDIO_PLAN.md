# 3D view and audio: architecture and migration plan (for approval)

Status: **proposal, nothing built.** It follows the approved decisions in `LUMENWILD_ROADMAP.md`: Three.js for the 3D
view, Blender optional for assets, 2.5D stays the default until the parity gates pass, hybrid audio, 8 GB RAM and
Intel integrated graphics first, zero cost.

## Part 1: the 3D view

### 1.1 Principle
The 3D view is a **second view of the same simulation**, not a rewrite. World, water, objects, environment, dragon,
editor and persistence stay exactly as they are; the 3D view only reads them, like the 2.5D composer does today. The
2.5D view (composer + presenter) is untouched and guarded by the golden images.

```
                 ┌─────────────── simulation (unchanged) ───────────────┐
                 │ World · WaterSim/WaterView · ObjectStore · Environment │
                 │ Particles · Dragon · Editor/History · Persistence     │
                 └───────────────┬───────────────────────┬───────────────┘
                                 │ reads                 │ reads
                    ┌────────────▼──────────┐  ┌─────────▼────────────────────┐
                    │ View2D (today)        │  │ View3D (new, lazy-loaded)     │
                    │ Composer → CellBuffer │  │ Three.js scene from the same  │
                    │ → Canvas2D / WebGL2   │  │ data; glyph surface material  │
                    │   presenter           │  │ ray picking; bloom; shadows   │
                    └───────────────────────┘  └──────────────────────────────┘
```

### 1.2 Engine change (small, step 3D.0)
`Engine` gets a `View` interface with two implementations: `View2D` (wraps the existing composer and presenter; no
behaviour change) and `View3D`. `Engine.frame` keeps stepping the simulation, then calls `view.render()`. Picking
(`pickAt`, `cellKind`) and the dragon screen position go through the view. Selected with View → "Display: 2.5D / 3D"
and `?view=3d`. Switching keeps the world and camera target.

### 1.3 View3D modules (`src/render3d/`)

| Module | What it does | Reads |
|---|---|---|
| `View3D.ts` | Three.js `WebGLRenderer`, scene, render order, resize, resolution scale, dispose | Engine |
| `CameraRig3D.ts` | Perspective three-quarter camera: target, distance, yaw, pitch; pan, zoom, orbit (mouse, touch); dragon follow | input |
| `TerrainMesh.ts` | Heightfield in 16 x 16-cell chunks (the existing chunk unit); only dirty chunks are rebuilt after an edit; merged into larger draw groups for few draw calls | `World.elev`, chunk dirty flags |
| `GlyphSurfaceMaterial.ts` | Shader that draws **glyphs fixed to surfaces** (world-space glyph grid: tops by world x/y, cliffs by tri-planar projection), so glyphs do not crawl when the camera moves. Glyph, foreground and background per cell come from the **existing `TerrainShader` caches** (uploaded as 256 x 256 data textures), so the 3D view keeps the current art direction and palettes. Distant cells fade to their average coverage colour to avoid shimmer | `TerrainShader` caches, `GlyphAtlas` |
| `WaterMesh.ts` | Water surface displaced by depth and ripples (uploaded per active chunk), flow stripes, foam; waterfalls as vertical ribbons at fall cells; reflections of the sky and emissive lights (screen-space, MEDIUM and up) | `WaterView` |
| `ObjectInstances.ts` | One instanced mesh per object kind and variant (trees, rocks, stones, mushrooms, bridge, cottage, mill with turning wheel, cave, Christmas tree), built procedurally in code; glyph material per kind; selection highlight. Blender-made GLB models can replace a kind later behind the same interface (optional) | `ObjectStore` |
| `DragonMesh.ts` | Segmented mesh built from the anatomical model already in `DragonPoses.ts` (body, neck, head, tail chain, wing bones and membranes), animated by the same wing phase and mode | `Dragon` |
| `Particles3D.ts` | One `Points` draw from the existing particle arrays | `Particles` |
| `Lighting3D.ts` | Sun/moon direction and colour from `Environment`, ambient, the nearest point lights from object `LightSpec`s (capped), emissive glow, one shadow map (MEDIUM and up) | `Environment`, `ObjectStore` |
| `Post3D.ts` | Fog by distance, selective bloom from emissive surfaces only (half resolution), tone mapping | |
| `Picking3D.ts` | Screen ray marched through the heightfield grid: returns the same world cell index as the 2.5D picking | `World` |
| `EditorDecal3D.ts` | Brush ring and hover cell drawn on the terrain in the shader; all editor tools reuse the existing `Editor` | `Editor` |

### 1.4 Dependencies and cost
- `three`, pinned to **0.187.0** (the version `ascii-engine/` already uses; MIT licence, free). Loaded with a dynamic
  `import()` only when the 3D view is opened, so the 2.5D app's download does not grow (about 150 KB gzip extra for
  3D users). No other new runtime dependencies.
- Procedural meshes first: no asset files needed. Blender models are optional later additions.

### 1.5 Budgets for 8 GB RAM and Intel integrated graphics (estimates, verified by the benchmark at each step)

| Item | Estimate |
|---|---|
| Terrain geometry | 256 chunks x 289 vertices: about 2.5 MB |
| Data textures | glyph/fg/bg caches 0.6 MB; water depth and ripple 0.3 MB; glyph atlas with mipmaps about 0.5 MB |
| Shadow map | 1024 x 1024 depth: 4 MB (MEDIUM), off on LOW |
| Bloom targets | half resolution at 1280 x 720: about 4 MB |
| GPU memory total | under 64 MB (gate: ≤ 512 MB) |
| JS heap | under 120 MB (gate: ≤ 400 MB) |
| Draw calls | terrain groups ≤ 16, objects ≤ 16, water ≤ 8, dragon, particles, post: about 50 |
| Quality tiers | LOW: no shadows, no bloom, 75 % resolution, 1 glyph per cell; MEDIUM: shadows, bloom; HIGH: reflections, finer glyph grid near the camera |

The benchmark (Inspector → Benchmark) gets a 3D column at step 3D.1, so every step is measured on your laptop.

### 1.6 Migration steps (each additive, each with acceptance tests; 2.5D goldens must stay identical throughout)

| Step | Delivers | Acceptance tests |
|---|---|---|
| 3D.0 | `View` interface, `View2D` wrapper, `?view=3d` flag, `three` as a lazy chunk | All existing tests and goldens unchanged; main bundle size unchanged (±1 %); Three.js only in a separate chunk |
| 3D.1 | Terrain with glyph surfaces, camera rig, ray picking, edits update chunks | Picking agrees with 2.5D for ≥ 99 % of 1,000 random terrain points; an edit updates the mesh in the same frame; glyph stability metric under a 0.1-cell pan; side-by-side frames for your review; benchmark numbers |
| 3D.2 | Water surface, falls, ripples, rain rings | No water drawn where depth is 0 (sampled); a disturbance changes the surface within 3 frames; every generated fall is visible |
| 3D.3 | All object kinds, instanced; selection | Every object in the store is drawn at its position (count and position check); select/move tool works in 3D |
| 3D.4 | Lighting, shadows, emissive glow, fog, bloom, weather particles | Glyph contrast ≥ 3:1 in all presets; day/dusk/night/rain/fog/storm frames reviewed by you; budget check |
| 3D.5 | Dragon mesh and animation, follow camera | Drawn position within 0.5 cell of the simulation; all modes and wing frames shown |
| 3D.6 | All 18 editor tools in 3D with brush preview; undo/redo | The editor browser tests re-run in 3D mode pass |
| 3D.7 | Parity review against the gates in `LUMENWILD_ROADMAP.md` on your laptop | All gates pass; you decide whether 3D becomes the default |

### 1.7 Risks
| Risk | Mitigation |
|---|---|
| Glyph shimmer at distance in perspective | Mipmapped atlas plus fade to average coverage colour by distance; stability metric in tests |
| iGPU too slow at full resolution | Quality tiers, resolution scale, benchmark at every step; 2.5D remains available |
| 3D editing less precise than the grid | Ray picking against the same grid; hover cell highlight; 2.5D editor stays available |
| Scope creep | Steps are small and gated; nothing in the simulation changes |

## Part 2: audio

### 2.1 Architecture (`src/audio/`)
```
 simulation events ──► SoundEvents (typed: name, world x/y, volume) ──► AudioEngine
 environment state ──► Ambience (procedural, continuous)            ──►   buses: ambience · effects · creatures · music · ui
                                                                         └► master gain ► destination
```
- **AudioEngine:** one `AudioContext`, created on the first user gesture (browser autoplay rules), master and five
  buses with volume and mute in the settings; voice limit (16) and per-sound cooldowns; suspended when the tab is hidden.
- **Procedural layer (Web Audio, no files):** wind (filtered noise following the gusts), rain (density following
  rain), river and waterfalls (band-passed noise, louder near water and falls in view), night insects, UI clicks,
  dragon wing beats and splashes. The dragon already emits sound events (`dragon/DragonInteractions.ts`, `SoundHook`);
  they are wired, not rewritten.
- **Sample layer (files):** `public/audio/<category>/`, Ogg Opus (small) with an MP3 fallback for Safari, loaded on
  demand, decoded once. Every file is listed in `public/audio/LICENSES.md` (source, author, licence, link). Only
  original recordings or CC0 / clearly licensed free sources. Budget: ≤ 5 MB downloaded, ≤ 50 MB decoded.
- **Spatial:** stereo pan and distance gain from the camera centre (2.5D); Web Audio panner (equal-power, cheap) in 3D.
- **Cost:** audio runs on the browser's audio thread; main-thread work under 0.2 ms per frame.

### 2.2 Steps and tests
| Step | Delivers | Tests |
|---|---|---|
| A.1 | AudioEngine, buses, settings (volume, mute), top-bar sound toggle; procedural wind, rain, water | Unit tests with a fake `AudioContext` (routing, voice limit, cooldowns); browser test: context runs after a click, rain gain rises with rain, 1 s rendered with `OfflineAudioContext` is not silent, muting silences it |
| A.2 | Dragon wing beats, splashes, landing; UI sounds | Events from the dragon test world reach the engine with the right volume and position |
| A.3 | Sample loader and licence manifest; first licensed set (birds, footsteps, creature calls) | Every file in `public/audio` appears in `LICENSES.md` (test fails otherwise); missing files degrade to silence, not errors |
| A.4 | Music (calm day, night, discovery), cross-fades by time of day and events | Cross-fade timing test; no clipping (peak check on rendered output) |

## Decisions needed from you
1. Approve the 3D architecture above (Three.js 0.187.0 lazy-loaded, procedural meshes first, Blender models optional later).
2. Glyph density on 3D surfaces: one glyph per world cell (matches 2.5D, recommended default) or finer near the camera
   (closer to the reference roofs; costs more).
3. Audio files: your own recordings, CC0 libraries, or both? (No paid packs without approval.) Sound on or off by default?
4. Order: (a) finish the remaining 2.5D steps 1.4-1.7 first, (b) start 3D.0-3D.1, or (c) audio A.1 first. Recommended:
   run the benchmark on your laptop now, then 1.4-1.7, then 3D.0-3D.1, with A.1 alongside (it is small and independent).
