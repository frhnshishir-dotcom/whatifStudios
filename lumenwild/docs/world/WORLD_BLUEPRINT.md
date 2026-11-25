# Phase 1: world map blueprint (approved; updated for the Phase 2 decisions)

> **Phase 2 decisions applied (2026-11-25):** no cities; six villages (Lumenfall Village, Greenhaven, Frostwatch
> Village, Marshlight, Windmere, Moonrest) of 10-30 buildings; Riverwatch Tower and Sunspire Watchtower; 100 m per map
> unit (provisional) and 1 m cells; the Southern Sky Corridor is migration airspace with a no-low-flight radius over
> villages. Rivers now pass 200-800 m from every village. Tables below that predate these decisions are superseded by
> `docs/world/SCALE_AND_STREAMING.md` and the world files.

Preview: `docs/world/world-blueprint.png` (designer view) and `docs/world/world-player-start.png` (what a new player
sees). In the app: map icon in the top bar → "World blueprint" / "Player view at start".
Nothing here is playable terrain yet. All data is editable in `lumenwild/world/`; `npm test` validates it and runs the
geography checks (41 checks, all passing; `tests/world-blueprint.test.ts`, 13 tests; `e2e/m12-world-map.spec.ts`).

## 1. Data model and directory (`lumenwild/world/`, JSON, schema version 1)

```
world/
  config/       world.json (id, seed, schema version)  coordinates.json  regions.json
  geography/    coastline.json  mountain-ranges.json  elevation.json (basins, plateaus, fissures, detail)
                lakes.json  rivers.json (paths, widths, falls, mouths, distributaries)
  settlements/  settlements.json (city, villages, outpost; spec or proposed)
  landmarks/    landmarks.json (region, kind, discovery: known / rumoured / hidden, visibleFrom, fantastical)
  roads/        roads.json (class, stops by id or coordinate, pass)
  creatures/    habitats.json (region, species, radius, density)
  dragons/      territories.json (dragon identity, nest, altitude band, awareness, hunting grounds)
                flight-routes.json (corridor graph, clearance, ceiling, minimum height over settlements)
  discovery/    discovery.json (fog cell size, start area, known at start, reveal radii)
```

- Types and validation: `src/world/schema.ts` (stable kebab-case ids, unique across all files; every reference
  resolved; coordinates within 0-1000; places inside their region's approximate bounds).
- Loader: `src/world/data.ts`. Rendering code never contains world data.
- The Part J layout is followed, merged where one file is clearer (for example cities, villages and outposts are one
  `settlements.json` with a `kind`).

## 2. Coordinate system (`world/config/coordinates.json`, `src/world/coords.ts`)

| System | Definition | Conversion |
|---|---|---|
| Map | 0-1000, x east, y south, north at y = 0 | design units used by every data file |
| Metres | map x `metresPerMapUnit` (**proposed 10**, decision 3) | `mapToMetres` |
| 3D world | x east, y up (elevation, m), z south; 1 unit = 1 m | `mapToWorld3D`, `world3DToMap` |
| Terrain cell | 2 m (the valley's cell) → 5,000 x 5,000 cells | `mapToCell`, `cellToMap` |
| Chunk | 16 x 16 cells (existing water/terrain/object chunk) → 313 x 313 | `cellToChunk` |
| Region | 256 x 256 cells (one `World`, the streaming unit) → 20 x 20 | `cellToRegion`, `regionId` (`r9-9` holds Lumenfall) |
| Prototype | the whole map in one 256 x 256 `World` (about 39 m cells) | `mapToPrototype` |
| Blueprint | 2 map units per sample (500 x 500) | `mapToBlueprint` |

Rendering tiles (64 m), creature cells (128 m) and navigation cells (8 m) are separate settings, so rendering
chunks and simulation chunks are never the same thing by accident.

## 3. Regions and elevation design

Membership: each region owns the land nearest its anchors (after a gentle noise warp); base elevations are tilted
planes blended over about 100 map units, so transitions are gradual. Authored layers then add:

| Layer | Content |
|---|---|
| Mountain ranges (6) | Skyfall Range (crest to 1,600 m at Skyfall Summit), Frozen Crown Spur, Ember Ridge (volcanic), Hollow Spine (jagged), Elder Highlands, Golden Downs; crest heights interpolate along each ridgeline; style sets ruggedness |
| Basins and plateaus | King's Basin bowl; Skyfall plateau; terrain corrections for the Lumenfall terrace and the Frostwatch shelf |
| Magical features | Rift of Shadows trench, crimson fissures (drawn glowing red); floating islands, giant trees, crystals and the glowing Emberfall are landmarks, never random clutter |
| Coast | authored outline, smoothed, with a natural ragged edge; land slopes to the sea over 55 units |

Measured elevations (10th / 50th / 90th percentile, m): Dragon Peaks 375 / 809 / 1,284; Elderwood 141 / 297 / 547;
Heartlands 76 / 119 / 250; Whispering Marshes 8 / 29 / 65; Golden Plains 17 / 103 / 211; Hollow Lands 190 / 412 / 708.
Each region holds 13-19 % of the land. The whole landmass is one piece: 100 % of land connects to Lumenfall, and all
six regions are reachable on foot.

## 4. Rivers and lakes

| River | From → to | Measured |
|---|---|---|
| Lumen River | Skyglass Lake (840 m) → Emberfall (177 m drop, gorge below) → foothills → King's Basin → past Lumenfall → King's Bridge → splits | surface never rises; largest barrier crossed 11 m |
| Lumen branches | marsh branch and delta branch to the southern coast | reach the sea |
| Moonwater Stream | Moonlit Lake → King's Basin | joins at the lake level |
| Ashen Run | Hollow Spine south-west flank → past Ashen Cathedral → Lumen | 45 m fall in the Hollow Lands |
| Goldenbrook | Golden Plains (by Windmill Fields and Greenhaven) → Lumen | joins at the Lumen's level |
| Witchwater Channels | marsh interior → Witchwater Pool → sea | reaches the sea |
| Frostmelt Brook (added) | Frozen Crown → Frostwatch → Lumen | gives the outpost water; three cascades |

Rules enforced: water surfaces are non-increasing downstream; tributaries never cut below the water they join; every
river ends in the sea, a lake or its parent; a route that would have to climb more than 60 m fails the check. Lakes
sit just below their lowest rim point. Lake levels: Skyglass 840 m, Moonlit 265 m, King's Basin 121 m, Witchwater 12 m.

## 5. Settlements and roads

| Settlement | Region | Ground slope | Fresh water | Roads |
|---|---|---|---|---|
| Lumenfall City (500, 510) | Heartlands | 6 % | 14 units | 4 |
| Greenhaven (330, 650) | Heartlands | 6 % | 20 | 3 |
| Frostwatch Outpost (430, 300) | Dragon Peaks foothills | 11 % | 5 | 1 |
| Marshlight (650, 680) | Whispering Marshes | 5 % | 30 | 1 |
| Windmere (175, 735), proposed | Golden Plains | 5 % | 18 | 1 |
| Moonrest (215, 470), proposed | Elderwood | 5 % | 23 | 1 |

Roads are routed by the existing A* over the blueprint (slope cost, river crossings, avoiding dragon nests):

| Road | Length / straight line (units) | Max grade | Bridges |
|---|---|---|---|
| King's Road (Lumenfall → King's Bridge → Greenhaven → Windmere) | 462 / 426 | 7 % | King's Bridge, Goldenbrook |
| Northern Expedition Route (→ Frostwatch → camp below Skyglass Lake) | 485 / 303 | 40 % on the pass (switchbacks) | Lumen, Moonwater, Frostmelt |
| Eastern Trade Route (→ Hollow Gate) | 191 / 174 | 11 % | none |
| Marsh Road (→ Old Watchtower → Marshlight) | 270 / 255 | 9 % | Ashen Run |
| Merchant Road, Moonrest Trail (proposed) | 273, 225 | 7 %, 11 % | Goldenbrook |

## 6. Dragon territories and flight corridors

| Territory | Dragon (persistent id) | Nest elevation | Landing sites | Notes |
|---|---|---|---|---|
| Skyfall Summit | Aurath, elder storm dragon (`dragon-aurath`) | 1,469 m | 4 | highest nest |
| Ember Nest | Emberfang, obsidian fire dragon (`dragon-emberfang`) | 1,268 m | 4 | the valley's existing dragon |
| Frozen Crown | Rimeclaw, frost dragon | 1,105 m | 4 | above Frozen Caverns |
| Elderwood Canopy | Mossheart, forest drake | 341 m | 4 | low-altitude canopy flyer |
| Ashen Rift | Ashmaw, corrupted dragon | 406 m | 4 | beside the Ashen Cathedral |
| Southern Sky Corridor | shared airspace, no nest | — | — | 50 units from Lumenfall (decision 4) |

Corridors (7 edges) get a cruise altitude of the highest ground along them plus 150 m (Skyfall–Frozen Crown 1,723 m;
the two corridors into the southern sky 496-557 m), all under the 2,600 m ceiling, and never lower than 450 m over a
settlement. Each dragon record carries the fields the specification lists; health, hunger, fatigue, current target
and behaviour state are runtime state (Phase 4), saved per creature id.

Behaviour states: the specification's 15 states (IDLE ... INJURED) become a **behaviour layer** above the existing
locomotion states (TAKING_OFF, FLYING, GLIDING, CIRCLING, DESCENDING, LANDING, WALKING, AVOIDING_OBSTACLE...), which
already guarantee no teleporting, terrain clearance and suitable landings. New: HUNT, MIGRATE, THREATENED, ATTACK,
DEFEND_NEST, FLEE, INJURED, health, and multiple dragons with simulation budgets (tiered update rates by distance).

## 7. Discovery (Part H)

`src/world/discovery.ts`: a 5-unit fog bitmap per player (about 5 KB as base64), discovered places, known routes,
`reveal` (walking), `observe` (tall landmarks seen from `visibleFrom`), exploration percent per region, and save /
load. A new player starts with the city's surroundings, Greenhaven, King's Road and King's Bridge revealed
(Heartlands 8 % explored, every other region under 1 %); rumoured places appear as "?" markers; hidden ones (Ember Nest,
Frozen Caverns, Drowned Temple...) only when found. No barriers between regions.

## 8. Phased implementation plan

| Phase | Delivers | Acceptance tests (from Part L) |
|---|---|---|
| 2. Terrain prototype | Region generator: blueprint elevation, rivers and biomes → 256 x 256 regions with the valley's detail passes; prototype of the whole map in one coarse `World`; region streaming (3 x 3 window, worker generation) | 1 connected geography, 2 reachable regions with no loading screens, 3 coherent elevation, 4 connected rivers, 11 water and persistence intact, 13 reproducible |
| 3. Landmarks and settlements | Lumenfall, Greenhaven, Frostwatch, Marshlight built from the village engine; roads and bridges as terrain; landmarks and ruins | 5 city access, 6 roads follow terrain |
| 4. Ecosystem and dragons | Entity store, habitats and wildlife; the five dragons with the behaviour layer, corridors and landing sites | 7 biome-appropriate wildlife, 8 territories, 9 dragons fly and land without passing through terrain |
| 5. Multiplayer | Server-authoritative regions, creatures and discovery | 14 consistent world data |
| 6. Optimisation | Streaming, memory, frame rate, water and creature budgets on the laptop | 12 performance on the target hardware |

## 9. Performance and compatibility risks

| Risk | Mitigation |
|---|---|
| 400 regions at 2 m cells: storage and generation time | Regions are generated from the seed and blueprint on demand; only edits are saved |
| Water across region borders | Edge exchange between loaded regions; unloaded rivers held at their blueprint level |
| Integrated graphics with a 3D view over a 10 km world | Distance LOD, instancing, chunked culling; the 2.5D view stays the fallback |
| Blueprint resolution (20 m) hides small features | It is a design layer; regions add 2 m detail; checks run at both levels |
| Authored coordinates fight the terrain | The checks report exactly where (slope, water, region, grade); terrain corrections are data, not code |
| Two continent systems | The earlier draft stays read-only until decisions 1-3 settle; then one system remains |

## 10. Decisions needed

1. **Lumenfall City**: confirm a city is wanted (it reverses "no cities"). The blueprint keeps it compact (radius 16 units).
2. **Windmere and Moonrest**: keep as secondary villages (shown as proposed), or drop. Moonrest had to move out of the Elderwood Canopy territory.
3. **Scale**: 10 m per map unit (10 km continent, believable 1,600 m mountains, 400 regions), or smaller with lower mountains.
4. **Southern Sky Corridor**: keep as shared high airspace with no nest (as blueprinted), or move it away from the city.
5. **Names**: the specification has two "Old Watchtower" landmarks; ids keep them apart, but the names should differ.
6. **Additions**: Frostmelt Brook (water for Frostwatch), the Hollow Gate end of the Eastern Trade Route, and the terrain corrections at Lumenfall and Frostwatch. Approve or replace.
