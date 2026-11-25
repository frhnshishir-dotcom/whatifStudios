# Lumenwild roadmap (Phase 0 output)

Principle: **one simulation, several views, one server later.** The existing simulation (World, water, objects,
environment, dragon) stays the single source of truth. Renderers only read it. The server later runs the same code.
Every step keeps the current app working and keeps all existing tests green.

## Decisions needed before Phase 1

1. **Three.js and Blender.** The original Lumenwild brief banned Three.js and Blender; the new brief prefers them.
   Lifting the ban for Three.js is needed for the 3D view (Phase 1b). Blender assets would be authored on your laptop
   through the open Blender session (background `blender -b` renders crash there, per `CLAUDE.md`).
2. **Audio.** The repository `CLAUDE.md` says "never add, generate or claim audio" (written for the video pipeline).
   The new brief asks for an audio system. Please confirm that Lumenwild is exempt, and whether sounds should be
   synthesised in code or come from licensed files you supply.
3. **Primary view.** Keep the 2.5D character view as the main game view until the 3D view reaches parity
   (recommended), or switch to 3D as soon as it exists.
4. **Server hosting** for Phase 3 (laptop, cloud VM or both).

## Phase 1: visual foundation (single-player, existing world)

| Step | Change | Files affected | Evidence required |
|---|---|---|---|
| 1.1 | Introduce a `Presenter` interface around `Renderer`/`Blitter`; the Canvas 2D implementation stays the default. Add golden-image tests of the nine review views | `render/Renderer.ts`, `render/Blitter.ts`, new `render/Presenter.ts`, `e2e/` | All existing tests pass; golden images match exactly |
| 1.2 | WebGL2 presenter behind `?presenter=webgl` (and a setting): `CellBuffer` uploaded as textures, glyph atlas as a texture array; automatic fallback to Canvas 2D | new `render/WebGLPresenter.ts` | Pixel difference against the Canvas presenter below a set threshold on all nine views; frame time measured |
| 1.3 | Capability probe and in-app benchmark export (renderer string, limits, fps, frame time, per-layer costs) | `ui/`, `Engine.ts` | A report from your laptop |
| 1.4 | Selective glow from the emissive channel in the shader; move fog, haze and grade from `Atmosphere` into the shader when the WebGL presenter is active | `env/Atmosphere.ts`, presenter | Glyphs stay readable (contrast test), CPU time drops |
| 1.5 | Palette registry with per-biome palettes (base navy-black, timber, amber, vegetation, magic crimson and emerald), replacing scattered constants | new `render/Palette.ts`, `TerrainShader`, `WaterLayer`, `defs`, `DragonPoses` | Before/after screenshots; unit test that every material resolves |
| 1.6 | Effects framework v1 in the 2.5D view: red energy pillar and green transformation (activation, duration, particles, local light, cleanup), pooled | new `env/Effects.ts`, `Particles`, `Atmosphere` | Effect lights nearby cells, ends cleanly, no allocations per frame |
| 1.7 | Camera presentation: easing, shake, framing for effects | `world/Camera.ts`, `Engine.ts` | e2e checks |
| 1.8 (gate) | **3D view prototype** (needs decision 1): heightfield, water surface, instanced objects, dragon mesh, world-space glyph surfaces, bloom, perspective three-quarter camera, ray picking | new `render3d/` | Side-by-side frames with the reference; parity checklist; laptop frame time |

## Phase 2: living ecosystem (single-player)

Entity store and species profiles (`LIVING_WORLD_AUDIT.md` §3), behaviours, chunk spatial index, simulation tiers,
deer, wolves, birds, the dragon migrated into the store with food, hunting and territory, several dragons with
temperaments, a small village with NPC schedules. Evidence: unit tests for states, predator/prey, tier update rates;
a long headless run with population stability; screenshots.

## Phase 3: multiplayer foundation (2-10 players)

`lumenwild/server` (Node + `ws`), shared engine code, guest sessions, player avatars with server-validated movement,
chunk interest management, water prediction with hash-checked keyframes, shared edits with validation, reconnection.
Evidence: the two-client tests in `MULTIPLAYER_ARCHITECTURE.md` §5, measured bandwidth and tick time.

## Phase 4: shared world simulation

Server-authoritative creatures and dragons, shared world events, region persistence (snapshots + event log), region
management. Evidence: restart the server and the world returns; clients agree on creature positions.

## Phase 5: RPG gameplay

Character creation and archetypes, stats and progression, inventory and equipment, real-time combat with
server-side outcomes, abilities built on the effects framework, quests, NPC interaction. Evidence: security tests
(forged damage, currency, items rejected).

## Phase 6: persistent MMORPG systems

PostgreSQL, crafting, trading, parties, guilds, dungeons, bosses, world events.

## Phase 7: scale and optimisation

Profiling, delta compression, load tests with simulated clients, monitoring. No capacity claims beyond what load
tests show.

## Risks

| Risk | Mitigation |
|---|---|
| 3D view does not reach the laptop's budget | Keep the 2.5D view as LOW/MEDIUM; 3D as HIGH; measure early (step 1.3) |
| WebGL2 unavailable or unstable on the Intel driver | Canvas 2D presenter remains the automatic fallback |
| Glyph readability lost under bloom | Bloom only from emissive cells; contrast tests |
| Simulation divergence between client and server | Server authority for creatures; hash-checked water |
| Scope: an MMORPG is very large | Each phase ships a working, tested product; nothing starts before the previous gate |

## Safest first implementation step

**Step 1.1:** add golden-image tests of the current renderer and wrap the existing Canvas 2D blitter in a `Presenter`
interface, with no change in behaviour or appearance. It touches two render files plus tests, is fully reversible, and
gives every later visual change (WebGL2 presenter, glow, 3D view) an objective before/after check.
