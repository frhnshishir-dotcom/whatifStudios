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
| Ctrl+S | Save (to the current slot, or a new one) |
| Click the world name (top bar) | Worlds dialog: save slots, new world from a seed, export / import JSON |
| Delete / Backspace, Esc | Delete the selected object, deselect |
| [ and ] | Brush size |
| H, F | Hide / show all panels, fullscreen |

Tool hotkeys: V select, R ripple, E eraser, 1 terrain brush, 2 raise, 3 lower, 4 water brush, 5 source, 6 drain,
7 river/channel, 8 waterfall, T tree, G grass & flowers, M mushrooms, K rock, B bridge, C cottage, W water mill.

### Editor tools
| Tool | What it does |
|---|---|
| Select | Click open water to make ripples. Click an object to select it (inspector: type, size, moss, glow, wheel side, deck height...), drag to move it |
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
  env/                 Environment (time of day, weather targets, ambient light), Atmosphere (weather particles,
                       grass sway, point lights, emissive glow, fog)
  dragon/              the autonomous dragon: entity + validation, needs, memory, state machine, utility AI, senses
                       (terrain/water/objects), navigation, steering, flight physics, animation, interactions,
                       cached character poses, renderer
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

### Weather, light and animation
- **Time of day:** a day-night cycle (8 minutes per day by default, or set the time with the slider). Ambient light
  is white at noon, golden before sunset and after sunrise, blue moonlight at night; rain and fog dim and grey it.
- **Lights at night:** cottage and mill windows, glowing mushrooms, rune stones, blossom trees and fireflies cast
  coloured pools of light; glowing moss lights itself. Emissive glyphs (windows, glowing caps, fireflies, sparkles)
  are not darkened by the night.
- **Wind:** gusting wind sways tree canopies (deterministic per tree), sends travelling bands through tall grass,
  reeds and flowers (glyphs bend with the wind direction), blows leaves from trees and drifts pollen in meadows.
  Leaves that land on water float away with the current.
- **Rain:** slanted streaks with the wind; drops landing on water make ripple rings through the wave simulation,
  on land they splash.
- **Fog:** a drifting veil, thicker towards the back of the view and in low ground.
- **Always moving:** water flow, waterfalls, ripples, splashes and mist, fireflies and glade sparkles at night,
  mushroom and rune glow pulses, lit windows, the turning mill wheel.
- Weather presets: clear, breezy, rain, storm, fog; or set rain, fog, wind and wind direction directly.
  Changes fade in over a few seconds.

### The dragon
Every generated world has one autonomous dragon (name and personality from the seed). Nothing scripts it:
- **Mind:** needs (energy, thirst, comfort, alertness) and personality (curiosity, boldness, restfulness, wanderlust,
  sensitivity) feed a utility AI that scores eight goals a few times a second (explore, roam, drink, rest, sleep,
  shelter, investigate, idle) with cooldowns, commitment and noise. A finite-state machine with 15 states and an
  explicit transition table, minimum durations and a history carries the plan out. It remembers visited places,
  water it found, landmarks it liked and good resting places (recently visited places are much less attractive).
- **Flight:** steering (seek, arrive, wander, circle, obstacle and terrain avoidance, edge avoidance) drives a
  physical model with limited turn rate and turn acceleration, acceleration and braking, climb and sink rates per
  state, gliding that trades height for speed, wind drift, and a coarse obstacle map (terrain, water, trees,
  buildings) for clearance. It never teleports and never enters the ground.
- **World:** it lands only on dry, level, free ground; drinks at the shore (real ripples in the water simulation
  plus droplets); skims water with a wake; circles waterfalls and landmarks; sleeps at night in sheltered places;
  seeks shelter in rain (more if sensitive); is pushed by wind; comes to look when you edit nearby.
- **Look:** a 2.5D anatomical model (body, bat wings with finger bones and scalloped edges, legs) posed for 8 wing
  frames, glide, landing, standing and lying, rotated to 24 headings at 4 altitude scales, rasterised once into
  characters (quadrant blocks on the silhouette, membrane, scales, ridge and claw glyphs inside) and cached. Neck,
  head (horns, glowing amber eyes) and the 14-segment tail are drawn live; the tail follows the body with a delay.
  Its ground shadow fades and softens with altitude; it takes the time-of-day light and fog; the ridge glows faintly.
- **You:** click it (select tool) or the dragon button in the top bar for its panel: behaviour, destination, altitude,
  needs, personality, memory, and Follow, Autonomous/Holding, Pause, Effects, Reset, Investigate (click a place).
- **Saved** with the world (position, state, needs, personality, memory, settings), validated on load; older saves
  without a dragon load fine and a new dragon hatches.
- **Sound:** optional hooks only (`DragonInteractions.sound`: wingbeat, call, land, lap, breathing). No audio ships.

### Saving and loading
- **Slots:** worlds are saved in the browser with IndexedDB (falling back to localStorage, then memory), each with a
  name, seed, date, size and a small top-down thumbnail. Ctrl+S saves to the current slot (or a new one); the Worlds
  dialog also saves to a new slot, loads, deletes, renames, and keeps an **autosave** slot written every 90 s while
  there are unsaved changes. Loading over unsaved changes and deleting ask for a second click.
- **What is saved:** the full edited state, not just the seed: elevation, materials, plants, moisture, glow, water
  depths, every object with its properties, springs and drains, time of day and weather, camera and home view.
  The seed is kept, so the original world can always be regenerated (New world).
- **JSON export / import:** Export downloads `<name>-seed<N>.lumenwild.json` (about 1.3 MB). Import validates
  before touching anything: format and version, world size, every grid's length, finite elevations within range,
  known materials and cover, water depths (invalid ones reset with a warning), object shapes (unknown kinds and
  out-of-bounds objects are skipped, unknown variants replaced, with warnings), springs/drains, weather values
  (clamped). A file that fails shows every error and leaves the current world untouched.
- **New world:** any seed (or the dice for a random one) regenerates the vale in place, with flowing water.
- Format details: `src/persist/format.ts` (version 1; grids as base64 typed arrays).

### Performance
CPU-first: no WebGL, one `putImageData` per frame, typed arrays everywhere, no per-frame allocation in the hot
paths, the water simulation in a Web Worker on shared memory, only active 16 x 16 water chunks simulated, terrain
shading cached per chunk, and unchanged cells skipped by the blitter. Measured in headless Chromium with a software
rasteriser on 4 CPU cores (frame work = compose + blit + put; the water steps in parallel in the worker):

| Scenario | Grid | fps | compose | blit | put | water step |
|---|---|---|---|---|---|---|
| Default view, day | 126 x 60 | 60 | 1.6 ms | 0.25 ms | 0.6 ms | 1.1 ms |
| Night, storm and fog | 126 x 60 | 60 | 2.5 ms | 0.6 ms | 0.5 ms | 1.0 ms |
| Zoomed out (5 px cells), day | 225 x 103 | 60 | 4.2 ms | 0.5 ms | 0.6 ms | 1.0 ms |
| Zoomed out, night storm (2,000 particles) | 225 x 103 | 60 | 6.5 ms | 0.7 ms | 0.4 ms | 1.0 ms |
| Low-performance mode, same | 225 x 103 | 30 | 6.4 ms | 0.9 ms | 0.6 ms | 1.2 ms |

**Low-performance mode** (View panel) caps rendering at 30 fps, lowers the render resolution to 75 % and spawns
fewer weather particles, for weak laptops. Without cross-origin isolation (or with `?worker=0`) the water runs on
the main thread with the same code.

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
| 5. Weather, animation, lighting, day/night | done (see below) |
| 6. Save/load, optimisation, tests, polish | done (see below) |

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

### Milestone 5: verified
- 8 unit tests: noon is neutral and bright, midnight blue and dark, golden hour warm; the clock advances one hour per
  10 s at a 4-minute day and stops with the cycle off; weather fades in; rain and fog dim the light. Through the real
  composer and layers: night darkens the frame by more than half and the cottage lights the ground around it (over
  1.4x brighter than far ground) with emissive windows; wind bends tall grass and no wind bends none; rain falls and
  sends ripple commands to the water; a leaf landing on a stream turns into a floating leaf and moves downstream with
  the current; fog veils most of the view.
- 5 browser tests: the time slider takes the frame from day to night (mean brightness drops over 40%), fireflies
  gather and emissive cells show; the cycle advances the clock; the storm preset fills the view with rain streaks
  and rings on the river, and clear weather stops it; wind bends grass and calm stops it, fog flattens contrast;
  leaves fall in a breeze. All 65 unit and 23 browser tests pass.
- Inspected screenshots: night at the cottage (lit windows, warm light pool, fireflies), the glade at night (glowing
  moss, glowing mushrooms, sparkles), a rainstorm over the river, dawn fog, dusk with the inspector.
- Measured, 126 x 60 characters: 60 fps; compose 1.0-2.0 ms with lighting and fog (the lighting pass is skipped in
  clear daylight), blit 0.2-0.6 ms (rain and swaying grass redraw more cells).
- Known limitations: rain does not add water volume to the simulation (it is visual plus ripples); fog is a screen-space
  veil, not a volumetric effect; leaves only float on water deeper than 5 cm.

### Milestone 6: verified
- 7 new unit tests: base64 for every length; **a generated world with edits (raised terrain, a rock, a spring,
  weather, a new name) survives snapshot -> JSON -> validation -> load into a fresh engine exactly** (elevation,
  materials, plants, solid mask, objects, springs, water depths, weather, seed) and keeps simulating; invalid files
  (not JSON, not a world, newer version, bad size, truncated grid, NaN elevation, missing objects) are rejected with
  reasons, while bad objects, springs and weather values become warnings; regenerating a seed is deterministic;
  IndexedDB slots save, list (autosave first, then newest), overwrite, load and delete; memory fallback.
  Plus a select-tool test: clicking open water ripples and selects nothing.
- 5 new browser tests: Ctrl+S saves, an edit marks the world unsaved, loading the slot (two-click confirm) restores
  it, and the slot survives a page reload; rename, save as new slot, delete with confirmation; export downloads a valid
  world file, importing it restores the world after generating another one, and a bad file is explained without
  changing the world; a new world from seed 42 has its landmarks and flowing water; low-performance mode runs at
  about 30 fps with 75 % resolution.
- **Totals: 72 unit tests and 28 browser tests, all passing**; `npm run build` is clean; the dev server works with
  the worker. Inspected the Worlds dialog with two slots and thumbnails.

## Acceptance criteria

| # | Criterion | Where it is shown |
|---|---|---|
| 1 | A beautiful ASCII landscape at launch | Generated vale with river, falls, forest, cottage, mill, glade (M3 screenshots, e2e `m3-world`) |
| 2 | Real text characters | Every cell is a glyph from `render/glyphs.ts` drawn via `fillText`-baked masks (or procedural block/line glyphs) |
| 3 | Water flows through channels | Virtual-pipes simulation; unit test "water flows through the generated river and over all three falls" |
| 4 | Waterfalls cascade | Animated fall faces with splashes and mist; e2e "the large waterfall pours" |
| 5 | Clicking a pond makes expanding ripples | Select or Ripple tool on water; e2e "clicking a pond with the ripple tool" |
| 6 | Ripples interfere | Linear wave equation; unit test "linear interference of two sources" |
| 7 | Water flows around obstacles | Solid mask from rocks and buildings; unit test "flow around an obstacle" |
| 8 | Raise and lower terrain | Raise/Lower tools; unit and e2e tests with undo/redo |
| 9 | Build waterways | Channel and Waterfall tools, springs and drains; unit tests carry water end to end |
| 10 | Place trees, flowers, rocks, structures | Tree, Grass & flowers, Rock, Mushroom, Bridge, Cottage, Mill tools; e2e placement tests |
| 11 | Continuous animation | Water, falls, wind sway, leaves, fireflies, glow, mill wheel, day-night, weather |
| 12 | Pan and zoom | Middle/right/Space drag, wheel at cursor, arrows, Home; e2e `m1-render-camera` |
| 13 | Save and restore | IndexedDB slots, autosave, JSON export/import with validation; e2e `m6-persistence` |
| 14 | No backend | Static Vite build; everything runs in the browser |
| 15 | Reasonable performance on integrated graphics | CPU renderer, 60 fps measured up to 225 x 103 characters, low-performance mode |

## Known limitations
- The world size is fixed at 256 x 256 cells; imports of other sizes are refused with a clear message.
- Rain does not add water volume (it is visual, with ripples and splashes); fog is a screen-space veil.
- Moving a building does not re-level the ground under it; water volume is not part of undo (springs and drains are).
- Splash particles are visual only; very thin sheet flow (under about 1 cm) is not drawn.
- Measurements above come from headless Chromium with a software rasteriser; real laptops will differ (the renderer
  uses the CPU and `putImageData`, so integrated graphics are not a bottleneck).

### The dragon: verified
- 13 unit tests (`tests/dragon.test.ts`, plus one in `tests/persist.test.ts`): a 15-minute day and night on a real
  generated world with no refused transitions, no repairs, no teleports, clearance kept, ten different states seen,
  minimum durations respected and landmarks remembered; different seeds behave differently; weighted destinations
  that avoid just-visited places; acceleration, turn rate and turn acceleration, climb and sink limits; a 30 m ridge
  in the way is crossed without touching the ground; thirst leads to landing on dry level ground, drinking and real
  ripples on water; tiredness to resting; night to sleeping and morning to waking; rain to shelter, wind to drift;
  investigating a disturbance; save -> JSON -> load; recovery from invalid state; corrupt saves; old saves.
- 4 browser tests (`e2e/m7-dragon.spec.ts`): drawn with a shadow, moving, wing frames changing; a real click opens its
  panel; pause, holding and follow work; Investigate sends it to a clicked place; it survives save and load.
- Screenshots: `docs/screenshots/dragon/` (forest, river, waterfall, landing, drinking, night, rain).
- Cost: 0.015 ms per simulation step, 0.04 ms to draw, 0.9 ms to build a new pose once (then cached). The frame rate
  table above is unchanged (60 fps; low-performance mode 30 fps).
- Limits: the dragon sees the world through a 4 x 4-cell obstacle map, so a very tall single tree can make it climb
  early; it does not walk long distances on the ground (it flies); poses use 24 headings, so a slow turn steps by 15°.
