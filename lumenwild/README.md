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
| H | Hide / show all panels |
| F | Fullscreen |

## Architecture

```
src/engine/            framework-free engine (no React)
  core/                rng (seeded), noise (value/fbm/ridged), color (packed RGBA, gradients), math
  world/               World grid (typed arrays, 16x16 chunks with dirty flags), materials, Camera, Clock (fixed step)
  render/              glyphs (curated registry), GlyphAtlas (baked masks), TerrainShader (cached terrain look),
                       Composer (oblique projection, painter per column), CellBuffer, Blitter (masks -> pixels), Renderer
  gen/                 procedural generation
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

## Status

| Milestone | State |
|---|---|
| 1. Vite app, ASCII renderer, glyph and colour systems, terrain grid, camera | done (see below) |
| 2. Water flow, ripples, waterfalls | next |
| 3. Generation, vegetation, rocks, bridges, structures | planned |
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
