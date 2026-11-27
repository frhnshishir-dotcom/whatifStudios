# Lumenwild baseline audit (Phase 0)

Audited 2026-11-27 at commit `df6bf74` (branch `claude/ascii-pointcloud-engine-fz3w62`, clean tree). The audit read
the code and traced execution paths. Every number here was measured during the audit unless it says otherwise.

## 1. What the project actually is (claims in the directive, checked)

| Claim | Actual |
|---|---|
| React frontend | Yes: React 19, with zustand for UI state. The game itself is not React: a TypeScript engine draws to a canvas. |
| JavaScript | No: TypeScript 5.9 throughout (`strict`, `noUnusedLocals`, `noUnusedParameters`), built with Vite 8. |
| Node.js server | Yes: Node ≥ 20.19. |
| Express server | **No.** `node:http` plus a WebSocket implementation of about 70 lines in `server/ws.ts` (no `ws` or Express). |
| "ASCII point-cloud engine" | A **character-cell 2.5D renderer**, not a point cloud. The world is a 1 m grid seen in an oblique projection; every screen cell is a glyph with a foreground and a background colour, drawn from a glyph-mask atlas. "ASCII point cloud" is the project's name for this look. |
| Database | **None.** The browser uses IndexedDB, falling back to localStorage and then memory. The server keeps one JSON file. |
| 202 unit tests and 65 browser tests | Confirmed on this commit (section 9). |

There are 10 production and 76 development npm packages. `npm audit` reports 0 vulnerabilities. Lumenwild has
**no CI**: the repository's only workflow (`.github/workflows/pipeline-tests.yml`) tests the Python video
pipeline.

## 2. Repository architecture

```
lumenwild/
  src/engine/        9,927 lines  rendering, the Valley world, water, objects, the Valley dragon, editor, environment
    render/          1,394        Composer, CellBuffer, TerrainShader, GlyphAtlas, Blitter, Canvas2D/WebGL2 presenters, Particles
    water/             810        shallow-water simulation (worker or main thread), WaterLayer
    dragon/          2,063        Valley dragon: entity, AI state machine, navigation, poses, renderer
    continent/       1,723        early continent and village generator (cultures and building specs, still reused)
    objects/ edit/ env/ gen/ world/ core/
  src/world/         6,797        continent mode
    blueprint, terrain (780), ecotone, villages, stream, session, region.worker, edits, continentSave, navigation, discovery
    life/            1,991        LifeSim: wildlife, villagers, dragons, players; client.ts (LivingWorld, LifeLayer, HUD hook-up)
    rpg/             1,374        items, hero, content, Rpg rules engine, HUD (DOM)
    net/               276        protocol and NetClient
  src/ui/            2,187        React app: panels, dialogs, persistence UI, benchmark
  src/persist/         343        save format, SlotStore (IndexedDB)
  server/              419        WorldServer, ws, main
  world/                          editable world data (JSON: regions, geography, settlements, landmarks, dragons, habitats, roads)
  tests/  23 files, 3,798 lines   ·   e2e/  19 specs, 1,535 lines (and golden PNGs)
```

There are two modes:
- **Valley** (`/`): a 256 m sandbox world with an editor, the water simulation and the Valley dragon.
- **Continent** (`?scene=continent`): a 100 × 100 km streamed world with villages, the living world, the RPG and
  online play (`&server=ws://…`).

Both share the engine (renderer, water, objects, environment).

## 3. Execution paths

**Frame (browser)**
1. `Engine.frame`: fixed-step simulations (water and others) run on `Clock`.
2. The streamer updates (`ContinentSession.update`), which calls `LivingWorld.frame`:
   1. the player moves (`LifeSim.movePlayer`);
   2. `LifeSim.update`: wildlife and villagers tick at 10 Hz, then dragons, then the rules (`Rpg.update`);
   3. RPG events go to effects and the HUD;
   4. dragon puppets are posed.
3. `Composer.compose` builds the CellBuffer:
   1. terrain columns back to front (cached shading per cell);
   2. scene layers: water, objects, life, dragons, particles, atmosphere, overlay.
4. The presenter blits it: Canvas 2D with ImageData, or WebGL2 with integer textures.

**Continent streaming**
- `ContinentSession` keeps a 3 × 3 window of 256 m regions (768 m) around the view. Crossing a region edge moves
  the window by one region: arrays shift in place and a strip is regenerated.
- `RegionCache` generates regions in a worker (LRU of 24) and prefetches the ring around the window.
- Region identity comes from coordinates: `rx = floor(x / 256)`. Coordinates are stable continent metres, so
  nothing resets at region edges.

**Online**
- `NetClient` sends `hello`, then a move every 100 ms and commands as they happen.
- `WorldServer`:
  - steps `LifeSim` at 10 Hz;
  - sends each client a JSON snapshot of what is near it at 5 Hz, plus `hero` updates when the character changes;
  - routes rules events (the client's own, and those within 120 m);
  - generates server regions through `GenQuery.ensureAround` (LRU 64, **on the tick thread**).

**Persistence**
- Valley saves: `persist/format.ts` (`lumenwild-world` v1) in IndexedDB slots.
- Continent saves: `continentSave.ts` (`lumenwild-continent` v1) holds the position, environment, per-region edit
  diffs and an opaque `life` payload (heroes, RPG world state, wildlife, dragons, discovery). It autosaves every 90 s.
- Server: `server-data/world.json` (version 2) with sessions (tokens), players and heroes, edits and life. It is
  written every 30 s and on shutdown, through a temp file and a rename.

## 4. Existing functionality, with locations

| Area | Where | Notes |
|---|---|---|
| Renderer (cells, glyph atlas, shading, presenters) | `engine/render/*` | Canvas 2D (default) and WebGL2 (flag) give pixel-identical output (golden tests) |
| Valley world gen and editor (terrain, water, objects, undo) | `engine/gen`, `engine/edit`, `engine/objects` | |
| Water: shallow-water simulation, ripples, waterfalls, sleeping chunks | `engine/water/*` | worker with SharedArrayBuffer when cross-origin isolated |
| Day/night, weather, wind, fog, particles, point lights | `engine/env/*`, `render/Particles.ts` | |
| Valley dragon: full AI, poses, renderer | `engine/dragon/*` | golden images include it |
| Continent blueprint, terrain, ecotones, villages, bridges, places | `world/*.ts` | deterministic from `world/*.json` |
| Region streaming window and worker cache | `world/stream.ts`, `session.ts`, `region.worker.ts` | |
| Living world: wildlife (5 species), villagers (6 villages), continent dragons (5) | `world/life/*` | tiers: detailed / 1 Hz coarse / dormant |
| RPG: items, hero, combat, loot, gathering, crafting, shops, quests, trade | `world/rpg/*` | one rules engine for browser and server |
| HUD and RPG panel | `world/rpg/hud.ts`, `ui/components/RpgPanel.tsx` | |
| Multiplayer server and client | `server/*`, `world/net/*` | protocol 2 |
| Saves (Valley and continent) | `persist/*`, `world/continentSave.ts`, `ui/persistence.ts` | |
| Benchmark (Inspector → Benchmark) and capability probe | `ui/benchmark.ts`, `ui/capabilities.ts` | **Valley scenes only** |

## 5. Rendering engine analysis

- **Strengths:**
  - Deterministic output, guarded by golden images on both presenters.
  - Shading is cached per cell and rebuilt only for dirty chunks.
  - The blitter skips unchanged cells.
  - No per-frame allocation in particles.
  - Optional per-layer timing (`composer.profile`).
  - Viewport culling is implicit: only visible columns are composed.
- **Measured costs** (continent, software GL, 1280 × 800, Canvas 2D; numbers in section 8):
  - Steady state is 2–4 ms of CPU per frame.
  - The **atmosphere layer** (weather, wind and light) is the largest per-frame cost: 0.6 ms by day, 1.2 ms in a
    storm.
  - Terrain is 0.3–0.6 ms.
  - Presenting jumps to 2.5 ms per frame when the camera moves (every cell redrawn).
- **Weak points:**
  - **Region move hitch:** worst 47 ms when the window shifts, with frames up to 83 ms during fast travel.
  - The glyph set is a fixed registry. Adding glyphs changes the atlas, which needs care against golden images.
  - Creature and character sprites are 1–4 cells with few animation frames.
  - The WebGL2 presenter is slower than Canvas 2D under software GL (37–45 fps against 60), so **it cannot be
    judged here**; it needs the target laptop.
  - Dragon pose caches are unbounded in principle (direction × mode × frame × size × bank). Six poses per dragon
    were measured in steady flight; the worst case has not been measured.

## 6. Multiplayer architecture analysis

- **Model:**
  - One authoritative Node process runs the same `LifeSim` and `Rpg` as the browser.
  - Clients are trusted only for their position, and that is validated: speed, walls, rocks and water against
    server collision masks.
  - Every RPG action is a command decided by the server.
- **Protocol:** JSON over WebSocket, version-checked (version 2). Snapshots go out at 5 Hz and contain everything
  within 600 m (creatures), 400 m (villagers) or the whole world (players), every time: **no deltas, no compression**.
  That measured 15–32 KB/s per client.
- **Sessions:** a random UUID token stored in the browser's localStorage is the whole identity. Tokens sit in plain
  text in `world.json`. There are no accounts and no expiry.
- **Security gaps:**
  - **`ws.ts` has no maximum frame or message size:** a 2⁶³-byte length header is accepted and buffered.
  - No backpressure on sends, and no origin check (any web page can connect to a local server).
  - No idle timeout, and unmasked client frames are accepted.
  - `JSON.parse` runs on unbounded input.
  - Commands are flood-limited to 30/s, but **moves and edits are not**.
  - **Region edits from clients are not validated**: stored, persisted and broadcast as sent. Any client can change
    any region, without limit.
- **Interpolation:** smoothing over one snapshot interval toward the latest position. There is no prediction or
  reconciliation; corrections snap the player.
- **Consistency gaps:**
  - Weather is not shared: the server runs with no rain and clients keep their own.
  - The explored-map fog is per client; only each character's "found" list is synced.
  - The server's collision ignores player edits.

## 7. Persistence analysis

| Store | Format | Risks |
|---|---|---|
| Valley slots (IndexedDB) | `lumenwild-world` v1, validated | low; tested (export, import, newer-version refusal) |
| Continent slots (IndexedDB) | `lumenwild-continent` v1; `life` is **unversioned** (heroes were added without a version bump; the loaders are tolerant) | an RPG format change could misread old saves silently; no migration framework |
| Server `world.json` | version 2; sessions, players and heroes, edits, life | see the next list |

Server risks:
- **If the file cannot be parsed, the server starts a fresh world and overwrites the file at its next save, 30 s
  later.** That is silent data loss.
- No backups or snapshots.
- `writeFileSync` blocks the tick (measured 2–5 ms at 56–145 KB, so fine for now).
- A crash loses up to 30 s.
- Tokens are stored in plain text.
- Sessions are never pruned.
- Version 1 files load, through a legacy path.

Neither SQLite nor PostgreSQL is in use. A database is **not required yet**. What is needed now is safe JSON
handling: refuse to overwrite an unreadable file, keep rolling backups, and version the life and hero payloads.

## 8. Performance baseline (measured)

The environment is a cloud container with headless Chromium on SwiftShader (software rendering) at 1280 × 800. The
Canvas 2D presenter is the default. **These are not laptop numbers**; the target (8 GB RAM, Intel integrated
graphics) has not been measured.

**Browser, continent** (`bench-continent` scratch script):

| Scenario | fps | frame p95 / max (ms) | CPU p50 / p95 (ms) | compose | present | living world p50 / p95 | heap (MB) |
|---|---|---|---|---|---|---|---|
| Startup to playable | — | — | — | — | — | — | 2.8 s |
| Lumenfall village, 11:00 | 60 | 18.3 / 27.9 | 2.0 / 3.5 | 1.4 | 0.5 | 0.19 / 1.2 | 45 → 64 |
| Village zoomed out (11,753 cells) | 60 | 18.4 / 28.6 | 2.7 / 3.9 | 2.1 | 0.6 | 0.16 / 0.96 | 70 |
| Night storm | 59.9 | 17.9 / 54.6 | 2.7 / 4.0 | 1.8 | 0.9 | 0.17 / 0.66 | 64 → 75 |
| Travel at 30 m/s (4 region moves) | 59.7 | 21.6 / **83.3** | 4.0 / 9.7 | 1.7 | 2.6 | 0.18 / 1.4 | 75 |
| Five dragons on screen | 60 | 17.7 / 21.3 | 2.2 / 3.0 | 1.5 | 0.6 | 0.12 / 0.18 | 79–82 |

Largest layers (ms per frame): atmosphere 0.57–1.2, terrain 0.32–0.62, dragon 0.28. A region move takes up to
**47 ms**.

**Browser, Valley** (the existing benchmark, from the e2e run):
- Canvas 2D runs at 60 fps in every scenario: CPU 3.8–5.7 ms, compose 2.2–4.6 ms.
- WebGL2 under SwiftShader runs at 38–45 fps (software GL; not indicative).

**Server** (scratch bot scripts; the server built from this commit):

| Case | Tick average / p95 / max (ms) | KB/s per client | Creatures | Notes |
|---|---|---|---|---|
| 16 bots in Lumenfall (`tests/load.test.ts`, earlier run) | 2.0 / 3.0 / 18.6 | 31.8 | 421 | |
| 16 bots in Lumenfall (this audit) | 3.4 / 2.4 / 352 | 28.6 | 428 | |
| **18 bots over the 6 villages** | **51.6 / 11.6 / 2,833** | 15.7 | 1,957 | region generation stalls |

Where the spread case's time went (15 s):
- **Region generation on the tick thread: 5.1 s in total** (53 regions, up to 153 ms each). The 64-region cache was
  full and evicting regions still in use.
- Wildlife: 4.6 ms per tick (1,925 creatures).
- Snapshots: 4.6 ms per round.
- Villagers: 0.9 ms per tick.
- Dragons: 0.15 ms per tick.

Saving `world.json` took 2.4–4.5 ms (56–145 KB). Starting a server with a save took 1.3–1.7 s.

**Bottlenecks, in order of impact:**
1. Synchronous region generation in the server tick, with an LRU too small for spread-out players. Several active
   regions stall the whole world for seconds.
2. Wildlife updates are O(creatures × players) every tick, and every player populates its own area (about 400
   creatures each).
3. Full JSON snapshots per client every 200 ms (O(players × nearby entities)), and a hero re-serialised per player
   per snapshot to detect changes.
4. The region-move hitch in the browser (47 ms).
5. The atmosphere layer under weather (1.2 ms; a small share of the budget, but the largest single layer).

## 9. Test baseline (this commit)

| Suite | Result | Time |
|---|---|---|
| `npm run build` (tsc and Vite) | passes | 12 s |
| `npx vitest run` | **202 / 202 pass**, 23 files | 1 min 55 s |
| `npx playwright test` | **65 / 65 pass**, 19 specs (including golden images on both presenters, two-browser multiplayer, RPG save and reload) | 4 min 4 s |
| `npm audit` | 0 vulnerabilities | — |

Two timing-based tests have been flaky under load before:
- The streaming move budget in `world-stream.test.ts`, already relaxed to 150 ms without a worker.
- `m7-dragon` save and load, once, under load.

## 10. Structural findings

- **Duplicated functionality:**
  - **Two dragon AIs.** `engine/dragon` (Valley, about 2,000 lines) and `world/life/dragons.ts` (continent). The
    continent draws its dragons by building a full Valley `Dragon` per dragon as a puppet.
  - **Two terrain queries with the same rules:** `WindowQuery` in the client and `GenQuery` on the server, with the
    walkability and slope thresholds written twice.
  - **Two persistence envelopes for the same hero:** browser saves and the server file.
  - `engine/continent` is an earlier continent generator; only its cultures and building specs are still used.
- **Tight coupling:**
  - `Rpg` reaches into `LifeSim` and `Wildlife` internals (`provoke`, `raiseGuardian`, `revive`, `regionOf`), with
    circular type imports.
  - `LivingWorld` (`client.ts`, 567 lines) mixes input, interaction rules, effects, HUD, drawing, dragon puppets
    and network hooks.
  - `NetClient` mutates sim objects directly.
  - `WorldServer` mixes transport, sessions, validation, snapshots and persistence.
  - The Engine knows continent details (`streamer`, `claimSpace`).
  - `ContinentPanel` casts `session.life as unknown as LivingWorld`.
- **Global mutable state:**
  - `DRAGON_META`, a module-level record filled by the `LifeSim` constructor (two sims in one process share it).
  - `markUnsaved`, a module-level hook in `client.ts`.
  - The engine ref.
  - The zustand store.
  - Worker module state (expected).
- **Incomplete features:**
  - Online weather, edit validation, server collision with edits.
  - Chat, parties, guilds.
  - Ranged combat, dragon encounters.
  - Benchmarks for continent and server scenarios.
  - CI.
- **Data-loss risks:**
  - The server overwrites an unreadable save.
  - No backups.
  - The `life` payload is unversioned.
  - Tokens are bearer secrets in localStorage and in the save file.

## 11. Recommendations (detail in TARGET_ARCHITECTURE.md and IMPLEMENTATION_ROADMAP.md)

1. **Safety first, before features:**
   - CI for Lumenwild;
   - persistence guards (no overwrite on a failed load, rolling backups, versioned `life` and `hero` payloads with
     migrations);
   - WebSocket limits (frame and message size, backpressure, origin check, idle timeout);
   - edit validation and rate limits.
2. **Server world scalability:**
   - region generation in `worker_threads`, with an on-disk region cache and an LRU sized to the active players;
   - interest-managed simulation (creatures indexed by region, ticked per active region);
   - delta snapshots.
3. **Benchmarks** for the continent, dragons, villages, multiplayer and multiple regions, in the app and the test
   suite, run on the laptop before any optimisation decision.
4. **Then visuals**, measured against the baseline above, and **then MMO features** (chat, parties, accounts and
   PostgreSQL), each behind tests.
