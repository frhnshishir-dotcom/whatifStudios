# Phase 0: architecture reuse report (world map specification)

Source inspected: the development repository (`lumenwild/`, TypeScript), not a production bundle. Line references are
to the current branch. The full system audit from the earlier Phase 0 is in `docs/audit/` (architecture, rendering,
living world, multiplayer, performance); this report covers what the world map specification needs.

## What exists and can be reused

| Spec need | Existing code | Reuse |
|---|---|---|
| Terrain grid of any size | `World` (`src/engine/world/World.ts:42`, `constructor(w = 256, h = 256)`), 16 x 16 chunk dirty flags (`:53`) | **Reuse as the simulation region**: one region = one 256 x 256 `World`. Nothing assumes 256 except the default |
| Seeded terrain, rivers, falls, lakes, caves, objects | `generateWorld` (`src/engine/gen/world.ts:33`) for one valley; continent draft generators (`src/engine/continent/terrain.ts`, `hydrology.ts`) | Region generator (Phase 2) reuses the valley's detail passes (materials, ground cover, objects); the draft's river carving is superseded by the blueprint's (it had a bank-compounding fault, fixed in `src/world/blueprint.ts`) |
| Water simulation | `WaterSim` (`src/engine/water/WaterSim.ts:89`, step `:236`), worker, active chunks | **Reuse unchanged per loaded region**. Rivers from the blueprint become sources and boundary inflows; deterministic, so server and client can share it |
| Coordinates | Grid only; the oblique 2.5D `Camera` (`src/engine/world/Camera.ts:11`) maps cells to screen | New `src/world/coords.ts` (the single conversion utility the spec requires) |
| Pathfinding on terrain | A* in `src/engine/continent/trails.ts:43`, now grid-size independent | **Reused** for blueprint roads (no second A*) |
| Village layout, cultures, routines | `src/engine/continent/villages.ts`, `cultures.ts`, `population.ts` | Reusable for Greenhaven, Marshlight, Frostwatch and the proposed villages once positions come from `world/settlements` |
| Dragon | 15-state machine (`src/engine/dragon/DragonStateMachine.ts:9`), utility AI (`DragonAI.ts`), flight physics, steering, climb planning, landing checks, persistence (`DragonEntity.ts validateDragon`) | **Reuse the flight and steering layers**; the spec's behaviour states map onto a new behaviour layer above the existing locomotion states (see the blueprint document, part 7) |
| Persistence | Save format v1 (`src/persist/format.ts:9-10`), IndexedDB slots | Keep v1 for the valley; per-region edit diffs and per-player discovery are new (v2) |
| Rendering | 2.5D character renderer; `Presenter` interface with Canvas 2D and WebGL2 presenters (`src/engine/render/Presenter.ts`) | The 3D view (approved, Three.js) renders world chunks from the same data; no change to the 2.5D view |
| Tests and previews | Vitest (Node) and Playwright; golden images | Blueprint checks run in unit tests; map previews in Playwright |

## What does not exist yet

- A continent-scale world: no streaming, no region manager, no world coordinates beyond one grid.
- Editable world data files, schemas and validation (built now: `lumenwild/world/`, `src/world/schema.ts`).
- Regions, biome transitions and authored mountain ranges at continent scale (built now as a design blueprint).
- Map discovery and fog of war (data model built now: `src/world/discovery.ts`).
- Several dragons, territories, flight corridors, hunting, threat responses, health.
- Wildlife and NPC simulation (the entity system planned for Phase 2 of the roadmap).
- Server and multiplayer world state (planned; nothing built).

## Measured limits relevant to this specification

| Fact | Value | Source |
|---|---|---|
| One 256 x 256 region: water step | about 1 ms per 60 Hz step (worker) | earlier performance audit |
| Region generation (valley) | about 217 ms in Node | earlier performance audit |
| JS heap, valley running | 34 MB used | earlier performance audit |
| Blueprint build (500 x 500 design grid, all checks) | about 1.2 s in Node | `tests/world-blueprint.test.ts` |
| Continent at 10 m per map unit and 2 m cells | 5,000 x 5,000 cells = 400 regions of 256 x 256 | `src/world/coords.ts` |

At the target of 8 GB RAM and integrated graphics, the continent cannot be one `World` (25 million cells, about
250 MB of simulation arrays and 400 times the water work). Streaming a 3 x 3 window of regions (about 55 MB) keeps
the existing per-region costs.

## Conflicts with earlier approved decisions (need your decision)

1. **Cities.** The settlement revision said "no cities"; this specification adds Lumenfall City as the main hub.
2. **Villages.** Greenhaven and Marshlight move; Windmere and Moonrest are not in this specification.
3. **Scale.** The previous draft used 1024 cells (about 2 km). This specification's 1600 m peaks need a larger map
   (10 m per map unit, a 10 km continent, is proposed).
4. **Southern Sky Corridor** is centred 50 units from Lumenfall City.
5. **Thornwild** (the draft's eastern wilds) becomes the **Hollow Lands**.

The earlier draft (`src/engine/continent/`) is kept and still viewable ("Earlier draft" in the map dialog); it will be
retired or re-pointed at the world files once these are decided.
