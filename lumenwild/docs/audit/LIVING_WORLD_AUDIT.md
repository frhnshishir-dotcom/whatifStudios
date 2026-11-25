# Living world audit (Phase 0)

## 1. What lives in the world today

| Element | Alive? | Implementation | Evidence |
|---|---|---|---|
| Water | Yes: flows, conserves mass, falls, ripples, reacts to edits, rain rings, dragon drinking | `water/WaterSim.ts:236` (60 Hz) | `tests/water.test.ts` |
| Weather and time | Yes: day-night cycle, rain, fog, wind gusts fade in and out | `env/Environment.ts:32` | `tests/env.test.ts` |
| Vegetation | Animated, not simulated: canopy sway, grass bands bending in gusts, leaves falling and floating downstream | `objects/ObjectLayer.ts:48`, `env/Atmosphere.ts:203`, `render/Particles.ts` | `tests/env.test.ts` (sway, floating leaf) |
| Fireflies, pollen, sparkles | Visual particles with simple motion; no needs or behaviour | `env/Atmosphere.ts` spawn | `e2e/m5-environment.spec.ts` |
| Dragon | Yes: one fully autonomous creature (below) | `dragon/` | `tests/dragon.test.ts`, `e2e/m7-dragon.spec.ts` |
| Wildlife | **None** | | |
| NPCs | **None** (the cottage and mill are empty) | | |
| Players / avatars | **None** (the user is an editor, not an inhabitant) | | |
| Generic entity system | **None**: the dragon is bespoke | | |

## 2. The dragon in detail

| Aspect | Implementation | Location |
|---|---|---|
| State | Position, velocity, heading, angular velocity, speed, altitude (absolute metres), animation state, tail chain | `dragon/DragonEntity.ts` |
| States | 15: IDLE, EXPLORING, ROAMING, TAKING_OFF, FLYING, GLIDING, CIRCLING, DESCENDING, LANDING, WALKING, DRINKING, RESTING, SLEEPING, INVESTIGATING, AVOIDING_OBSTACLE; explicit transition table and minimum durations | `dragon/DragonStateMachine.ts:8` |
| Decisions | Utility AI at 3 Hz over 8 goals (explore, roam, drink, rest, sleep, shelter, investigate, idle) with cooldowns, commitment and noise | `dragon/DragonAI.ts:44`, `:103` |
| Needs | Energy, thirst, comfort, alertness | `dragon/DragonNeeds.ts` |
| Personality | Curiosity, boldness, restfulness, wanderlust, sensitivity (from the seed) | `dragon/Dragon.ts` `spawn` |
| Memory | Visited places, water, landmarks, resting places; recently visited places lose attraction | `dragon/DragonMemory.ts` |
| Senses | Terrain, water, waterfalls, objects; coarse 4 x 4 obstacle-height map; landability; shelter; points of interest | `dragon/DragonEnvironmentAwareness.ts:25` |
| Navigation and flight | Weighted destinations; seek, arrive, wander, circle, obstacle and edge avoidance; climb planning along the route; limited turn rate and turn acceleration, acceleration, climb and sink rates, gliding, wind drift; collision rule against tall terrain | `dragon/DragonNavigation.ts`, `DragonMovement.ts`, `DragonFlight.ts:13` |
| Lair | Cave on the mountain summit; rests and sleeps there; shelter in rain | `dragon/DragonAI.ts` (`toLair`), `gen/world.ts:160` |
| Interactions | Real ripples in the water simulation, splashes, discovering water, reacting to edits, sound hooks (no audio) | `dragon/DragonInteractions.ts` |
| Persistence | Optional `dragon` field in the save, validated, older saves hatch a new dragon | `dragon/DragonEntity.ts` `validateDragon`, `persist/format.ts` |
| Rendering | Cached character poses (24 headings, 8 wing frames, 5 modes, 4 altitude sizes), live neck, head and tail, ground shadow | `dragon/DragonPoses.ts:138`, `DragonRenderer.ts:31` |
| Evidence | A 15-minute day and night on a real world with zero refused transitions, no teleports, clearance kept, ten states seen; thirst, rest, sleep in the cave, rain shelter, wind drift, investigate, save/load, invalid-state recovery | `tests/dragon.test.ts` (13 tests) |
| Cost | 0.022 ms per step in Node (measured in this audit) | |

### Dragon gaps against the new brief

| Brief requirement | State |
|---|---|
| Roam, fly, land, rest, sleep, investigate, avoid obstacles, continuous movement | Done |
| Search for food, hunt smaller creatures | Missing (no prey exists) |
| Territory and defence | Missing (it has a home, not a territory) |
| React to threats and to players, defend itself, abilities | Missing (no players, no combat) |
| Hovering, banking (visual roll) | Partial: it can nearly hover while climbing; no banking pose |
| Disappear into the distance and return | Missing: the world is 256 x 256 and the dragon is clamped inside it |
| Several dragons with different temperaments | Missing: `Engine.dragon` is a single field; personality varies only by seed |
| Server-authoritative | Missing: runs in the browser |

## 3. Proposed entity architecture (for Phase 2; not built)

Goals: many creatures at low cost, the same code on client and server, the dragon migrated in without losing behaviour.

- **Entity store (ECS-lite):** structure-of-arrays typed arrays per component (position, velocity, heading, species,
  state, needs, health, territory centre and radius, LOD tier, next update time), integer IDs with generation counters,
  free lists. No per-frame allocation. DOM-free, so the server runs it unchanged.
- **Species profiles:** data, not classes: speeds, senses, diet, social structure (herd, pack, solitary), allowed
  states, activity hours, flight capability, a behaviour set.
- **Behaviours:** small modules (graze, wander, flock/herd, flee, hunt, chase, attack, rest, sleep, return to
  territory, perch) scored by a utility selector like `DragonAI.score`, executed by a shared steering and movement layer
  (reusing `DragonMovement` ideas: seek, arrive, wander, avoid).
- **Spatial index:** buckets per 16 x 16 chunk (the same unit as water and objects) for neighbour queries,
  predator/prey detection and interest management.
- **Levels of detail:** tier 0 (near a player or the camera) full update at 20 Hz; tier 1 at 5 Hz; tier 2 at 1 Hz
  with coarse movement; tier 3 (unloaded) statistical updates on load. Tier is recomputed at 1 Hz from distance.
- **Determinism:** one seeded RNG stream per entity; all AI on the server in multiplayer (trigonometry results can
  differ between browsers, so creatures are not replayed on clients).
- **Dragon migration:** wrap the existing `Dragon` as a "complex entity" first (keep its modules and tests), then move
  needs, memory and state into the store; support several dragons with personality archetypes (territorial, curious,
  shy, ancient).
- **Food chain v1:** grass and water as resources (existing grids); deer graze and drink; wolves hunt deer in packs;
  birds perch on trees and scatter; the dragon hunts deer and boars and defends its mountain.
- **NPCs v1:** a small village near the cottage and mill; schedules by `Environment.time` (work, eat, sleep); occupations
  as behaviour sets; walk on paths (`Mat.Path` cells already exist).

## 4. Missing systems (living world)

Entity store, species data, behaviours, perception (sight, hearing, smell), pathfinding on the ground (A* on the
grid or flow fields), herding/flocking, predator-prey, territories, NPC schedules and dialogue, death and spawning
(population balance), resource regrowth, distance-based simulation tiers, and creature persistence.
