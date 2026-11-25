# Multiplayer architecture (Phase 0 proposal; nothing built)

## 1. Current state

There is **no networking, server, account system or shared persistence** in Lumenwild. All state lives in one browser
tab; saves are local (IndexedDB). This document proposes how to add multiplayer without discarding the simulation.

## 2. Facts that shape the design (measured during this audit)

| Fact | Evidence | Consequence |
|---|---|---|
| The simulation core runs in Node without a DOM | Unit tests run World, WaterSim, ObjectStore, Editor, Environment, Dragon and Engine under `environment: 'node'` | A Node server can run the **same** simulation code |
| Water is bit-for-bit deterministic for the same inputs (same JS engine) | Two independent runs of generation + 1,200 water steps with the same disturbances gave identical SHA-1 hashes of depth, velocity and ripple fields | Clients can predict water locally and be corrected only when they drift |
| `WaterSim.step` uses only `+ − × ÷`, `Math.min`, `Math.max` | `water/WaterSim.ts:236` | IEEE-exact operations: also likely deterministic across browsers (to be verified) |
| Dragon and future creatures use `sin`, `cos`, `atan2`, `hypot` | `dragon/` | Results may differ between browser engines: creatures must be **server-authoritative**, not replayed |
| Server costs per region | World generation 217 ms; water step 1.01 ms; dragon step 0.022 ms (Node, this container) | One 256 x 256 region at 60 Hz water costs ~6 % of one core: a small server can host several regions |
| Save snapshot | 1.23 MB JSON, 28 ms to build, 1,752 objects | Fine for region persistence at low frequency; not a network message |

## 3. Proposed architecture

```
 Browser client (existing app + NetSession)                 Node server (new package: lumenwild/server)
 ┌──────────────────────────────────────────┐   WebSocket   ┌──────────────────────────────────────────────┐
 │ Renderers (2.5D, later 3D), UI, input    │  binary msgs  │ Gateway: sessions, auth tokens, rate limits  │
 │ Local prediction: own avatar, water      │◀────────────▶│ Region host (one per region):                │
 │ Interpolation of entities (100 ms buffer)│               │   World + WaterSim (60 Hz)                   │
 │ Sends INTENTS only (move, edit, ability) │               │   Entity store + AI (20/5/1 Hz tiers)        │
 └──────────────────────────────────────────┘               │   Edit validation (Editor rules)             │
                                                            │   Interest manager (16 x 16 chunks)          │
                                                            │   Snapshot/delta encoder                     │
                                                            │ Persistence: region snapshots + event log    │
                                                            └──────────────────────────────────────────────┘
```

### Server
- **Shared code:** the server imports `src/engine/{core,world,water/WaterSim,gen,objects,edit,env,dragon}` directly
  (TypeScript sources compiled for Node). No fork of the simulation.
- **Tick model:** water 60 Hz; entity movement 20 Hz; AI decisions 3-5 Hz; network snapshots 10-20 Hz.
- **Authority:** the server owns terrain, water, objects, creatures, player positions, health, inventory, currency and
  combat results. Clients send intents: "move toward", "use ability", "edit with tool T at cells C".
- **Edit validation:** reuse the Editor's rules (`whyNot` placement checks, brush limits) after separating validation
  from UI stroke handling. Add permissions (who may edit where) and rate limits.
- **Undo/redo:** becomes a per-player server operation log. A player may undo their own operation only if no later
  operation from someone else overlaps it.

### Networking
- **Transport:** WebSocket via the `ws` package (one small, widely used dependency). Binary messages (ArrayBuffer)
  with a version byte.
- **Interest management:** players subscribe to the 16 x 16 chunks around their view (the same chunk unit as water,
  terrain and objects). Entity and edit updates go only to subscribers.
- **Water synchronisation:** clients run the same WaterSim for the chunks they see. Once a second each client sends a
  hash per subscribed water chunk; the server sends a keyframe only for chunks that differ.
  Estimate (to be measured): a chunk keyframe is about 1 KB (depth as uint16 + velocity as 2 x int8 per cell); a
  126 x 60 view touches about 40 chunks, so the worst case is ~40 KB/s per client, normally far less.
- **Entities:** quantised position, heading, state and animation phase at 10-20 Hz with client-side interpolation;
  about 12-16 bytes per visible entity per update (estimate).
- **Reconnection:** session token; on reconnect, the server resends subscribed chunk keyframes and entity snapshots.

### Persistence
- **Region snapshot:** the existing `lumenwild-world` v1 format (already validated) written periodically, plus an
  append-only event log of meaningful actions (edits, kills, trades) so the world "remembers".
- **Database:** PostgreSQL is the production target (accounts, characters, items, transactions with constraints). For
  local development on an 8 GB Windows laptop, a file database (SQLite) behind the same repository interface avoids
  running a database server; decide when Phase 3 starts.
- **Item integrity (later phases):** items as rows with unique IDs; trades and crafting in database transactions;
  no client-side quantities.

### Anti-cheat basics
Server-side movement validation (max speed, terrain passability, no teleports), cooldown and range checks for
abilities, damage computed only on the server, intent rate limits, input schema validation (same approach as
`persist/format.ts validateSave`).

## 4. How the client changes

- `Engine` gains an optional `NetSession` source: in multiplayer, the world, objects and creatures are applied from
  server messages instead of local generation; local editing becomes "send intent, show pending, apply on ack".
- Offline single-player stays exactly as it is (no server needed).
- The dragon panel and creature panels read replicated state.

## 5. Tests required before any multiplayer claim

Two real clients (headless Playwright pages plus Node `ws` clients) against a real server process: both see each
other, movement syncs, an edit from one appears on the other, the dragon is in the same place on both (within
interpolation error), disconnect and reconnect restore state, invalid movement and forged intents are rejected, server
restart restores the world from persistence. Bandwidth and server tick time measured, not estimated.

## 6. Open decisions for you

1. Where will the server run first: your laptop, a small cloud VM, or both?
2. Accounts in Phase 3: guest names with tokens first (recommended), real accounts later?
3. Editing in a shared world: should players reshape terrain freely, only near claimed land, or only through gameplay
   (abilities, building)?
