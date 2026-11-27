# Target architecture (proposal for approval)

This evolves what exists; nothing is replaced wholesale. It is grounded in the measurements in BASELINE_AUDIT.md.
The topic documents (WORLD_SIMULATION, NETWORKING, PERSISTENCE, RENDERING, DEPLOYMENT) will each be written when
its milestone starts, describing what is actually built. Until then, this file holds their target design.

## Principles

1. **One rules engine, two hosts.** `LifeSim` and `Rpg` keep running unchanged in the browser (single player) and
   on the server (authoritative). New features are commands and events in that engine.
2. **Regions are the unit** of generation, simulation, persistence and interest. Region identity is
   `(floor(x/256), floor(y/256))` in continent metres; global coordinates never reset.
3. **Measure, then change.** Each optimisation names the benchmark that justifies it and the number it must move.
4. **Data is sacred.** Every persisted format is versioned, migrated forward with a tested migration, and backed
   up before it is written.
5. **Local first.** Every milestone runs with `npm run dev` and `npm run server`. Hosting comes later, behind
   configuration, and only with approval.

## Overview (target)

```
 Browser (per player)                                   World server (one Node process; later several)
 ┌──────────────────────────────────────┐               ┌────────────────────────────────────────────────────┐
 │ React UI (panels, HUD)               │               │ Transport: WS with size limits, backpressure,      │
 │ Engine: Composer + presenter         │   WebSocket   │   origin check, heartbeats; auth handshake         │
 │ ContinentSession (3x3 window)        │◄─────────────►│ Sessions and accounts (token -> account -> char)   │
 │ LifeSim/Rpg as local mirror          │  protocol v3  │ Interest manager (per-player region set)           │
 │  (prediction for own player only)    │  deltas,      │ WorldSim: active regions at 10 Hz, nearby 1 Hz,    │
 │ NetClient: snapshot buffer, interp,  │  binary later │   sleeping regions frozen; dragons always          │
 │  reconciliation                      │               │ RegionStore: worker_threads generation, LRU sized  │
 └──────────────────────────────────────┘               │   to the players, on-disk cache                    │
                                                        │ Persistence: repository interface ->               │
                                                        │   JSON file now / SQLite local / PostgreSQL prod   │
                                                        │ Observability: /health, /metrics, structured logs  │
                                                        └────────────────────────────────────────────────────┘
```

## World simulation

- **Region registry (server):**
  - Each region is `sleeping`, `nearby` or `active`, from player interest: active within the player's 3 × 3, nearby
    out to about 2.6 km, sleeping beyond.
  - Creatures, villagers, loot and depleted nodes are **indexed by region**, so a tick touches only active and
    nearby regions. Today every creature is checked against every player: O(creatures × players).
  - Sleeping regions keep their state and catch up coarsely when woken (the `coarseStep` idea already exists).
- **Region generation off the tick:**
  - `worker_threads` pool (1–2 workers on the laptop).
  - The tick never waits: a region not ready is treated as coarse.
  - On-disk cache keyed by `(rx, ry, GENERATOR_VERSION)`.
  - LRU capacity = active players × 9 + margin, with a memory cap.
  - This addresses the measured 2.8 s stalls.
- **Dragons:**
  - Already autonomous and simulated globally (5 agents, 0.15 ms per tick).
  - Next, keep their state in an explicit, saved state machine with the directive's named states (most exist:
    sleep, rest, takeoff, patrol, hunt, feed, drink, migrate, land, defend, inspect).
  - Add `NESTING` and `RESPONDING_TO_EVENTS` as events arrive.
  - Personality parameters per dragon (aggression, range, preferred altitude) live in `world/dragons/*.json`.
- **World events:**
  - A scheduler, deterministic from the world seed and the clock, produces events: a migration, a village threat,
    a rare creature.
  - Each event is a record with a state machine, persisted with its region.
- **Future distribution:** the region registry is the seam. A region-group could later move to another process
  behind the same interface, but **not until profiling shows one process is not enough**.

## Networking

- **Transport hardening (first):**
  - maximum frame 64 KB, maximum message 256 KB, close on violation;
  - backpressure: drop or merge snapshots when a socket's buffer exceeds a limit;
  - origin allow-list from configuration;
  - ping every 15 s, drop after 45 s;
  - require masked frames.
- **Interest management:** each client subscribes to regions (its 3 × 3 plus a margin). Snapshots carry only
  entities in those regions, with entity enter and leave messages.
- **Delta snapshots:**
  - per-entity versions;
  - send only changed fields;
  - a full snapshot on join or resync;
  - sequence numbers for ordering.
  - Binary encoding (a typed-array layout) only if JSON with deltas is still too large when measured. Today:
    15–32 KB/s per client.
- **Adaptive rates:**
  - 10 Hz for entities near the player, 2–5 Hz farther out;
  - character sync on change only, using a dirty flag instead of re-serialising every snapshot.
- **Client prediction and reconciliation** for the player's own movement only:
  - the client keeps unacknowledged inputs with sequence numbers;
  - the server acknowledges the last applied one;
  - on a correction the client replays the pending inputs.
  - Combat stays server-decided; the client shows the swing at once and the result on reply.
- **Validation:**
  - Every message has a schema check and a size limit.
  - Rate limits apply per message type: moves 20/s, commands 30/s, edits 2/s.
  - Edits are checked against what a player can do (tools, area, distance) and recorded with the author.
- **Social (prepared as modules, built later):**
  - chat (global, local by distance, private), parties, guilds, friends;
  - each is a server module with its own commands and events, and a persistence table.

## Identity and security

- Phase 1 keeps today's tokens, plus:
  - tokens stored hashed on the server;
  - an expiry and a "log out everywhere" option;
  - a session bound to one connection at a time (already true).
- Phase 2 adds accounts:
  - **username and password** with a slow hash (Node's built-in `scrypt`, so no new dependency);
  - an account owns one or more characters, and the existing token sessions migrate to accounts;
  - an optional OAuth provider later, with approval.
- The server never trusts the client for currency, inventory, combat or progression. That is already the rule in
  `Rpg` (commands only); keep it a hard rule.
- **Trades and other multi-party changes** run as one server-side transaction (already all at once in memory).
  With a database, wrap them in a DB transaction with an idempotency key, so a retry or crash cannot duplicate
  items or coins.

## Persistence

```
 Rules engine (Hero, RegionState, WorldState)  ──►  Repository interface (load/save/transaction)
                                                    ├─ JsonFileRepository   (today's format, guarded; default now)
                                                    ├─ SqliteRepository     (local dev, when needed; no new dep until approved)
                                                    └─ PostgresRepository   (production; approval needed for the dependency)
```

- **Guards (now, no format change):**
  - never overwrite a file that failed to load (move it aside and refuse to start, or start read-only);
  - rolling backups: keep the last N saves and a daily one;
  - write asynchronously (not inside the tick);
  - a checksum in each file.
- **Versioning:**
  - The hero and `life` payloads get their own `version` fields, with migration functions `vN → vN+1` tested
    against fixture files.
  - Continent saves already have `version` and `GENERATOR_VERSION`.
- **Models** (the same shapes in JSON and in tables): accounts, characters (hero JSON), inventory items (rows with
  uid), equipment, skills, quests, regions (edits, depleted nodes, loot), creatures (by region), dragons, NPC
  state, guilds, parties, trades (ledger), and economy (shop stock and prices).
- **Migration plan for each change:** export, transform, validate, import into a copy, compare, switch, and keep
  the old file. Rollback restores the copy.

## Rendering

The engine and its look stay. Improvements are layered on and measured against the baseline:
- **Budget and quality:**
  - a quality setting (low, medium, high) drives atmosphere density, particle counts, light radius and
    vegetation animation;
  - adaptive density reduces those when frame p95 exceeds budget.
  - The atmosphere layer is the largest steady cost today.
- **Region-move hitch** (47 ms):
  - spread the shift and reshade over several frames;
  - give the worker pre-shaded strips where the data allows.
- **Visual work** (terrain texture, vegetation layering, flowing water, torchlight, snow, storms, creature
  animation):
  - each item adds glyph families, palette work or a layer behind a quality flag;
  - each is checked with screenshots and timed with `composer.profile`;
  - Valley golden images must still match.
  - Continent visual changes get their own new golden images.
- **Creatures and characters:**
  - more animation frames (idle, attack, hurt, death) in the sprite tables;
  - death fades and hit recoil as short-lived effects.
  - No renderer change is needed.

## Deployment (prepared; nothing deployed without approval)

- **Configuration:**
  - environment-based: port, data directory, allowed origins, database URL, log level, save interval;
  - `.env.example` with no secrets.
- **Container:** a Dockerfile for the server, with the client built as static files served by the same process or
  by any static host. COOP and COEP headers keep the water worker fast.
- **Health and metrics:**
  - `/health` (liveness and readiness);
  - `/metrics` (tick time, clients, bytes, regions active);
  - structured JSON logs.
- **Backups:** a scheduled copy of the data directory or database, with a tested restore procedure.
- **Shutdown:** SIGTERM saves, closes sockets with a reason, and exits; this partly exists today.

## Migration risks

| Change | Risk | Mitigation |
|---|---|---|
| Region index for creatures | AI behaviour changes subtly (who sees whom) | keep `SpatialHash` queries identical; the `life.test.ts` suite; compare kill and flee statistics before and after |
| Worker region generation on the server | determinism between thread and main | regions are pure functions already; the test compares hashes |
| Delta protocol (v3) | old clients | the version check exists; serve v2 and v3 side by side for one milestone |
| Persistence versioning | misreading old saves | fixture files for every old format in tests before any change |
| Visual changes | the Valley's golden images | quality flags default to the current look until approved |
