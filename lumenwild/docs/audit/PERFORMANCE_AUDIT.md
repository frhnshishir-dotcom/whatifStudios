# Performance audit (Phase 0)

## 1. Measurement environment and its limits

All numbers were measured during this audit on the current build (`c45c13b`): headless Chromium 1243 via Playwright,
**WebGL/2D on SwiftShader (CPU rasteriser), 4 cores**, cross-origin isolated (water in the worker), viewport
1440 x 900, seed 7. Methods: the engine's own frame stats plus in-page timers wrapped around each layer (runtime
instrumentation only, no source change), and Node timings from a temporary test file that was deleted afterwards.

**Not measured:** your Windows laptop (CPU, Intel UHD GPU, 8 GB RAM), CPU utilisation percentages, GPU usage. These
numbers are therefore a CPU-only reference, not laptop results. Phase 1 adds an in-app benchmark export so the laptop
can be measured the same way.

## 2. Frame cost (milliseconds per frame, averages)

| Scenario | Grid | fps | Projection + terrain | Objects | Dragon | Atmosphere | Particles | Overlay | Water prepare | Blit | putImageData | Cells redrawn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Day, default view | 126 x 60 | 60 | ~0.7 | 0.52 | 0.11 | 0.51 (+0.02) | 0.004 | 0.08 | 0.04 | 0.30 | 0.53 | 312 |
| Night, storm, fog | 126 x 60 | 60 | ~0.7 | 0.46 | 0.06 | 1.01 (+0.14) | 0.04 | 0.07 | 0.04 | 0.49 | 0.45 | 794 |
| Zoomed out, night storm | 225 x 103 | 60 | ~1.7 | 1.00 | 0.15 | **3.13** (+0.24) | 0.11 | 0.25 | 0.09 | 0.62 | 0.51 | 1,747 |
| Following the dragon (camera moves) | 126 x 60 | 60 | ~0.7 | 0.39 | 0.32 | 0.53 | 0.004 | 0.09 | 0.03 | **1.04** | 0.52 | 1,647 |

"Projection + terrain" is the compose total minus the layer timings. Particles in the storm: 968 (default zoom) and
2,252 (zoomed out). Objects in the world: 1,752.

Water runs in the worker at **0.9-1.0 ms per 60 Hz step** (6 % of one core).

## 3. One-off costs

| Operation | Cost | Where |
|---|---|---|
| Page ready (fonts, generation, first stats) | 625 ms after navigation | `src/main.tsx`, `boot.ts` |
| World generation | 217 ms (Node) | `gen/world.ts:33` |
| Full terrain shading (load, regenerate, load save) | 48 ms | `render/TerrainShader.ts` `update` |
| Save snapshot | 28 ms, 1.23 MB JSON | `Engine.ts:210` |
| Pose build (dragon, first use of a heading/frame) | 0.9 ms each, then cached | `dragon/DragonPoses.ts` |

## 4. Memory and download size

- JS heap: **34 MB used, 48 MB allocated** (Chromium `performance.memory`, after the scenarios above).
- World and water arrays: about 3.8 MB (World ~0.6 MB, terrain cache ~0.7 MB, water buffers ~2.5 MB).
- Download: JS 430 KB (146 KB gzip); `dist/` 3.3 MB in total, mostly font files (the Symbols 2 font is the largest).

## 5. Bottlenecks, ranked

1. **Atmosphere per-cell passes** (`env/Atmosphere.ts:223` light, fog, haze; `:175` grade): up to 3.1 ms at
   225 x 103. Grows with screen cells. Best fixed in a shader (WebGL2 presenter).
2. **CPU blit when the camera moves** (`render/Blitter.ts:18`): every cell redraws (1.0 ms at 126 x 60, scales with
   pixel count), plus `putImageData` (0.5 ms). Removed entirely by a GPU presenter.
3. **Projection loop with terrain lift** (`render/Composer.ts:55`): the mountain (≈74 m) raises the number of rows each
   column must scan. 0.7-1.7 ms. Can be bounded per column (precomputed column maxima).
4. **Object layer** (`objects/ObjectLayer.ts:48`): sorting and drawing visible sprites, up to 1.0 ms zoomed out.
5. **Hitches:** terrain shading 48 ms and snapshot 28 ms on the main thread; the 90 s autosave triggers the snapshot.
   Candidates for a worker or time slicing.
6. **Main-thread water on hosts without cross-origin isolation** (the claude.ai artifact): adds ~1 ms per step to the
   main thread, up to 6 steps per frame when catching up.

None of these limit the current 60 fps on this machine; they are the costs that will grow with a 3D renderer, more
entities and larger views.

## 6. Proposed budgets (to confirm on the laptop)

| Setting | Target | Main-thread CPU per frame | GPU per frame | Particles | Notes |
|---|---|---|---|---|---|
| LOW | 30 fps | ≤ 12 ms | ≤ 20 ms | ≤ 1,000 | 2.5D renderer, 75 % resolution, no haze (the existing low-performance mode) |
| MEDIUM | 60 fps | ≤ 6 ms | ≤ 10 ms | ≤ 2,500 | 2.5D renderer with GPU presenter and glow |
| HIGH | 60 fps | ≤ 6 ms | ≤ 12 ms | ≤ 4,000 | 3D view, one shadow map, bloom |

Server: ≤ 20 % of one core per active region at 60 Hz water + 20 Hz entities, to be measured with real entity counts.

## 7. Existing performance features

Low-performance mode (`Engine.setLowPerf`: 30 fps cap, 45 % particle density, no depth haze; the View panel also
drops resolution to 75 %); terrain cache per 16 x 16 chunk; unchanged-cell skipping in the blitter; active water
chunks only; pooled particles; cached sprites and poses; device pixel ratio capped at 2; dragon obstacle map rebuilt at
most twice a second while editing.
