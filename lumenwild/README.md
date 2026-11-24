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
| Left click / drag | Use the active tool |
| Middle drag, Space + drag, right drag | Pan |
| Mouse wheel | Zoom (anchored at the cursor) |
| Arrow keys | Pan |
| Home | Return to the opening view (the bridge) |
| Space (tap) | Pause / resume simulation |
| Ctrl+Z, Ctrl+Y (or Ctrl+Shift+Z) | Undo, redo (also the top-bar buttons) |
| Delete / Backspace, Esc | Delete the selected object, deselect |
| [ and ] | Brush size |
| H, F | Hide / show all panels, fullscreen |

Tool hotkeys: V select, R ripple, E eraser, 1 terrain brush, 2 raise, 3 lower, 4 water brush, 5 source, 6 drain,
7 river/channel, 8 waterfall, T tree, G grass & flowers, M mushrooms, K rock, B bridge, C cottage, W water mill.

### Editor tools
| Tool | What it does |
|---|---|
| Select | Click an object to select it (inspector: type, size, moss, glow, wheel side, deck height...), drag to move it |
| Ripple | Click or drag on water |
| Eraser | Removes objects, plants, springs and drains under the brush |
| Terrain brush | Paints ground material (grass, meadow, forest floor, moss, dirt, stone path, sand, mud, stone, glowing moss) |
| Raise / Lower | Hold to raise or lower a smooth mound; steep slopes turn to cliff; lowering clears plants from the pit |
| Water brush | Hold to pour water or soak it up |
| Source / Drain | Click to place a spring or drain (rate in m³/s); click a marker again to remove it |
| River / channel | Drag to carve a channel; its bed never rises along the stroke, so a channel dragged downhill drains to its end |
| Waterfall | Click a stream: the bed downstream drops by the set height until the original ground is that low anyway (or the map edge), so the fall lasts instead of silting up; the lip becomes stone |
| Tree, Mushrooms | Click to place, drag to scatter (type or mixed, tree size) |
| Grass & flowers | Paints wildflowers, tall/short grass, clover, ferns, reeds, moss, or clears plants |
| Rock | Boulder, big rock or formation (blocks water) |
| Bridge | Click on a river: the bridge spans the water under the click with its deck above the surface |
| Cottage, Water mill | Click on dry ground; the ground under the building is levelled. The mill puts its wheel on the side with water |

Each stroke is one undo step (a channel that also removed the trees in its way undoes both). Placements that can't
work explain why (occupied, needs dry ground, too deep, too wide). Water volume is simulation state and is not
part of the undo history; springs and drains are.

## Architecture

```
src/engine/            framework-free engine (no React)
  core/                rng (seeded), noise (value/fbm/ridged), color (packed RGBA, gradients), math
  world/               World grid (typed arrays, 16x16 chunks with dirty flags), materials, Camera, Clock (fixed step)
  render/              glyphs (curated registry), GlyphAtlas (baked masks), TerrainShader (cached terrain look),
                       Composer (oblique projection, painter per column), CellBuffer, Blitter (masks -> pixels), Renderer
  water/               WaterSim (virtual pipes + ripple wave equation), water.worker (shared-memory stepping),
                       WaterSystem (worker or main-thread facade), WaterLayer (water/waterfall rendering, splashes)
  objects/             object kinds and seeded sprites (defs), ObjectStore (occupancy, chunk buckets, solid mask),
                       ObjectLayer (depth-tested sprites, sway, glow, lit windows, turning mill wheel)
  gen/                 world generator (river system, falls, lake, mill race, ponds, structures, forest, glade),
                       base terrain and surface materials, deterministic test scenes
  edit/                Editor (all tools, strokes, terrain patches, commands), History (undo/redo, composites),
                       EditorOverlay (brush disc, building footprint preview, spring/drain markers)
  Engine.ts            frame loop, simulations at a fixed step, layers (water, objects, particles, overlay), input
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

### World generation (`?seed=N`, default 7)
Everything comes from the seed (seeded PRNG and hash noise only, no `Math.random`), in `gen/world.ts`:
1. **River:** a Catmull-Rom spline meanders from the northern highlands to the southern edge. A chamfer pass gives
   every cell its distance to the river and the arc length of its nearest river point.
2. **Bed profile:** a gentle slope with one large drop (9-10.5 m) and two small drops (3.2-4 m) at seeded positions.
3. **Terrain relative to the river:** near the river the ground follows the bed of its nearest river point, so each
   drop becomes an escarpment across the valley. Farther away it blends into a heavily blurred copy (no seams where
   meanders meet) plus hills, northern highlands and ridged rock. The channel widens downstream and at each fall; the
   lip above each fall is a flat stone weir so the whole width pours over.
4. **Water bodies:** plunge pools below each fall, a lake on the longest gentle stretch, a mill race that leaves the
   river, bulges away, drops over the same escarpment as a small fall and rejoins, and 3 ponds on level ground with the
   water level below their lowest rim cell. The water simulation is prefilled to these levels and a source feeds
   the river head, so the world flows from the first frame.
5. **Surface and life:** sand, mud and reeds on the banks, moss and ferns near water, mossy stone at the lips, stone
   paths from the cottage and the mill to the bridge, a flower garden; trees by habitat (pines on high ground, oak and
   birch in forests and meadows, willows on banks), boulders, rock formations, red and brown mushrooms.
6. **Structures:** a wooden bridge between falls (deck above both banks), a cottage on flattened dry ground near one
   end of it, a two-storey water mill whose wheel stands in the race below its drop, and a glowing glade (luminous moss,
   a ring of rune stones, a blossom tree, glowing mushrooms) away from the river. Structures get clearings so nothing
   grows in front of them.
- Objects are sprites of glyph cells (`objects/defs.ts`), drawn after terrain and water with a depth test, so
  nearer terrain hides them. Rocks, stones, cottages and mills are solid: they are stamped into a shared mask and
  water flows around them.

## Status

| Milestone | State |
|---|---|
| 1. Vite app, ASCII renderer, glyph and colour systems, terrain grid, camera | done (see below) |
| 2. Water flow, ripples, waterfalls | done (see below) |
| 3. Generation, vegetation, rocks, bridges, structures | done (see below) |
| 4. Sandbox tools, selection, undo/redo | done (see below) |
| 5. Weather, animation, lighting, day/night | next |
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

### Milestone 3: verified
- 13 new unit tests: generation is deterministic per seed and differs between seeds; 8 seeds each have the large
  waterfall, two small waterfalls (the large drop is more than twice the others), lake, mill race, at least 2 ponds,
  bridge, cottage, water mill, glowing glade and hundreds of trees plus rocks, mushrooms and stones; the river is one
  water body from source to the southern edge through the lake and the race, with at least 3 separate water bodies;
  every river cell is under water and levels only step down; the map is not mirror-symmetric; structures sit on dry
  ground and solid objects are stamped into the solid mask; the mill wheel stands in water; **the water simulation run
  on a generated world pours over all three falls and leaves at the southern edge**; object store add, overlap
  refusal, move, remove, JSON round trip and reporting of invalid entries; every kind and variant has a sprite.
  A survey of seeds 1-60 found every landmark in every seed.
- 4 new browser tests: the opening view shows objects and river water; the large waterfall has animated fall glyphs;
  the mill wheel's glyphs change over time; different seeds give different worlds. All 41 unit and 11 browser tests pass.
- Inspected screenshots of the opening view, the large waterfall (a full-width curtain between rock walls into a deep
  pool), the mill and race, the bridge and cottage, the glade, and a second seed.
- Measured (headless Chromium, software rasteriser), 126 x 60 characters with about 1,700 objects in the world:
  57-60 fps; compose 1.0-1.3 ms, blit 0.2-0.5 ms, put 0.4-0.8 ms; water step 1.1-1.3 ms in the worker.
- Known limitations: the cottage and mill are small at the default zoom (zoom in to see the windows and the wheel);
  standing stones read as plain grey pillars; flat stone areas on the highlands are a little uniform. The relief
  default is now 0.75 rows per metre (slider in the inspector) so falls and slopes read as height.

### Milestone 4: verified
- 16 editor unit tests (real World, ObjectStore and main-thread WaterSystem): raise while held, with exact undo and
  redo; a dug basin collects poured water; steep slopes turn to cliff and undo restores the material; the terrain
  brush, plant brush and eraser; a new edit clears redo; placement, overlap refusal with a message, id-stable
  undo/redo; drag-scattered trees are one step; a cottage levels its ground and undo restores ground and solid mask;
  buildings refuse water; select-drag moves (one step), Delete and undo; inspector edits with slider coalescing;
  the eraser removes objects and springs in one step; springs/drains toggle and undo; **a channel dragged downhill has a
  non-rising bed and carries water from a spring to its end**; **the waterfall tool drops the bed and water pours
  over the new lip**; a bridge spans the water with its deck above the surface.
- 7 browser tests driving the real UI with mouse and keyboard: all 18 tools by button and hotkey, `[`/`]` brush
  size; raise with a held click, then Ctrl+Z / Ctrl+Y; place a cottage, select it, Delete, undo; a blocked placement
  shows a message; drag-scatter trees then erase them; the water brush pours water and a spring shows its marker;
  the waterfall tool lowers the river bed downstream. All 57 unit and 18 browser tests pass.
- Inspected screenshots: building footprint preview, placed and selected cottage with the inspector, a channel
  carrying water from a new spring, and a waterfall cut into the generated river (stone lip, falling water, gorge).
- Known limitations: moving a building does not re-level the ground under it; brush strokes on terrain hidden behind
  tall objects pick the object's ground cell; Ctrl+S saving arrives with Milestone 6.
