# Lumenwild changelog

## World Phase 2: continent terrain, streaming and navigation (2026-11-25)
- Decisions applied: six villages and no cities (validator rejects cities), renamed watchtowers, 100 m per map unit
  (provisional), 1 m cells as `World.ts` defines; rivers routed alongside villages; scale, travel times, memory and the
  streaming design in `docs/world/SCALE_AND_STREAMING.md`.
- `src/world/terrain.ts`: seamless 1 m terrain from the blueprint (ranges, valleys, rivers at true width, lakes,
  marsh pools, sea, gradual biome borders, materials, paths, trees, rocks).
- `src/world/stream.ts`, `session.ts`, `region.worker.ts`: a 3 x 3 region window that moves with the view (terrain,
  shading cache, objects, water and camera shift together; new strips shaded over several frames; regions generated in
  a worker and cached).
- `src/world/navigation.ts`: routes between any two points (roads cheap, bridges, no lakes or nests); travel along them.
- Continent mode: top bar → Continent (`?scene=continent`), Continent panel with position and travel. The valley,
  its water, dragon and saves are unchanged; continent mode does not save yet.
- Engine additions: `TerrainShader.shift` and time-budgeted shading, `ObjectStore.shift`, `shiftGrid`, batched water
  ports, an engine streaming hook.
- Tests: terrain (9), streaming (3), navigation (3), continent browser test; 145 unit and 59 browser tests pass.

## World map specification: Phase 0 and Phase 1 blueprint (2026-11-25)
- Phase 0 reuse report: `docs/world/PHASE0_REUSE_REPORT.md` (source-backed; conflicts with the settlement revision listed).
- Editable world data in `lumenwild/world/` (regions, coastline, ranges, elevation features, lakes, rivers, settlements,
  landmarks, roads, habitats, dragon territories and corridors, discovery), typed and validated (`src/world/schema.ts`).
- One coordinate utility (`src/world/coords.ts`): map units, metres, 3D world, 2 m cells, chunks, regions, prototype.
- Blueprint (`src/world/blueprint.ts`): design elevation from authored ranges and regional planes, rivers that never
  flow uphill (Emberfall 177 m), lakes, routed roads with bridges, settlement suitability, dragon landing sites and
  flight corridors; 41 geography checks, all passing. The existing A* was made grid-independent and reused.
- Discovery model (`src/world/discovery.ts`): fog of war, rumoured and hidden places, exploration per region, save/load.
- Map dialog: "World blueprint", "Player view at start" and the earlier draft. Previews in `docs/world/`.
- Design and plan for review: `docs/world/WORLD_BLUEPRINT.md`. Tests: `tests/world-blueprint.test.ts` (13),
  `e2e/m12-world-map.spec.ts`.

## Continent and settlement design (2026-11-25)
No cities: a wilderness continent (1024 x 1024 cells, about 2 km) with five small villages, generated as design data
in `src/engine/continent/` and previewed in the app (top bar → map icon). The playable valley is unchanged.
- Six biomes, three rivers with falls, four lakes, marshes, caves; four dragon territories, eight wildlife habitats.
- Greenhaven, Frostwatch, Windmere, Marshlight and Moonrest at the brief's coordinates, each with its own
  architecture, building programme, farmland, households, trades and daily routines (weather and danger reactions).
- 21-23 outposts, about 25 ruins, dungeons, landmarks, lairs and abandoned hamlets; terrain-following footpaths,
  forest trails, a mountain pass, boardwalks, bridges, fords and broken ancient roads.
- Measured on seeds 1-6: 87.7-88.4 % wilderness, 6.0-6.3 % settlements and paths, 5.6-6.0 % special locations.
- Tests: `tests/continent.test.ts` (17, the eight acceptance criteria), `e2e/m11-continent.spec.ts`.
- Plan to make it playable (region streaming): `docs/audit/CONTINENT_PLAN.md`, awaiting approval.

## Phase 1, steps 1.1-1.3 (2026-11-25)
**1.1 Presenter interface and golden images.** `render/Presenter.ts` defines how composed cells become pixels; the
CPU blitter is now `render/Canvas2DPresenter.ts` (no behaviour change). `?manual=1` lets tests drive frames with
fixed timestamps; `e2e/m8-golden.spec.ts` holds exact golden images of the nine review views (seed 7), identical
before and after the refactor, plus a run-twice determinism test.

**1.2 WebGL2 presenter** (`render/WebGLPresenter.ts`, `render/createPresenter.ts`): glyph, foreground and background
arrays uploaded as integer textures, glyph masks as an R8UI atlas, and an integer fragment shader that reproduces the
CPU blend exactly: it matches the Canvas 2D golden images pixel for pixel on all nine views. Selected with
View → Renderer or `?presenter=webgl`; switching remounts only the canvas. WebGL2 is probed on a throwaway canvas and
falls back to Canvas 2D with a message; context loss and restore are handled. Canvas 2D stays the default.

**1.3 Capability probe and benchmark** (`ui/capabilities.ts`, `ui/benchmark.ts`, Inspector → Benchmark): reports the
browser, cores, memory hints, GPU renderer string and WebGL limits, then runs four scenes (day, night storm,
zoomed-out storm, panning) on each presenter with per-layer timings (`Composer.profile`, off by default), checks the
LOW/MEDIUM p95 budgets, restores the view and exports a JSON report.

Measured in this container (headless Chromium, SwiftShader, 4 cores, 1120 x 816 canvas, 40 frames per scene):
Canvas 2D 60 fps in every scene (main-thread CPU 3.1-5.7 ms per frame); WebGL2 39-50 fps, because SwiftShader runs
the fragment shader on the CPU, although main-thread CPU falls to 2.0-4.9 ms and presentation from 0.7-1.3 ms to
0.1 ms. The laptop's real GPU has not been measured: run the benchmark there before changing the default.

Tests: 100 unit, 56 browser (new: 19 golden, 4 presenter, 1 benchmark).

## Visual upgrade, phases A and B
**Phase A (audit).** `docs/VISUAL_AUDIT.md` maps the frame pipeline, glyph rasterisation, terrain, water, object,
particle, light and weather code to exact files and functions, lists the palettes and the problems visible in the
baseline screenshots (`docs/screenshots/before/`), and records baseline performance.

**Phase B (glyphs, palettes, character shading)**, in `render/TerrainShader.ts`, `render/glyphs.ts`,
`env/Atmosphere.ts`, `env/Environment.ts`:
- Curated glyph families for every material (grass, meadow, forest floor, moss, dirt, stone path, sand, mud, stone,
  cliff, glowing moss) and ground cover (short and tall grass, wildflowers, ferns, reeds, moss patches, leaf
  litter, clover), each in three density tiers. 44 new glyphs (fine blades, tufts, pebbles, cobbles, dotted moss,
  flow marks), all from the bundled fonts.
- Clumped, deterministic density: a clump noise field mixed with a per-cell hash, so vegetation forms tufts and
  bare patches instead of an even sprinkle. Nothing changes between frames.
- Soft material borders: each cell blends its ground colour with differing neighbours (jittered weights), and
  vegetation glyphs creep across borders. Stone and cliff keep crisp edges; paths a soft one.
- Painterly palettes: richer greens, warmer paths that no longer look like stone, cooler blue-grey rock with
  mottling, low-frequency brighter/darker swathes, dry olive and lush blue-green patches by moisture.
- Glyph colour runs from a family tint to a tip colour by density and sunlight (sun-facing slopes highlight).
- Faces: rock strata and soil layers follow absolute height, so layers line up across columns; vegetated lips
  drip grass; rock edges catch the light.
- Depth attenuation: the far (upper) rows fade slightly toward a sky haze that follows the time of day (pale teal
  by day, warm at dusk, deep blue at night). Off in low-performance mode.
- Tests: `tests/shading.test.ts` (deterministic shading, soft vegetation borders and crisp rock, clumped density,
  lit versus shaded slopes). 76 unit tests and 28 browser tests pass.
- Performance (126 x 60 characters): 60 fps, compose 1.3 ms (was 1.4-1.6), blit 0.2 ms. Full-world shading at
  load 33 ms (was 11 ms); an edit re-shades a 16 x 16 chunk in 0.2 ms (was 0.12 ms).
- Screenshots: `docs/screenshots/after-phase-b/` (same nine views as `before/`).

## Christmas tree
- New tree type `christmas` (`objects/defs.ts` `christmasTree`): a 15 x 27-cell decorated fir with six tiers,
  triangle-glyph silhouettes, needles lit from the upper left, gold garlands, baubles, a glowing star, a trunk and
  presents. About 50 bulbs twinkle through red, gold, blue, green and warm white on their own phases
  (`Anim.Twinkle` in `objects/ObjectLayer.ts`); bulbs, star and garland are emissive and the tree casts a warm
  12-cell light pool at night.
- Every generated world places one beside the cottage and the stream, toward the map centre, with a path from the
  cottage and a clearing around it, never in front of a building or the bridge. The opening view frames it.
- Place more with the Tree tool (type: Christmas). Tests: `tests/world.test.ts` (five seeds).
- Screenshots: `docs/screenshots/christmas-tree-day.png`, `christmas-tree-night.png`.

## Autonomous dragon
New subsystem `src/engine/dragon/` (14 files): entity and validation, needs, memory, state machine, utility AI, senses,
navigation, steering, flight, animation, interactions, cached character poses and renderer, plus the dragon panel
(`ui/components/DragonPanel.tsx`), a top-bar button, follow camera, pick-a-place, quadrant-combination glyphs
(`▞▛▚▜▙▟`), and an optional `dragon` field in the save format (older files still load). See the README section
"The dragon" for behaviour, tests and limits. Tests: 95 unit, 32 browser, all passing.

## Dark dragon, mountain lair, dense Christmas tree, clearer world
- Dragon recoloured: obsidian scales with a steel sheen, crimson wing membranes, black finger bones and rim, an ember
  ridge that glows, amber eyes. Body, neck, tail and wings are drawn with solid shaded blocks (dense, clean).
- A huge snow-capped mountain (about 38 m above its foot) is generated far from the river toward the back of the map,
  with rounded shoulders, spurs and crags, snow faces, and a dark rock cave on its level summit (new object `cave`,
  new material `Snow`). The dragon rests and sleeps there: it plans its climb along the route (climbs early, slows
  to spiral up steep rises), lands on the stone apron and lies facing into the cave. The cave counts as shelter.
- Christmas tree rebuilt as dense block art: seven shaded tiers, drooping branch tips, snow on the branches, gold
  bead garlands, glass baubles, a star with rays; about 60 bulbs cycle colours and tint the needles around them.
- World colour grade: 20 % desaturation and a gentle midtone curve (lights, eyes and bulbs keep full colour); calmer
  grass texture; denser rock faces; a sky beyond the world's back edge that follows the time of day.
- Tests: mountain, cave and lair on five seeds; the dragon sleeps in its cave at night. 100 unit, 32 browser tests.
