# Protected systems

Everything here works today (baseline at commit `df6bf74`: 202 unit and 65 browser tests passing) and must keep
working through every milestone.
- A change that touches a protected system must keep its guarding tests green. Never delete a test, skip it or
  weaken an assertion to make a change pass.
- If a test must change (for example a deliberate design change), say so in the commit and in this file.

## A. Visual identity

| System | Guarded by |
|---|---|
| Character-cell 2.5D renderer: oblique projection, cliff faces, glyph atlas, cached shading, Canvas 2D and WebGL2 presenters producing identical pixels | `tests/render.test.ts`, `tests/shading.test.ts`, `e2e/m1-render-camera`, **`e2e/m8-golden` (9 golden images on both presenters, determinism)**, `e2e/m9-presenter` (fallback, runtime switch, context loss) |
| Valley scene: generation, water (flow, ripples, waterfalls), weather, day and night, particles, lights | `tests/world.test.ts`, `water*.test.ts`, `env.test.ts`, `e2e/m2-water`, `m3-world`, `m5-environment` |
| Approved biome transitions (commit baa9516: patch size, transition width, blending) | `tests/world-transitions.test.ts` (9), `world-biomes.test.ts`, `e2e/m14-biomes` |
| Continent villages (5 cultures, 6 villages) and road bridges | `tests/world-villages.test.ts`, `e2e/m16-villages` |
| The Valley dragon's look and behaviour | `tests/dragon.test.ts` (13), `e2e/m7-dragon`, golden images |
| **The five continent dragons:**<br>• Aurath: storm blue, the largest<br>• Emberfang: obsidian and crimson<br>• Rimeclaw: frost white<br>• Mossheart: forest green, smaller<br>• Ashmaw: ash and violet<br>All five have the articulated three-finger wing and bank into turns. | `src/world/life/dragonStyles.ts`, `src/engine/dragon/DragonPoses.ts` (`DragonStyle`). **Gap:** no automated image test of the continent styles yet; the reference stills are `docs/world/rpg-dragons.jpg` and `living-dragon.jpg` |

## B. World and simulation

| System | Guarded by |
|---|---|
| Blueprint (`world/*.json`), schema validation, coordinates (100 m per map unit, 1 m cells, 256 m regions) | `tests/world-blueprint.test.ts`, `continent.test.ts`, `e2e/m11`, `m12` |
| Deterministic region generation (terrain, biomes, rivers, objects, places, caches) | `tests/world-terrain.test.ts`, `world-stream.test.ts` |
| Streaming window: 3 × 3 regions, seamless camera across moves, bounded memory, worker cache | `tests/world-stream.test.ts`, `e2e/m13-continent-mode` |
| Navigation and travel between villages | `tests/world-navigation.test.ts` |
| Wildlife: 5 species, needs, herds and packs, predators, flight, tiers, persistence of identity | `tests/life.test.ts` |
| Villagers: schedules, work, shelter, chats; populated online | `tests/life.test.ts`, `e2e/m17` |
| Continent dragons: autonomous flight, take-off and landing, hunting, nests, migration, village clearance | `tests/life.test.ts` |
| Valley sandbox editor (tools, undo and redo) | `tests/editor.test.ts`, `e2e/m4-editor` |

## C. RPG

| System | Guarded by |
|---|---|
| Character: levels, attribute points, 12 skills, statistics, save format and legacy pack conversion | `tests/rpg.test.ts` |
| Combat: attacks, dodge, creature fights (wolves and bears), packs, wounded flight, death and respawn, creature respawn | `tests/rpg.test.ts`, `e2e/m19-rpg` |
| Loot bags and ownership, gathering, finds | `tests/rpg.test.ts`, `multiplayer.test.ts`, `e2e/m18`, `m19` |
| Items (46), rarity and properties, 24-slot pack, 6 equipment slots | `tests/rpg.test.ts` |
| Crafting (23 recipes, stations) | `tests/rpg.test.ts` |
| Shops, prices, player trade (all at once or nothing) | `tests/rpg.test.ts`, `multiplayer.test.ts` |
| Quests (6 kinds, deterministic, persistent) | `tests/rpg.test.ts`, `e2e/m19` |
| HUD and RPG panel tabs; game keys do not trigger editor tools | `e2e/m18`, `m19` |

## D. Persistence

| System | Guarded by |
|---|---|
| Valley saves: format v1, validation, export and import, newer-version refusal | `tests/persist.test.ts`, `e2e/m6-persistence` |
| Continent saves: separate namespace, region edits, character and RPG state, reload | `tests/world-persist.test.ts`, `e2e/m15-continent-save`, `m19` |
| Server persistence: sessions, characters, edits, taken finds, the living world; restart recovery | `tests/multiplayer.test.ts` |
| **Existing player data must never be reset or deleted.** Old saves (Valley v1, continent v1, server file v1 and v2) must keep loading. | the tests above; **gap:** no fixture files of old saves yet |

## E. Multiplayer

| System | Guarded by |
|---|---|
| Authoritative server; protocol version check; sessions and tokens; reconnection | `tests/multiplayer.test.ts`, `e2e/m17` |
| Move validation (speed, walls and water) and corrections | `tests/multiplayer.test.ts` |
| Commands, routed events, character sync, combat and loot sync, trade between players | `tests/multiplayer.test.ts`, `e2e/m17` |
| Two independent browsers in one world | `e2e/m17-multiplayer` |
| 16 bots on one server | `tests/load.test.ts` |

## F. The directive's 15 regression scenarios, and where each is tested

| # | Scenario | Test today | Status |
|---|---|---|---|
| 1 | Player can enter the world | `e2e/m13`, `m18` | covered |
| 2 | Player can move between regions | `tests/world-stream.test.ts`, `e2e/m13` | covered (camera and window); add a player-driven crossing |
| 3 | Player can fight wolves and bears | `tests/rpg.test.ts` (wolf; a bear kills the player), `e2e/m19` | covered; **add a bear kill** |
| 4 | Loot ownership works | `tests/multiplayer.test.ts` | covered |
| 5 | Inventory and equipment work | `tests/rpg.test.ts`, `e2e/m19` | covered |
| 6 | Crafting works | `tests/rpg.test.ts` | covered (no browser test) |
| 7 | NPC shops work | `tests/rpg.test.ts`, `e2e/m19` | covered |
| 8 | Quests work | `tests/rpg.test.ts`, `e2e/m19` | covered |
| 9 | Trading works | `tests/rpg.test.ts`, `multiplayer.test.ts` | covered |
| 10 | Respawn works | `tests/rpg.test.ts`, `multiplayer.test.ts` | covered |
| 11 | Dragons keep their identities and behaviours | `tests/life.test.ts` (behaviour) | **identity gap:** add a style and image test |
| 12 | Two separate browsers can interact | `e2e/m17` | covered |
| 13 | Player data survives disconnection | `tests/multiplayer.test.ts` (token resume, position) | covered; add a character-state check after resume |
| 14 | Player data survives a server restart | `tests/multiplayer.test.ts` (coins, inventory, edits, finds) | covered |
| 15 | Region transitions do not duplicate entities | none directly (creatures and objects are keyed by id) | **gap:** add an explicit test (objects and creatures across window moves, online and offline) |

## G. Rules that are not tests

- The Valley must stay exactly as it is unless a change is approved. The golden images are its contract.
- Keep the five dragons' identities, colours, sizes and wing structure.
- The character-cell renderer stays the game's renderer: no conventional 3D renderer replaces it.
- Blender is never a required dependency, and no commercial graphics dependency is added.
- Run locally with `npm run dev` or `npm run build && npm run preview`, and `npm run server` for online play. This
  must keep working at every commit.
- No paid services or public deployment without approval.
