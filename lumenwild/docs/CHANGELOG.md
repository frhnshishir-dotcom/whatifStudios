# Lumenwild changelog

## Phase 5: playable RPG systems (2026-11-26)
- **Character:** levels, attribute points (Strength, Agility, Vitality), health and stamina, 12 skills that improve
  with use, statistics; saved with the continent and on the server.
- **Combat** (Space attack, Q dodge, H eat) with the existing creature AI:
  - creature health and a fight state; wolves and bears fight back, packs join in, wolves hunt at night;
  - timid animals flee, and wounded ones slow down;
  - criticals, armour, dodge invulnerability;
  - death and respawn in the home village; cave and ruin guardians; creatures respawn.
- **Items:** 46, with rarity and rolled properties; 6 equipment slots and a 24-slot pack; loot bags with kill
  ownership; use, equip, drop, sell, trade.
- **Gathering and crafting:** trees, rocks, mushrooms and finds; 23 recipes at forge, workbench, hearth and
  herbalist stations.
- **Economy:** villager shops (11 trades), pricing by value, demand and trading skill; player-to-player trade.
- **Quests** from villagers: bounty, gather, craft, explore, dragon sighting, delivery. Discovery rewards and quest
  progress are saved.
- **Multiplayer** (protocol 2):
  - the server runs the rules; commands and routed events; character sync;
  - creature and player health in snapshots; loot sync;
  - client interpolation; move validation against walls and water, with corrections;
  - sessions keep characters while players are away; flood limit;
  - load test with 16 bots.
- **Dragons:** five distinct identities (palette and size), refined articulated wings, banking. The Valley's dragon
  is unchanged (golden images match).
- **HUD:** health, stamina and XP bars, damage numbers, E prompt, health bars, name tags. **Panel tabs:** Hero,
  Pack, Quests, Craft, Shop, Trade. Game keys no longer trigger editor tools; F no longer toggles fullscreen during
  play.
- Docs: `docs/world/RPG.md`, `rpg-*.jpg`. Tests: `tests/rpg.test.ts`, `tests/load.test.ts`, the multiplayer combat
  and trade test, `e2e/m19-rpg.spec.ts`. Totals: 202 unit and 65 browser tests passing.

## Phase 4: living world and multiplayer foundation (2026-11-26)
- **Traveller:** walk (WASD), run (Shift, uses stamina) and interact (E); F watches the nearest dragon. The panel shows
  the pack, who is nearby, the E prompt, the dragons and a journal.
- **Wildlife** (deer, wolves, bears, foxes, birds):
  - habitats and deterministic spawning;
  - needs (hunger, thirst, energy, stamina), grazing, drinking, sleeping;
  - herds and packs;
  - predators hunting prey, fleeing, territorial charges;
  - simulation by distance: detailed at 10 Hz, coarse at 1 Hz, dormant beyond.

  The sprites are 2–4 cell silhouettes on darkened ground, readable among grass and flowers.
- **Villagers** in all six villages:
  - generated from the buildings, each with a home, a job and a workplace;
  - a daily schedule along the lanes: work, gatherings and chats, shelter from rain;
  - flight from dragons and predators.
- **Five autonomous dragons:**
  - steered 3D flight with terrain clearance, and at least 450 m above ground near villages;
  - take off, patrol, land, rest and sleep;
  - drink, hunt real wildlife, defend the nest, circle travellers, migrate along the blueprint routes;
  - drawn with the existing dragon renderer.
- **Exploration:** watchtowers that reveal 3 km of the map, ruins, caves, standing stones, and finds (chests, herbs, ore,
  relics). The living world (players, explored map, wildlife, dragons, journal) is saved in the continent save.
- **Multiplayer foundation (local, no cost):**
  - `npm run server` starts an authoritative Node world server (WebSocket, no new dependencies) running the same
    simulation;
  - 5 Hz snapshots of what is near each client;
  - session tokens with reconnection;
  - speed validation and first-come finds;
  - shared region edits;
  - JSON persistence.

  Join with `?server=ws://localhost:8787&name=X`. Tested with three Node clients and two browser clients on one
  server.
- Not yet: player progression, combat, crafting, economy. Not measured on the target laptop.
- The Valley is unchanged. So are the biome transitions (baa9516), continent saves and regional edits.
- Docs: `docs/world/LIVING_WORLD.md` and the `living-*.jpg` screenshots. Tests: `tests/life.test.ts` (11),
  `tests/multiplayer.test.ts`, `e2e/m17-multiplayer.spec.ts`, `e2e/m18-living-world.spec.ts`.

## Phase 3b: villages and road bridges at 1 m (2026-11-25)
- Six villages are built from `world/settlements/settlements.json` (each with its `culture`), using the draft village
  engine's cultures and programmes:
  - square and communal feature
  - lanes toward road exits
  - buildings within each settlement's range (13-30 counted)
  - fields, pasture or gardens

  Plans are deterministic (`src/world/villages.ts`). They are drawn into regions with level pads that never cross a
  region edge.
- `building` object: a parametric village building in five culture styles (base, storeys, gabled roof, type
  details), plus small structures and towers.
- `span` object: road bridges at all six blueprint crossings (16-84 m), across the river from bank to bank, with
  railings and piers; trees and rocks are kept off them.
- Persistence: generated object properties (deck heights absolute) are part of the reference; generator version
  bumped.
- The biome transition system (baa9516) is unchanged; the Valley is unchanged (golden images match).
- Docs: `docs/world/PHASE3_VILLAGES_BRIDGES.md`, `villages-close.jpg`, `villages-mid.jpg`. Tests:
  `tests/world-villages.test.ts` (6), `e2e/m16-villages.spec.ts`; 178 unit and 62 browser tests pass.

## Phase 3a: persistent continent data (2026-11-25)
- Baseline kept: the approved biome transition system (commit baa9516) is unchanged.
- `src/world/edits.ts`: each region's difference from generation. It covers changed cells, removed and added objects,
  ponds on dry ground, and the player's sources and drains. The difference is taken when a region leaves the window,
  put back when it returns, and serialised for saves.
- `src/world/continentSave.ts`: continent save format (position, zoom, weather and time, edits), validation and a
  world fingerprint; a save from different world files loads with a warning.
- `ContinentSession`:
  - captures and reapplies edits on every window move
  - carries the player's sources and drains across moves
  - `collectEdits` for saving
  - `loadAt` rebuilds the window around any map point with edits applied
- Storage: `SlotStore` takes a namespace; the continent uses its own (`lumenwild-continent`). Valley slots, format and
  behaviour are unchanged.
- App: in continent mode, save, load, autosave, export and import use continent saves; "New world" is hidden there.
- Tests: `tests/world-persist.test.ts` (5) and `e2e/m15-continent-save.spec.ts`; 172 unit and 61 browser tests pass.

## World Phase 2c: natural biome transitions (2026-11-25)
- Borders between biomes are irregular ecological patches instead of per-cell random speckle (`src/world/ecotone.ts`,
  `src/world/terrain.ts`):
  - Shares come from the blueprint, tilted by elevation, slope and wetness, and are picked by a smooth, domain-warped
    noise.
  - Ground cover comes in clumps.
  - Tree density follows the patch and blends across borders, with groves and species patches that cross them.
  - Ground colour leans toward the neighbouring biome by its share and is feathered at patch edges, stored per cell as
    `RegionData.blend` / `World.blend` (continent only).
  - Everything is deterministic and computed at generation, never per frame.
- Renderer: `TerrainShader` applies the blend to a cell and to the neighbours it smooths with, only when
  `World.blend` exists. The Valley has none, so its output is unchanged (golden images match).
- Streaming: the region cache queues worker requests one at a time, and regions a move is waiting for jump the queue.
  The slowest window move in the travel test is 23-25 ms.
- Comparisons: `docs/world/transitions-close.jpg`, `docs/world/transitions-distant.jpg`. Tests:
  `tests/world-transitions.test.ts` (9) and a queue test; 167 unit and 60 browser tests pass.

## World Phase 2b: authentic biomes, water that persists through moves, technical report (2026-11-25)
- Biomes on the 1 m terrain (`src/world/terrain.ts`): Dragon Peaks snowline (lower on north faces), scree, alpine
  meadow, tree line and rock steps; Hollow Lands ash, scree, thorns, dead trees, rock formations, terraced mesas and
  glowing ember cracks along the fissures; Whispering Marshes pools and meandering channels at flat levels with rims
  that hold them, bog, reed beds, willows and snags; Golden Plains dry golden grass, wildflower drifts, lone trees and
  outcrops. New materials (dry grass, ash, bog, scree), covers (golden grass, embers, thorns) and a dead-tree sprite.
- Water (`WaterSim`, continent mode only): settled chunks sleep, near-still water gets drag, and `shift` carries depth,
  flow, ripples and sleep state through window moves (before, velocities and ripples restarted). Fixed: strip objects
  were added before the water shifted, which cleared water in the wrong cells. The Valley simulation is bit-identical.
- `?at=x,y` opens continent mode at a map point.
- Report: `docs/world/PHASE2_TECHNICAL_REPORT.md`; screenshots `docs/world/biomes-before.jpg`, `biomes-after.jpg`,
  `biome-borders.jpg`.
- Tests: `tests/world-biomes.test.ts` (8), `tests/water-sleep.test.ts` (3), water through a move (1),
  `e2e/m14-biomes.spec.ts`; 157 unit and 60 browser tests pass.

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
