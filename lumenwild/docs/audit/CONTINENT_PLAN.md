# Continent and settlements: what is built, and the plan to make it playable

## 1. Built now (design layer; the playable game is unchanged)

`src/engine/continent/` generates the whole continent as **design data**, deterministically from a seed, in about
1.7 s (Node). It does not touch the playable valley. Preview: top bar → map icon (Continent dialog: overview map,
a close-up of each village, land-use figures). Screenshots: `docs/screenshots/continent/`.

Scale assumption: the brief's coordinates are world cells (the current cell, about 2 m), so the continent is
1024 x 1024 cells, about 2 km across, north up.

| Module | Contents |
|---|---|
| `terrain.ts` | Landmass, six biomes (Heartlands, Dragon Peaks, Golden Plains, Whispering Marshes, Elderwood, and the village-free **Thornwild** in the east), height, tree cover |
| `hydrology.ts` | Silverrun, Amberflow and Thornbrook from springs to the sea (beds never rise; designed falls with gorges), four lakes, marsh pools, cave mouths |
| `wilds.ts` | Four dragon territories with lairs (Emberfang's Reach, Thornmaw Hollow, Mirewyrm Fen, Elderwing Roost), eight wildlife habitats |
| `cultures.ts` | Five architectures (walls, roof, foundation, layout, signature buildings, palette), building programmes, farmland, trades |
| `villages.ts` | Village layout: centre, lanes (contour-following, boardwalks, woodland paths), buildings by zone, patchwork farmland, pens, households and jobs |
| `population.ts` | Daily routines per occupation; reactions to rain, storms, wildlife and dragons; where each activity happens |
| `sites.ts` | Ruins, dungeons, landmarks, lairs, abandoned hamlets; ranger cabins, hunter camps, mountain shelters, watchtowers, travellers' camps |
| `trails.ts` | Terrain-following paths (A* with slope, forest, marsh, river and territory costs), bridges and fords, ancient roads |
| `generate.ts`, `mapRender.ts` | Orchestration, land-use map and statistics; map and village renderers |

### Villages (seed 1)
| Village | Biome | Buildings (target) | Villagers | Architecture | Signature |
|---|---|---|---|---|---|
| Greenhaven (390, 510) | Heartlands | 25 (20-30) | ~60 | whitewashed timber frame, thatch, fieldstone; square and lanes | market hall, inn, smithy, water mill, field patchwork |
| Frostwatch (430, 300) | Dragon Peaks foothills | 15-18 (10-20) | ~20 | logs on dry stone, steep snow-laden slate, half-sunk stone; terrace cluster | hunters' longhouse, mine head, smokehouse, watch post, tarn |
| Windmere (190, 760) | Golden Plains | 18-21 (15-25) | ~45 | whitewashed cob, red tile, thatched barns; linear street | three windmills, barns, granary, trading post, pens, largest fields |
| Marshlight (690, 700) | Whispering Marshes | 12-15 (10-15) | ~20 | reed and plank, steep reed thatch, stilts; boardwalk spine | stilt houses over the marsh, fishing huts, lantern deck, herbalist, fish ponds |
| Moonrest (260, 390) | Elderwood | 12-15 (10-20) | ~30 | living wood, moss and bark roofs, roots; grove | tree houses on great trees, root houses, elder hall, moonwell, glade gardens; 0 % ancient forest cleared |

### Measured land use (percent of land; seeds 1-6)
| Seed | Wilderness | Villages, farmland, outposts, paths | Ruins, dungeons, landmarks, lairs |
|---|---|---|---|
| 1-6 | 87.7-88.4 | 6.0-6.3 | 5.6-6.0 |

Paths cover about 0.2 % of the land, and about 94 % of the land is more than 10 cells from any path. Nothing is built
inside dragon territories (disturbance 0-0.08 %, the lair approach only) or habitat cores (0 %).

### Acceptance criteria → tests (`tests/continent.test.ts`, 17 tests; `e2e/m11-continent.spec.ts`)
1. No cities: ≤ 30 buildings and ≤ 110 people per village, ≤ 300 villagers in all, villages > 150 cells apart,
   largest built-up area < 5,000 cells, outposts never clustered.
2. Five villages: at their coordinates (≤ 25 cells), in their biome, building counts in range, near their water and forest.
3. Distinct architecture: walls, roof, foundation, layout and palette all differ; each village has signature buildings no other village has.
4. Wilderness: 85-90 % wilderness, 5-8 % settlements, the rest special locations (seeds 1-3).
5. Roads: paths < 1 % of land, < 15 % of land within 10 cells of a path; village links wind and climb no more than
   the straight line; no path through a lake; a bridge or ford at every river crossing; a mountain pass and ancient roads exist.
6. Populations: 12-110 per village, every village's trades present, every job building staffed; routines tested
   (asleep at 03:00, at work at 10:00, gathering at 19:30, indoors in heavy rain, sheltering from a dragon).
7. Exploration first: > 60 % of special locations and > 40 % of outposts lie more than 15 cells from any path.
8. Undisturbed wilds: < 1 % non-wild use in territories and habitat cores; villages ≥ r + 50 from every territory.

## 2. Plan: make the continent playable (needs your approval: it changes the world architecture)

Today the engine holds one 256 x 256 `World`. The continent is 16 times larger. Loading it whole would cost about
70 MB for the simulation arrays and 16 times the water work, so the proposal is **regions with streaming**.

```
 continent layout (design data, regenerated from the seed, never saved)
        │ constrains
        ▼
 region generator (256 x 256, the existing World size) ── per-region detail: terrain micro-relief, ground cover,
        │                                                  trees, rocks, buildings as objects, paths
        ▼
 RegionStore: 3 x 3 regions loaded around the camera/player (generated in a worker, cached, edits kept as diffs)
        │
        ▼
 Engine: world coordinates in continent space; water simulated in loaded regions (edge exchange between them);
         renderers unchanged (they already read a World)
```

| Step | Delivers | Acceptance tests |
|---|---|---|
| C.1 | Region generator from the layout (height, biomes, water, land use as constraints; existing material, cover and object rules for detail) | Height within 0.5 m of the layout after detail; same water and building cells; deterministic; seams between neighbouring regions continuous (≤ 0.5 m step) |
| C.2 | Village buildings as objects: 2.5D sprites for each building type in each of the five styles (procedural, like the cottage and mill) | Every layout building placed on its footprint; golden image of each village; existing object tests pass |
| C.3 | Streaming: 3 x 3 regions, generation in a worker with neighbour prefetch, camera and dragon across region borders, water exchange at edges | Pan across the continent with no frame over 100 ms (benchmark); memory ≤ 80 MB of simulation and render arrays; water volume conserved across borders |
| C.4 | Save format v2: per-region edit diffs plus the seed; the valley stays loadable | v1 saves load unchanged; edits survive unload and reload; save size grows only with edits |
| C.5 | NPC villagers on the Phase 2 entity system, using `population.ts` routines and the lanes and paths | Villagers sleep, work, gather and shelter as the routine tests require, now in the simulation; walking stays on lanes and paths |
| C.6 | UI: start in Greenhaven on the continent; the valley remains as a sandbox world | e2e: start, travel to each village, open the valley sandbox |

Budgets (8 GB RAM, integrated graphics): simulation and caches for nine regions about 55 MB; region generation
about 250 ms in a worker; water cost as today per loaded region (about 1 ms per step per region, active chunks only).

### Decisions needed
1. Approve the region streaming architecture (C.1-C.6).
2. The valley: keep it as a separate sandbox world (recommended: nothing is lost), or retire it.
3. Scale: 1024 cells is about 2 km across, a walk of roughly 25 minutes. Keep it, or plan for 2048 (4 km, 64 regions)
   later? The layout generator scales; the brief's coordinates would be doubled.
4. Order with the earlier plan: C.1-C.2 can start before or after the 3D steps; C.5 needs the Phase 2 entity store.
