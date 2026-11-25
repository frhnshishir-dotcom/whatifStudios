# Phase 3b: villages and bridges at 1 m

Status on 2026-11-25. Figures come from this container (Node 22; headless Chromium with SwiftShader). Nothing here is
measured on the target laptop.

The approved biome transition system (commit `baa9516`) is unchanged. Villages and bridges are drawn over the
generated terrain afterwards. Persistence (Phase 3a) treats them as part of generation, so a fresh window records no
player changes.

## What is built

| Village | Culture | Buildings (range) | Structures | Lanes | Plots |
|---|---|---|---|---|---|
| Lumenfall Village | heartlands timber | 30 (24-30) | 34 (well, inn, market hall, smithy, 3 stalls, shrine, water mill, stable, workshop, 16 homes, 3 farmhouses, 3 barns, granary) | 6 | 33 fields |
| Greenhaven | heartlands timber | 25 (20-26) | 29 | 6 | 32 fields |
| Frostwatch Village | frost lodge | 17 (12-18) | 18 (fire pit, longhouse, trading post, smithy, 9 cabins, storehouses, smokehouse, mine head, watch post) | 5 | 16 pastures |
| Marshlight | marsh stilt | 13 (10-15) | 14 (lantern deck, longhouse, herbalist, 7 stilt houses, fishing huts, net shed, smokehouse) | 5 | — (ponds are the marsh) |
| Windmere | plains farmstead | 18 (15-22) | 19 (well, trading post, tavern, granary, homes, 5 farmhouses, 4 barns, stable, 3 windmills) | 4 | 37 fields |
| Moonrest | elder grove | 16 (10-16) | 17 (moonwell, elder hall, woodcarver, 4 tree houses, 9 root houses, storehouse) | 5 | 67 gardens |

| Road bridge | River | Length |
|---|---|---|
| King's Road | Lumen | 84 m |
| King's Road | Goldenbrook | 21 m |
| Northern Expedition Route | Lumen | 71 m |
| Northern Expedition Route | Frostmelt Brook | 16 m |
| Marsh Road | Ashen Run | 34 m |
| Merchant Road | Goldenbrook | 21 m |

Pictures: `villages-close.jpg` and `villages-mid.jpg` (all six villages and two bridges, at two zoom levels).

## How it works

- **Plan** (`src/world/villages.ts`): one plan per settlement, made once and cached. Each plan has:
  - a square with the culture's communal feature (well, fire pit, lantern deck, moonwell)
  - lanes toward each road exit, then into the widest gaps
  - buildings from the culture's programme (the draft village engine's `CULTURES` and `SPECS`), counted into the
    settlement's building range from `world/settlements/settlements.json`
  - farmland: fields, pasture or gardens

  Placement keeps buildings inside the footprint, 1 m apart, off lanes and roads, off water and within the culture's
  slope tolerance. A plan is a pure function of the world files and the smooth ground and water
  (`ContinentTerrain.siteQuery`), so the worker and the main thread make the same plan. Plans take 5-35 ms each.
- **Drawing** (`ContinentTerrain.buildSettlements`, after materials and trees): fields as crop rows (dirt furrows and
  crops), pasture or gardens, then the square and lanes as paths, then levelled pads under buildings. A pad is
  levelled from its own region's ground and never crosses a region edge, so regions stay seamless. Building objects
  sit in the region holding their corner. Stilt houses, tree houses and decks keep the ground as it is.
- **Buildings** (`building` object, `src/engine/objects/defs.ts`): one parametric sprite. It draws a base (stone
  plinth, stilts or roots), walls with windows and doors over 1-3 storeys, and a gabled roof sized to the footprint,
  in the culture's colours. Signs, forge glow, mine mouths, shrines and chimneys go by type. Wells, stalls, fire pits,
  decks, windmills, watch posts and tree houses have their own shapes. Lumenfall's and Greenhaven's mills reuse the
  water mill object, with the wheel toward the river.
- **Bridges** (`span` object): at each blueprint crossing, the road's path is followed to where it is actually in the
  river. The deck runs across the river along the axis nearer the river's normal, from bank to bank plus 4 m onto each
  bank. It is 3 m wide, has railings and piers every 8 m, and sits above the river surface. Trees and rocks are kept
  off decks and approaches. Water flows underneath (bridges are not solid).
- **Persistence**: generated objects carry their properties (deck heights are stored absolute and placed relative
  to the window's datum), so edits are measured against them correctly. The generator version is bumped, so older
  continent saves load with a warning.

## Tests

`tests/world-villages.test.ts` (6) checks:
- building counts within range, with each culture's signature buildings, and plans that are deterministic
- no overlaps, buildings inside the footprint, level pads on dry ground that stay inside one region
- each building as an object in the right region and style
- every type drawable in every culture
- every blueprint bridge built, wet in the middle, dry at both ends and above the water
- a fresh Lumenfall window with no player changes

`e2e/m16-villages.spec.ts` checks that Lumenfall loads with buildings, mill and paved square, and that the Lumen
bridge is drawn. All tests pass: 178 unit, 62 browser.

## Not yet

- Landmarks (Riverwatch Tower, Sunspire Watchtower) and ruins.
- Villagers and daily schedules (the draft engine has population and roles; they are not on the 1 m continent yet).
- Building orientation: all buildings face south, with the front row toward the viewer.
- The lane layout is a star of near-straight lanes from the square. Winding, contour-following streets are a
  refinement.
- Bridge approaches are not ramped (the deck sits about a metre above the banks), and the deck is drawn at one height.
- Doors and interiors; nothing can be entered.
