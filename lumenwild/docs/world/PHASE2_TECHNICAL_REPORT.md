# Continent: technical report before Phase 3

Status of continent mode on 2026-11-25, after the biome and water increment. Every figure was measured in this
development container (Node 22, and headless Chromium with **SwiftShader**, a software GPU, on 4 CPU cores) or
calculated from the world files. **None of it is verified on the target laptop.** That needs the Inspector →
Benchmark results from the laptop.

Decisions applied: 100 m per map unit (provisional), the 100 km continent and 1,600 m peaks unchanged, no compression
of geography, dragon travel rare, the Valley mode preserved.

## 1. Continent dimensions and land area

| Quantity | Value | Source |
|---|---|---|
| Map | 1,000 x 1,000 units = **100 x 100 km** (10,000 km²) | `world/config/coordinates.json` |
| Land | **8,399 km²** (84 %); sea 1,601 km² | blueprint, 500 x 500 samples of 200 m |
| Land extent | units 16-994 (W-E) x 14-984 (N-S): about **98 x 97 km** | blueprint |
| Coastline | about 300 km (1,629 coastal samples x 200 m; a coarse estimate) | blueprint |
| Elevation | -14 m to 1,675 m before the summit cap (Skyfall Summit about 1,600 m); mean land 313 m | blueprint |
| Simulation | 1 m cells: 10¹⁰ cells, 152,881 regions of 256 x 256 m | `World.ts`, coordinates |

Land area by region (km²): Elderwood 1,600 · Whispering Marshes 1,529 · Dragon Peaks 1,468 · Golden Plains 1,410 ·
Hollow Lands 1,213 · Heartlands 1,180.

## 2. Walking distances between villages

Routes come from the route planner (`src/world/navigation.ts`). It follows roads, crosses rivers only at bridges, and
avoids lakes, the sea and dragon nests. Climb was measured along the route on the 1 m terrain in 10 m steps where
marked; the others (`*`) are estimated as the blueprint climb plus 12 m per km of rolling ground (the rate the three
measured routes show).

Walking time uses 5 km/h on paths plus 1 hour per 600 m of climb (Naismith's rule). Jog: 10 km/h. Horse: a
sustained trot of 15 km/h (a gallop cannot be held for hours). Dragon: 108 km/h (30 m/s) in a straight line.

| Between | Straight | Route | Climb | Walk | Walking days (8 h) | Jog | Horse | Dragon |
|---|---|---|---|---|---|---|---|---|
| Lumenfall – Greenhaven | 22.0 km | 26.4 km | 324 m | 5 h 49 | 0.7 | 2 h 55 | 1 h 46 | 12 min |
| Lumenfall – Frostwatch | 22.1 km | 23.8 km | 974 m | 6 h 23 | 0.8 | 3 h 11 | 1 h 35 | 12 min |
| Lumenfall – Marshlight | 22.7 km | 26.4 km | 244 m | 5 h 41 | 0.7 | 2 h 51 | 1 h 46 | 13 min |
| Lumenfall – Windmere | 39.5 km | 45.2 km | ~640 m* | 10 h 06 | 1.3 | 5 h 03 | 3 h 01 | 22 min |
| Lumenfall – Moonrest | 27.2 km | 48.1 km | ~770 m* | 10 h 55 | 1.4 | 5 h 27 | 3 h 12 | 15 min |
| Greenhaven – Frostwatch | 36.4 km | 50.2 km | ~1,180 m* | 12 h 00 | 1.5 | 6 h 00 | 3 h 21 | 20 min |
| Greenhaven – Marshlight | 32.1 km | 45.9 km | ~580 m* | 10 h 09 | 1.3 | 5 h 04 | 3 h 04 | 18 min |
| Greenhaven – Windmere | 17.7 km | 18.8 km | ~290 m* | 4 h 14 | 0.5 | 2 h 07 | 1 h 15 | 10 min |
| Greenhaven – Moonrest | 20.5 km | 21.7 km | ~430 m* | 5 h 03 | 0.6 | 2 h 31 | 1 h 27 | 11 min |
| Frostwatch – Marshlight | 43.9 km | 50.2 km | ~640 m* | 11 h 06 | 1.4 | 5 h 33 | 3 h 21 | 24 min |
| Frostwatch – Windmere | 50.4 km | 69.1 km | ~940 m* | 15 h 23 | 1.9 | 7 h 42 | 4 h 36 | 28 min |
| Frostwatch – Moonrest | 26.2 km | 34.5 km | ~500 m* | 7 h 45 | 1.0 | 3 h 52 | 2 h 18 | 15 min |
| Marshlight – Windmere | 47.8 km | 64.7 km | ~930 m* | 14 h 30 | 1.8 | 7 h 15 | 4 h 19 | 27 min |
| Marshlight – Moonrest | 46.8 km | 67.5 km | ~1,070 m* | 15 h 17 | 1.9 | 7 h 39 | 4 h 30 | 26 min |
| Windmere – Moonrest | 27.0 km | 40.0 km | ~650 m* | 9 h 05 | 1.1 | 4 h 32 | 2 h 40 | 15 min |

The nearest villages are half a day's walk apart; the far pairs are two days. Routes are 1.05-1.8 times the straight
line. Moonrest and Windmere are the most remote, because the roads go round the Elderwood and the marshes.

These are real-world times. If the game clock runs faster than real time, they shorten in game time but not in player
time. Mounts, running with stamina and discovered-route travel are the planned ways to cover the distance (not built
yet; see section 7).

## 3. Streaming memory

Typed arrays in continent mode, counted directly from the running engine (Node):

| Part | MB |
|---|---|
| Water simulation (13 arrays of 4 bytes per cell over the 768 x 768 m window) | 29.3 |
| Region cache (24 generated regions, about 0.9 MB each) | 21.3 |
| Shading cache (glyph and colour per cell) | 6.2 |
| Window terrain (`World`: height, material, cover, moisture, solids) | 5.6 |
| Window copy of water levels, water kinds and biome | 3.4 |
| Blueprint (200 m design grid) | 3.3 |
| Objects (trees, rocks: 400-8,000 in the window) | 2.3 |
| **Total typed arrays** | **71.5** |

The process grew by 92.5 MB of resident memory when continent mode started. In the browser the JavaScript heap was
55-70 MB at 16 locations (typed-array memory is counted separately by Chrome). Memory is **bounded**: the window is
always 3 x 3 regions and the cache is capped at 24 regions, however far the player travels (the streaming test checks
this after many moves). The whole continent at 1 m would need about 730 GB, so the six regions are never built at
full detail together.

## 4. Terrain generation and streaming performance (this container only)

| What | Measured |
|---|---|
| Region generation, 256 x 256 m, by biome core (Node, average / slowest of 9) | Elderwood 74 / 81 ms · Golden Plains 79 / 85 · Heartlands 95 / 124 · Dragon Peaks 110 / 164 · Hollow Lands 110 / 121 · Whispering Marshes 173 / 200 |
| Region generation at borders (patch transitions; average / slowest of 9) | Heartlands–Plains 124 / 158 ms · Elderwood–Heartlands 161 / 235 · Peaks–Heartlands 169 / 216 · Heartlands–Marshes 201 / 221 |
| Region generation in the browser worker (slowest) | 130-153 ms |
| Window move (3 regions in; terrain, shading cache, objects, water, camera), browser with worker | slowest 23-25 ms (main thread) |
| Window move in Node without a worker (generation on the same thread) | slowest 46-57 ms over a 6 km journey (28 moves) |
| Boot into continent mode (blueprint, 9 regions, engine), browser | 1.5-2.4 s |
| Frame in the browser at 16 locations (6 biomes, 10 borders) | 60 fps; compose 1.0-1.5 ms; present 0.05-0.2 ms |
| Frame while travelling at the 300 m/s test speed | 59 fps; compose 8.8 ms (new strips are shaded within a 4 ms budget per frame) |

Budget targets from the streaming design: generation under 300 ms per region (met), a move under 50 ms on the main
thread (met in the browser). A dragon at 30 m/s needs three regions every 8.5 s; generation takes about 0.6 s for
three. The natural biome transitions (section 6) added 20-70 ms per region. To keep moves quick, the worker now takes
one region at a time from a queue, and a region a move is waiting for jumps the queue.

## 5. Water persistence and flow between regions

What happens now:

- **Inside the window, water is continuous.** It is one simulation over the 768 x 768 m window. Rivers enter through
  sources and leave through drains at the window edge (`riverPorts`). Lakes and the sea are filled to their levels;
  marsh pools and channels are filled to flat levels.
- **When the window moves, water moves with it (new in this increment).** Depth, flow, ripples and the sleep state are
  carried across exactly (`WaterSim.shift`). Before, velocities and ripples restarted after each move. Only the
  newly loaded strip starts fresh, with its rivers, lakes and pools full.
  Test: 393,151 cells carried bit for bit; Lumen river speed 0.44 m/s before a move and 0.43 m/s two seconds after.
- **Rivers keep flowing.** The Lumen holds its volume within ±25 % over 10 s through the window (measured -3 % earlier).
  Dry land stays dry: under 2 % of land cells get more than 0.3 m of water.
- **Water is conserved.** Every transfer is exact. Water leaves only through drains, evaporation of thin films and the
  strip that leaves the window, and enters only through sources and the new strip. All of it is booked in the ledger.
- **Settled water sleeps (new).** A 16 x 16 m chunk whose water has stood still for one second stops being simulated
  until something reaches it (inflow, an edit, rain). Near-still water also gets drag like reeds would give, so pools
  settle in seconds. Both apply to continent mode only. The Valley simulation is unchanged, bit for bit (golden
  images).

Measured cost of water per simulation step (worker, browser, this container):

| Place | Water in window | Step cost |
|---|---|---|
| Heartlands, plains, forest, peaks, Hollow Lands | none or small streams | 0.03-0.07 ms |
| Lumen river near Lumenfall | 83,000-87,000 m³ | 3.9-4.7 ms |
| Marsh border | 6,000-11,000 m³ | 1.4-2.5 ms |
| Marsh core (16 % open water) | 69,000 m³ | 12 ms at load; settles to about 1 ms after 30 s (Node: 27 → 1 ms) |

Persistent (since the persistence milestone, `src/world/edits.ts`):

- **Changes are kept per region.** When a region leaves the window, its difference from generation is recorded:
  - changed cells (height, material, cover, moisture, magic)
  - generated objects removed, and objects added or changed
  - water standing on ground that is dry when generated (ponds you made)
  - your sources and drains

  When the region comes back, the difference is put back. Rivers, lakes and pools regenerate (they are not stored).
- **Continent saves** (`src/world/continentSave.ts`) hold the view position, zoom, weather and time, and every
  region's changes. They live in their own slots (database `lumenwild-continent`), never among Valley saves.
  Save, load, autosave, export and import work as in the Valley. A save made with different world files or a different
  generator loads with a warning.
- Tests: `tests/world-persist.test.ts` (5) and `e2e/m15-continent-save.spec.ts`.

Not persistent yet:

- **No water outside the window.** Rivers beyond the window are not simulated; they re-enter as fresh water.
- **After a move, the new strip and the chunks beside it are awake again**, so a large marsh costs more for a few
  seconds after each move.

## 6. Biome transitions: visual or only in the data?

**Before this increment** (screenshots `biomes-before.jpg`): the six regions differed on the blueprint but much less on
the playable terrain. Elderwood looked distinct. The Hollow Lands differed partly. The Golden Plains looked like the
Heartlands. The Whispering Marshes had no water. The Dragon Peaks had no snow, scree or cliffs below 1,180 m.

**Now** (`biomes-after.jpg`, `biome-borders.jpg`): each region has its own ground, cover, relief, trees, rocks and
water on the 1 m terrain:

| Region | On the playable terrain |
|---|---|
| Dragon Peaks | Snow above about 1,030 m (lower on north faces), scree and bare rock below it, alpine meadow, pine forest below 700-800 m, rock steps (shelves and cliff bands) on the high ground. Measured: snow 50 %, scree 24 %, stone and cliff 27 % at the high sample; 696 pines and 229 birches in a valley |
| Hollow Lands | Ash, bare dirt, stone and scree; thorn scrub; dead trees (77 %); jagged rock formations; terraced mesas; ember cracks that glow red along the Rift of Shadows and Crimson Fissures |
| Whispering Marshes | Open pools and meandering channels (16 % of the core is water), bog at the water's edge, reed beds (40 % of cover), willows and dead snags (22 % of trees) |
| Golden Plains | Dry golden grass (86 %), wind-combed golden cover, wildflower drifts, lone oaks and birches, weathered rock outcrops |
| Heartlands | Green grass and meadow with clover and flowers, copses of oak, birch and blossom |
| Elderwood | Dense mixed forest (7,600 trees in 768 x 768 m), forest floor and moss, ferns, leaf litter, mushrooms |

Tests: `tests/world-biomes.test.ts` (8) compares every pair of regions by ground and cover (distance 1.24-4.0 on a
0-4 scale) and by ground colour, and checks each region's features. `e2e/m14-biomes.spec.ts` loads each region in
the browser and checks that the rendered colours differ (closest pair: marsh and Hollow Lands, 17).

**Transitions** (natural patches since 2026-11-25; comparisons in `transitions-close.jpg` and
`transitions-distant.jpg`, before on the left and after on the right, for Elderwood/Heartlands,
Heartlands/Golden Plains, Dragon Peaks/Heartlands and Heartlands/Whispering Marshes).

Each border mixes the two biomes over 500 m or more. Before, every cell picked its biome by an independent random draw,
so borders looked speckled. Now (`src/world/ecotone.ts`, used once per cell at generation, never per frame):

- **Patches.** The share of each biome at a spot comes from the blueprint, and a smooth, domain-warped noise picks
  within those shares. Neighbouring cells agree, so the border breaks into irregular patches tens of metres across.
  A biome's patches thin out as its share falls.
- **Ecology.** Shares are tilted by elevation, slope (of the smooth ground over 8 m) and wetness (near rivers, lakes,
  the marsh, the coast and valley floors):
  - forest spreads along damp ground
  - marsh spreads into wet flats
  - plains spread onto dry flats
  - peaks and the Hollow Lands spread up steep ground

  Where a biome's blueprint weight is below 8 %, it takes no part, so cores stay pure and distant regions send no
  islands.
- **Ground colour.** Each cell leans toward the neighbouring biome's ground colour, by that biome's share. At a patch
  edge it leans further, half-way over a few metres, so patches have soft rims. The renderer applies this only in
  continent mode, and only while the cell keeps its generated material, so edits and the Valley are unaffected.
- **Vegetation.** Ground cover comes in clumps of a few metres instead of single cells. Tree density is set mostly by
  the patch (forest patches are denser), plus a share-weighted blend. Groves and clearings of about 140 m and a coarser
  species patch let stands of one biome's trees reach into the next.

Measured in 768 x 768 m windows (`tests/world-transitions.test.ts`, 9 tests). "Before" is the previous commit
measured the same way on Elderwood–Heartlands; "after" covers all four borders:

| Measure | Before | After |
|---|---|---|
| Land cells that differ from all four neighbours | 6.6 % | 0.001 % |
| Alternating (checkerboard) 2 x 2 blocks | 11.8 % | 0.001 % |
| Cells in specks or islands under 25 m² | 41 % | 0.03-0.07 % |
| Mean run between biome changes along a row | 2 m | 47-65 m |
| Ground-colour jump where the biome changes (palette mid tones) | 44.7, at 1.1 million edges | 4.8, at 42,000 edges |

Also tested:
- Determinism: a fresh generator gives identical biomes, ground, cover, blend and trees.
- Patches meet across region edges like any other line.
- The second biome's share changes by at most 22 points between neighbouring 64 m bands.
- Peaks patches are 1.35 times as common on steep ground as on flat ground.
- Forest patches hold 1.5 times the trees per area of the meadow beside them, and each biome's trees appear on the
  other's ground (363 pines and willows on Heartlands ground, 363 blossoms on Elderwood ground).

Still missing: per-biome weather, sounds and wildlife; a seasonal snowline. The Hollow Lands glow only near the two
fissures. Where three regions are close (Peaks, Heartlands and Hollow Lands near 560,296), patches of the third appear
in proportion to its share.

## 7. Current limitations of continent mode

1. **Saving is region diffs.** Moving water is not saved, only ponds on dry ground. Undo history is cleared when the
   window moves.
2. **No villages at 1 m.** Village sites are kept clear and roads are drawn on the ground, but there are no buildings,
   bridge structures, watchtowers or landmarks yet (Phase 3). Roads ford rivers at the blueprint's bridge points.
3. **No travel gameplay.** The Continent panel's "travel" moves the view along a planned route at a chosen speed, for
   testing. Walking, running with stamina, mounts and discovered-route travel are design items, not code.
4. **No dragons or wildlife in the continent** (Phase 4). The Valley keeps its dragon. Dragon flight on the continent
   will follow the Southern Sky Corridor rules (rare, at least 450 m above villages).
5. **Water cost in marshes and along big rivers** (section 5). Hosts without cross-origin isolation (the published
   artifact page) run water on the main thread, where 4-12 ms per step lowers the frame rate near large water.
6. **The view is 768 x 768 m.** There is no distant terrain or horizon beyond the window. Heights are drawn at a
   reduced relief scale (0.35) so mountains fit the oblique view. Long climbs keep the starting height datum.
7. **Fast travel can outrun generation.** At the 300 m/s test speed, a move can wait for a region (counted as a stall).
   At dragon speed (30 m/s) the worker keeps up with margin.
8. **Rocks can overlap water cells** at their edges. The water there is displaced when obstacles are rebuilt.
9. **Climb figures** for 12 of the 15 village pairs are estimates (section 2).
10. **Laptop performance is not verified.** All timings are from this container (SwiftShader, 4 cores).

## 8. Compatibility with the 2.5D Valley mode

- The Valley is the default scene, and the top bar switches modes. Continent mode is `?scene=continent`.
- **Rendering and simulation are unchanged.** All 9 golden images match pixel for pixel with both presenters (Canvas
  2D and WebGL2), 18 comparisons in all. The new water options (`sleep`, still-water drag, `shift`) are off or unused in the Valley, so its
  water steps are bit-identical.
- **Saves are unchanged** (format v1). Validation now reads the material and cover lists. New materials (dry grass,
  ash, bog, scree) and covers (golden grass, embers, thorns) extend the lists; old saves load as before. The Inspector
  names the new materials when the cursor is over them.
- **The shared engine** (renderer, shading, objects, water, editor) serves both modes. Continent mode adds the
  streaming hook, shifting of the shading cache, objects and water, and a 768 m world.
- **Biome blending in the renderer** is continent-only: the shader reads `World.blend`, which the Valley never
  allocates, so the Valley's shading code path and its golden images are unchanged.
- Tests: **167 unit** (145 before, plus 8 biome, 3 water-sleep, 2 streaming and 9 transition) and **60 browser** (59
  before, plus the biome test); all pass.

## Next: Phase 3 readiness

Ready: the terrain, biomes, water, streaming and routes that villages, bridges and landmarks will sit on.

Needed from you before Phase 3:
- Inspector → Benchmark on the laptop, plus the continent's frame rate there (top bar → Continent; also try
  `?scene=continent&at=740,790` for the marsh and `&at=495,520` for the Lumen).
- A look at the new border comparisons (`transitions-close.jpg`, `transitions-distant.jpg`).
