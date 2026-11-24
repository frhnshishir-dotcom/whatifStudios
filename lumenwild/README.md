# Lumenwild

An interactive fantasy nature simulator rendered entirely in full-colour ASCII and Unicode characters.
TypeScript + React + Vite + Canvas 2D, CPU-first, no backend.

## Run

```bash
cd lumenwild
npm install
npm run dev          # http://localhost:5180
npm run build && npm run preview   # production build at http://localhost:4180
npm test             # unit tests (Vitest)
npm run e2e          # browser tests (Playwright; first time on a new machine: npx playwright install chromium)
```

Needs Node 20.19+ or 22.12+.

## Controls

| Input | Action |
|---|---|
| Middle drag, Space + drag, right drag | Pan |
| Mouse wheel | Zoom (anchored at the cursor) |
| Arrow keys | Pan |
| Space (tap) | Pause / resume simulation |
| Ripple tool (R), click or drag on water | Ripples |
| H | Hide / show all panels |
| F | Fullscreen |

## Architecture

```
src/engine/            framework-free engine (no React)
  core/                rng (seeded), noise (value/fbm/ridged), color (packed RGBA, gradients), math
  world/               World grid (typed arrays, 16x16 chunks with dirty flags), materials, Camera, Clock (fixed step)
  render/              glyphs (curated registry), GlyphAtlas (baked masks), TerrainShader (cached terrain look),
                       Composer (oblique projection, painter per column), CellBuffer, Blitter (masks -> pixels), Renderer
  water/               WaterSim (virtual pipes + ripple wave equation), water.worker (shared-memory stepping),
                       WaterSystem (worker or main-thread facade), WaterLayer (water/waterfall rendering, splashes)
  gen/                 procedural generation (terrain, water seeding, deterministic test scenes)
  Engine.ts            frame loop, simulations at a fixed step, input (pan/zoom/hover/pause)
src/ui/                React UI (Zustand store for UI state only; the engine is reached through engineRef)
tests/                 Vitest unit tests
e2e/                   Playwright browser tests (run against `vite preview`)
```

### Rendering
- **Glyph atlas:** every glyph in `render/glyphs.ts` is rasterised once per zoom level into a cell-sized 8-bit mask.
  Font glyphs (bundled Noto Sans Mono and Noto Sans Symbols 2, OFL) are fitted and centred, so fallback fonts can
  never break the grid. Block, shade and line characters (`░▒▓█▄▀▖▗▘▝│┃║╎╏─═`) and `｡` are drawn procedurally, pixel-exact.
- **Cells:** each screen cell has a glyph, foreground and background RGB, depth, pick (world cell), material,
  elevation, light and animation state. The blitter blends glyph masks into one `ImageData` (one `putImageData` per
  frame) and skips cells that did not change.
- **Projection:** an oblique 2.5D view. A world cell at elevation `h` is drawn `round(h * relief)` rows higher; each
  column is painted back to front, and each cell draws its top and then its cliff face down to the next cell's
  surface. Nearer terrain occludes farther terrain, and cliffs (and later waterfalls) have real vertical faces.
- **Terrain look:** the background colour is the land (material gradient × hillshade × ambient occlusion × elevation tint)
  and glyphs are texture at a per-material contrast. Glyph variation is deterministic per cell (no flicker). Results are
  cached per chunk and rebuilt only where the terrain changed.

### Water
- **Flow:** virtual-pipes shallow water. Per cell: depth and four outflow fluxes that accelerate with the
  surface-height difference to each neighbour. Outflow is scaled to the water available, so depth never goes
  negative and transfers are exactly conservative. Velocities come from net flux. Sources add water, drains and
  open map edges remove it, and every addition and removal is accounted (`added`, `removed`).
- **Ripples:** a separate damped 2D wave equation on wet cells (visual displacement, no mass). Dry neighbours reflect;
  waves interfere linearly. Clicks, waterfall impacts (and later rain) inject disturbances.
- **Waterfalls:** outflow over a terrain drop larger than 1.1 m is recorded with its landing cell. The cliff face
  under it renders as animated falling-water glyphs (density by flux), the landing pool gets splash/mist particles
  and ripples.
- **Threads:** with cross-origin isolation (the Vite dev/preview servers send COOP/COEP headers) the simulation runs
  in a Web Worker on SharedArrayBuffers and the renderer reads the same memory. Otherwise (or with `?worker=0`) the
  same code steps on the main thread. Fixed 60 Hz timestep, and only 16 x 16 chunks holding water (+1 chunk margin) are processed.
- **Look:** turquoise shallows to deep blue-green by depth, shore blending, ripple crests lighten and show `○ ◦`, flow
  stripes (`~ ≈ ≋`) travel along the velocity, foam on rapids and at waterfall feet, slow shimmer on calm water.
- Test world: `?scene=watertest` (channel, 5 m and 3.5 m cliffs with waterfalls, two ponds, a rock in the stream).

## Status

| Milestone | State |
|---|---|
| 1. Vite app, ASCII renderer, glyph and colour systems, terrain grid, camera | done (see below) |
| 2. Water flow, ripples, waterfalls | done (see below) |
| 3. Generation, vegetation, rocks, bridges, structures | next |
| 4. Sandbox tools, selection, undo/redo | planned |
| 5. Weather, animation, lighting, day/night | planned |
| 6. Save/load, optimisation, tests, polish | planned |

### Milestone 1: verified
- 13 unit tests (rng, noise, colour, clock, glyph registry and procedural glyph coverage, projection/occlusion/picking,
  deterministic generation, camera zoom-at-cursor and pan) and 4 browser tests (canvas renders a varied character
  landscape, wheel zoom, middle-drag pan, hover inspector, Space pause, narrow layout and hidden panels): all passing.
- Measured in headless Chromium on a software rasteriser (4 CPU cores): 60 fps at 126 x 60 characters; compose 0.5 ms,
  blit 0.1 ms (static frames redraw 0 cells), putImageData 0.6 ms.
- Known limitations: the terraces read weakly (generation spreads the steps over several cells). Milestone 3 adds
  deliberate escarpments for the waterfalls.

### Milestone 2: verified
- 11 water unit tests: closed-basin conservation (relative error < 1e-4 over 3,000 steps), the add/remove ledger with
  sources, drains and open edges, downhill flow, terrain walls, flow around an obstacle (splits, continues on both
  sides, collects downstream), waterfall detection and transfer, stability on steep terrain, ripple spread and
  symmetry, damping, linear interference of two sources (exact superposition), reflection at dry banks.
- 3 browser tests: flowing water, waterfall cells and splash particles in the test world; a real click with the ripple
  tool produces a spreading ring and two clicks combine; the main-thread fallback simulates water.
- Measured (headless Chromium, software rasteriser, 4 cores), 126 x 60 characters: 60 fps; water step 0.5-0.9 ms (worker
  or main thread); frame work about 2 ms (compose 0.5, blit 0.05-0.35, put 0.5).
- Known limitations: the generated world places water sources on bare terrain, so water fills basins instead of
  rivers. Milestone 3 carves the river system. Splash particles are visual only. Thin sheet flow below ~1 cm is not drawn.
