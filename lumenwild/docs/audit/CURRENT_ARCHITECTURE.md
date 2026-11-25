# Lumenwild: current architecture (Phase 0 audit)

Audited at commit `c45c13b`, branch `claude/ascii-pointcloud-engine-fz3w62`, repository `whatifStudios`.
Nothing in `src/` was changed during this audit. Every claim below points to a source location or to a test that was
run during the audit (100 unit tests and 32 browser tests passed; see `PERFORMANCE_AUDIT.md` for the measurements).

## 1. Source availability (answers the "missing source" question)

The original TypeScript source is **present and complete** in `lumenwild/`. The "production build" that was
inspected is the bundle published at `claude.ai/artifact/3puvP5BPs2MKEKk6bNkCC2`, built from this source with
`vite build --base ./`. Corrections to the list of "missing or unverified systems":

| Item | Actual state | Evidence |
|---|---|---|
| Original development source | Present: 47 source files, 6,976 lines of TypeScript/TSX | `lumenwild/src/` |
| Package configuration | Present | `lumenwild/package.json`, `vite.config.ts`, `tsconfig.json`, `playwright.config.ts` |
| WebGL2 / GLSL / Three.js in Lumenwild | **Not used.** Lumenwild renders with Canvas 2D on the CPU, by design: the original Lumenwild brief said "Do not use Three.js" | `src/engine/render/Renderer.ts:24` (`getContext('2d')`); no `webgl` string in `src/` |
| WebGL2 / GLSL / Three.js elsewhere in the repo | **Present** in the sibling project `ascii-engine/` (Three.js 0.187, custom GLSL glyph-surface, particle and bloom shaders), an offline renderer built against the same reference reel | `ascii-engine/src/shaders/`, `ascii-engine/docs/ARCHITECTURE.md` |
| Autonomous dragon AI | **Present** (it is in the production bundle too, minified): 15 source files, 2,012 lines | `src/engine/dragon/`, `tests/dragon.test.ts`, `e2e/m7-dragon.spec.ts` |
| Wildlife AI | Absent | no creature code apart from the dragon |
| Multiplayer networking, server-side simulation, shared persistent world | Absent | no `WebSocket`, `fetch` to a backend, or server code anywhere in `lumenwild/` |

## 2. Repository context

- `whatifStudios` is mainly a **Blender + Python video production repo** (EP001 city shorts). Its `CLAUDE.md` governs
  that workflow (Blender MCP renders, CapCut audio, "never add, generate or claim audio"). Lumenwild is a separate,
  self-contained web app in `lumenwild/`. The audio rule and the Blender rules were written for the video pipeline;
  see `LUMENWILD_ROADMAP.md` for the decisions this creates.
- `ascii-engine/` (4,116 lines of JS) is an earlier **offline** Three.js ASCII renderer that outputs MP4s
  (~800 ms per frame on SwiftShader for 100k+ particles; preview 6-8 fps). It is not a real-time game renderer, but its
  shaders and techniques are directly relevant to a WebGL2 upgrade (see `VISUAL_RENDERING_AUDIT.md`).

## 3. Technology stack (actual)

| Layer | Technology | Version | Location |
|---|---|---|---|
| Language | TypeScript (strict) | 5.9.3 | `tsconfig.json` |
| UI | React + Zustand (UI state only) | 19.3.1 / 5.1 | `src/ui/` |
| Build / dev server | Vite (COOP/COEP headers for `SharedArrayBuffer`) | 8.3.8 | `vite.config.ts` |
| Rendering | Canvas 2D, one `putImageData` per frame, CPU glyph compositor | browser API | `src/engine/render/` |
| Threads | One Web Worker (water) over `SharedArrayBuffer`, main-thread fallback | browser API | `src/engine/water/water.worker.ts` |
| Persistence | IndexedDB, then localStorage, then memory | browser API | `src/persist/storage.ts` |
| Fonts | Noto Sans Mono, Noto Sans Symbols 2, DejaVu Sans Mono (OFL, bundled) | fontsource 5.3 | `src/main.tsx`, `src/engine/render/glyphs.ts` |
| Unit tests | Vitest, `environment: 'node'` | 5.1.1 | `tests/` (9 files, 100 tests) |
| Browser tests | Playwright on Chromium (SwiftShader) | 1.63 | `e2e/` (7 specs, 32 tests) |
| Backend | none | | |

Runtime dependencies: `react`, `react-dom`, `zustand` and three font packages. No graphics or networking libraries.

## 4. Directory map

```
lumenwild/
  src/
    main.tsx                 boot: fonts, URL params (seed, scene, worker), engine, React root, test hook window.__lumenwild
    boot.ts                  createEngine(): world generation, water system, dragon, home view
    engine/                  framework-free simulation and rendering (no React)
      core/      155 lines   rng (mulberry32, hash2), noise (value, fbm, ridged), color, math
      world/     210         World grid (typed arrays, 16x16 chunk dirty flags), materials, Camera, Clock
      render/  1,003         glyph registry, GlyphAtlas, TerrainShader, Composer, CellBuffer, Blitter, Renderer, Particles, minimap
      water/     691         WaterSim (virtual pipes + ripple wave equation), worker, WaterSystem facade, WaterLayer
      gen/       730         world generator (river, falls, lake, mountain, structures, forest), terrain, test scenes
      objects/   717         object kinds and sprites, ObjectStore, ObjectLayer
      edit/      837         Editor (18 tools), History (undo/redo), EditorOverlay
      env/       444         Environment (time, weather, light colour), Atmosphere (particles, sway, light, fog, grade)
      dragon/  2,012         the autonomous dragon subsystem (14 modules)
      Engine.ts  550         frame loop, layer stack, input, save/load/regenerate, dragon follow camera
    persist/     332         save format v1 + validation, SlotStore (IndexedDB)
    ui/        1,034         React app, panels, toolbar, world dialog, dragon panel, persistence controller
  tests/       1,550         unit tests (Node)
  e2e/           762         browser tests (Playwright)
  docs/                      CHANGELOG, VISUAL_AUDIT (phase A), screenshots, this audit
```

## 5. Runtime architecture

```
                 main thread                                                   water worker (optional)
  ┌──────────────────────────────────────────────────────────────┐        ┌─────────────────────────┐
  │ React UI (store.ts) ⇄ editorBridge / persistence (WorldIO)   │        │ WaterSim.step @ 60 Hz    │
  │            │                                                  │        │ command queue            │
  │ Engine.frame (rAF) ──────────────────────────────────────────┐│  SAB   │ reads World.elev/solid   │
  │  1 Clock.advance → fixed 60 Hz sims: WaterSystem (main mode), ││◀──────▶│ writes depth/vel/ripple/ │
  │    Dragon.step                                               ││        │ fall (SharedArrayBuffer) │
  │  2 Editor.tick, follow camera                                ││        └─────────────────────────┘
  │  3 Composer.compose → CellBuffer (glyph, fg, bg, depth, pick, │
  │    light, kind per screen cell)                              │
  │       TerrainShader (cached per 16x16 chunk) + oblique        │
  │       projection; layers: Water → Objects → Particles →       │
  │       Dragon → Atmosphere → EditorOverlay                     │
  │  4 Renderer.draw → Blitter (glyph masks → Uint32 pixels) →    │
  │    putImageData                                               │
  └──────────────────────────────────────────────────────────────┘
```

Layer order is set in `src/engine/Engine.ts:122` (objects, particles, atmosphere, overlay), `:311` (water is
inserted first) and `:290` (dragon is inserted before the atmosphere so it receives light and fog).

## 6. System inventory

| System | Files | Purpose and implementation | Status and evidence | Problems | Opportunities |
|---|---|---|---|---|---|
| World data | `world/World.ts:16`, `world/materials.ts` | 256 x 256 grid of typed arrays: `elev` (Float32), `mat`, `cover`, `coverVar`, `moisture`, `magic`, `solid` (Uint8); 16 x 16 chunk dirty flags; optional `SharedArrayBuffer` allocation | Works; `tests/render.test.ts`, `tests/world.test.ts` | Fixed size, one region, everything in memory | It is the natural shared state for a server and for any second renderer |
| Camera | `world/Camera.ts:11` | Oblique 2.5D: row = y − round(h × heightScale); 14 zoom steps (5-28 px cells), pan, zoom at cursor, `maxLift`, elevation-aware `focus` | Works; `e2e/m1-render-camera.spec.ts` | Fixed direction (no rotation), not a perspective camera | Rotation and perspective need a real 3D renderer |
| Clock | `world/Clock.ts:5` | Fixed 60 Hz steps, pause, speed, catch-up cap | Works; `tests/core.test.ts` | | Same clock model can drive a server tick |
| Glyphs | `render/glyphs.ts`, `render/GlyphAtlas.ts:33` | ~300 curated glyphs in three modes (font baseline, centred symbol, procedural pixel-exact blocks/lines); masks baked once per cell size with `fillText` | Works; `tests/render.test.ts` (registry and procedural coverage) | CPU-only masks | The same atlas can be uploaded as a WebGL texture array |
| Terrain shading | `render/TerrainShader.ts:157` | Per cell: hillshade × AO, material gradients with soft borders, clumped glyph families, swathes and moisture tints; cliff faces; cached per chunk | Works; `tests/shading.test.ts` | Full rebuild 48 ms (load, regenerate) | Move rebuilds to a worker or time-slice them |
| Projection and composition | `render/Composer.ts:55`, `render/CellBuffer.ts` | Column-by-column painter's projection into a `CellBuffer`; layer hooks (`prepare`, `surfaceHeight`, `drawSurface`, `drawFace`, `after`) | Works | CPU cost grows with columns × (rows + terrain lift) | `CellBuffer` is a clean seam for a GPU presenter |
| Blitting | `render/Blitter.ts:18`, `render/Renderer.ts:56` | Coverage-mask blend per pixel into one `Uint32Array`, unchanged cells skipped, sub-cell offset, one `putImageData` | Works | Full redraw whenever the camera moves (1.0 ms) plus 0.5 ms upload | First candidate for WebGL2 |
| Water | `water/WaterSim.ts:236`, `water/water.worker.ts:30`, `water/WaterSystem.ts`, `water/WaterLayer.ts:88` | Virtual-pipes shallow water (exact mass conservation, sources, drains, open edges), damped wave-equation ripples, waterfall detection, active 16 x 16 chunks; worker on `SharedArrayBuffer` with a main-thread fallback; rendering by depth gradient, flow stripes, rings, foam, animated falls, splash and mist | Works; `tests/water.test.ts` (12), `e2e/m2-water.spec.ts`; bit-identical across two runs (audit) | Fixed grid; no reflections | Deterministic core: usable for server authority plus client prediction |
| World generation | `gen/world.ts:33`, `gen/terrain.ts` | Seeded river spline, bed profile with three falls, terrain relative to the river, lake, mill race, ponds, mountain with cave (`:160`), materials, bridge, cottage, mill, Christmas tree, glade, forest, rocks | Works; `tests/world.test.ts` (deterministic, landmarks on 8 seeds, flow over the falls) | One biome, one region, 217 ms in Node | Region and biome parameters |
| Objects | `objects/defs.ts:367`, `objects/ObjectStore.ts:8`, `objects/ObjectLayer.ts:48` | 8 kinds (tree ×6 variants, rock, stone, mushroom, bridge, cottage, mill, cave) as cached glyph sprites; occupancy grid, chunk buckets, solid mask for water; sway, glow, window, wheel and twinkle animation | Works; `tests/world.test.ts` (object store) | Sprites are 2.5D character art; no meshes | Each kind needs a 3D representation for a 3D renderer |
| Particles | `render/Particles.ts:56` | Pooled typed arrays, cap 4,000: splash, mist, leaf, floating leaf, firefly, rain, pollen, spark | Works; `tests/env.test.ts` | Visual only (rain adds no water) | GPU particles in a 3D path |
| Environment | `env/Environment.ts:32`, `env/Atmosphere.ts` | Day-night cycle, smoothed weather targets, ambient colour, gusts; Atmosphere spawns weather particles, sways grass (`:203`), applies ambient and point lights, emissive cells, fog and depth haze (`:223`), colour grade (`:175`) | Works; `tests/env.test.ts`, `e2e/m5-environment.spec.ts` | Per-frame CPU passes over every cell (up to 3.1 ms) | Move to a shader |
| Editor | `edit/Editor.ts:99`, `edit/History.ts:16`, `edit/EditorOverlay.ts` | 18 tools (terrain, water, plants, rocks, structures, eraser, ripple, select/move); strokes recorded as terrain patches and object commands; undo/redo | Works; `tests/editor.test.ts` (17), `e2e/m4-editor.spec.ts` | Validation is mixed with stroke handling; single user | Split validation out for server-side checking |
| Dragon | `dragon/*` (see `LIVING_WORLD_AUDIT.md`) | Autonomous needs, personality, memory, 15-state machine, utility AI, flight physics, steering, lair, interactions, cached character poses | Works; `tests/dragon.test.ts` (13), `e2e/m7-dragon.spec.ts` | One bespoke creature, client-side only | Seed of an entity system |
| Persistence | `persist/format.ts:10,135`, `persist/storage.ts:83`, `ui/persistence.ts:11` | Format `lumenwild-world` v1 (grids as base64, objects, springs, weather, camera, optional dragon), full validation; slots in IndexedDB with thumbnails, localStorage then memory fallback; autosave every 90 s (`ui/persistence.ts:23`); JSON export/import | Works; `tests/persist.test.ts`, `e2e/m6-persistence.spec.ts` | Local only; 1.2 MB JSON snapshot, 28 ms to build | The format can become the server's region snapshot |
| UI | `ui/App.tsx`, `ui/components/*`, `ui/store.ts` | Top bar, toolbar, inspector (tool, selection, environment, dragon, cell, view), bottom bar with perf readout, worlds dialog, phone drawer, touch gestures | Works; e2e suites | Editor-oriented UI, no game HUD | |
| Audio | `dragon/DragonInteractions.ts` (sound hook only) | No audio is produced | n/a | | See roadmap decision |
| Networking / backend | none | | | | Everything in `MULTIPLAYER_ARCHITECTURE.md` |

## 7. What runs where

- **Headless-capable (no DOM):** `core/`, `world/`, `water/WaterSim`, `gen/`, `objects/ObjectStore` and `defs`,
  `edit/Editor`, `env/Environment`, `dragon/` (except `DragonRenderer`, which only writes a `CellBuffer`), `persist/format`.
  Proof: the unit tests import these modules and run them under `environment: 'node'`.
- **Browser-only:** `render/Renderer.ts` and `render/GlyphAtlas.ts` (canvas), input binding in `Engine.ts:422`,
  `water/WaterSystem` worker mode, `persist/storage` (IndexedDB), `ui/`.
- **Cross-origin isolation:** with `vite dev`/`preview` the page is cross-origin isolated and water runs in the
  worker. On the claude.ai artifact host it is not, so water runs on the main thread (measured during earlier phone
  tests: `simMode: main`).

## 8. Build, test and configuration

- `npm run dev` (port 5180), `npm run build` (`tsc -b && vite build`, 430 KB JS / 146 KB gzip, 3.3 MB `dist/` with fonts),
  `npm run preview` (4180), `npm test` (Vitest), `npm run e2e` (Playwright, `--trace off`).
- URL parameters: `seed`, `scene` (`world`, `watertest`, `terrain`), `worker=0`.
- Test hook: `window.__lumenwild` (`getEngine`, `useUI`, `minimap`) used by the browser tests.
- No game configuration files: tuning lives in code constants (`dragon/DragonConfig.ts`, `water/WaterSim.ts`
  `DEFAULT_WATER`, `render/TerrainShader.ts` palettes, `env/Environment.ts` presets).

## 9. Feature inventory with evidence

| Feature | Source | Automated evidence |
|---|---|---|
| Character rendering with real glyphs | `render/GlyphAtlas.ts`, `render/Blitter.ts` | `tests/render.test.ts`; `e2e/m1-render-camera.spec.ts` |
| Pan, zoom, hover, touch | `Engine.ts:422` | `e2e/m1-render-camera.spec.ts` |
| Water flow, falls, ripples, conservation | `water/` | `tests/water.test.ts`; `e2e/m2-water.spec.ts` |
| Seeded world with river, falls, lake, mountain, cave, structures | `gen/world.ts` | `tests/world.test.ts`; `e2e/m3-world.spec.ts` |
| 18 editor tools, undo/redo | `edit/` | `tests/editor.test.ts`; `e2e/m4-editor.spec.ts` |
| Day-night, weather, wind, fog, lights | `env/` | `tests/env.test.ts`; `e2e/m5-environment.spec.ts` |
| Save slots, autosave, import/export, validation | `persist/`, `ui/persistence.ts` | `tests/persist.test.ts`; `e2e/m6-persistence.spec.ts` |
| Autonomous dragon with lair, save/load | `dragon/` | `tests/dragon.test.ts`; `e2e/m7-dragon.spec.ts` |
| Terrain shading quality rules | `render/TerrainShader.ts` | `tests/shading.test.ts` |
| Low-performance mode | `Engine.ts` `setLowPerf` | `e2e/m6-persistence.spec.ts` (30 fps cap) |
