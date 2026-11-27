# Implementation roadmap (proposal for approval)

The milestones are ordered by risk to what works today and by measured impact. Each one is a small, tested
increment:
- inspect, then change;
- run the relevant tests, then the full suites;
- look at it in a browser;
- benchmark it, document it, commit it.

Nothing starts before this plan is approved. Items marked **(approval)** need a separate yes.

## M0: Safety net (no gameplay change)

1. **CI for Lumenwild** (GitHub Actions): typecheck, build, unit tests, browser tests including the golden images.
2. **Benchmarks** in the app's Benchmark panel and as test scripts:
   - continent exploration (travel across regions);
   - dense village;
   - dragon activity;
   - night storm;
   - multiplayer sync (N bots together);
   - multiple active regions (N bots spread out).

   Each reports fps, frame p50 and p95, compose and present time, sim time, heap, server tick time and KB/s per
   client. The first laptop run becomes the reference.
3. **Regression tests for the gaps** in PROTECTED_SYSTEMS.md:
   - region transitions do not duplicate entities;
   - a bear kill;
   - character state after reconnect;
   - an image test of each continent dragon style;
   - fixture files for every old save format.

Acceptance: CI is green on the current code; benchmark reports are stored in `docs/benchmarks/`; the gap tests pass.

## M1: Data and transport safety

- **Server persistence guards:**
  - an unreadable save is moved aside and the server refuses to overwrite it;
  - rolling backups;
  - asynchronous writes.
- **Versioned `hero` and `life` payloads**, with a migration registry and fixture tests (v1 → v2 for current
  saves; nothing is reset).
- **WebSocket hardening:**
  - size limits, backpressure, origin allow-list, heartbeats, masked frames;
  - per-type rate limits;
  - schema validation of every message.
- **Validation of client edits:**
  - bounded size, author recorded, within the player's reach;
  - non-builders cannot rewrite regions.

Acceptance: these tests pass:
- a corrupted save is preserved;
- an oversized frame is rejected;
- an edit flood is throttled.

All existing tests stay green.

## M2: Seamless server world

- **Region generation in `worker_threads`;** the tick never blocks on generation.
- **LRU sized to the players,** with an on-disk region cache.
- **Region registry:**
  - active, nearby and sleeping regions;
  - creatures, villagers and loot indexed by region;
  - ticks only for active and nearby regions.
- **Interest management** in snapshots: per-player region sets, with enter and leave messages.

Acceptance: with 18 players spread over the six villages, the measured tick p95 is under 15 ms and the maximum
under 50 ms (today: average 51.6 ms, maximum 2,833 ms). The 16-bot Lumenfall case is no worse than its baseline.
Behaviour tests stay unchanged.

**Status (2026-11-27): done**, as approved. Details: [WORLD_SIMULATION.md](WORLD_SIMULATION.md); numbers:
[docs/benchmarks/2026-11-27-m2-after.md](../benchmarks/2026-11-27-m2-after.md).

| Item | Status |
|---|---|
| Worker generation; nothing generated on the loop | Done |
| Demand-sized cache; regions in use are never evicted | Done |
| Creatures indexed by region and group; dormant regions skipped | Done |
| Players near a point (event routing) | Done |
| Acceptance: 18 players across the six villages, with travellers (`npm run test:accept`, also in CI) | Done |
| On-disk region cache | Not needed: a region takes about 190 ms on a worker and arrives before it is needed. Revisit if laptop numbers say otherwise. |
| Villagers and loot indexed by region | Not done: both are bounded (villagers live in the six villages; loot is short-lived) and cost about 1 ms per update together. |
| Interest management in snapshots | Moved to M3, with delta snapshots, as `NETWORKING.md` already planned. |

## M3: Network efficiency and feel

- **Protocol v3:** delta snapshots, sequence numbers, character sync on change only, adaptive rates by distance.
- **Prediction and reconciliation** for the player's own movement (input sequence numbers).
- **Shared weather and time** from the server.

Acceptance:
- bytes per client per second fall measurably against the baseline (target: half or less);
- the two-browser test passes;
- correction snaps are rare in a scripted walk.

## M4: Visual evolution, step by step (each with screenshots and timings)

1. **Quality settings and adaptive density**, using the atmosphere and particle budgets.
2. **Region-move hitch:** spread the work across frames (target: worst frame under 33 ms in the travel benchmark).
3. **Terrain:**
   - richer ground textures and forest floors;
   - better paths, roads and elevation cues (new glyph families and palettes; new continent golden images).
4. **Vegetation:** individually readable trees, layered forests, animated grass and leaves.
5. **Water:** visible river flow on the continent, shoreline detail, reflections where affordable.
6. **Lighting:** torchlight in villages at night, glowing objects, fog banks.
7. **Weather:** snow in the peaks, storms with lightning, mist in the marshes; weather changes the ground (wet,
   snowy).
8. **Creatures and characters:** idle, attack, hurt and death animation frames, and distinct movement per species.

Acceptance, per step: screenshots before and after; the benchmarks within budget; Valley golden images unchanged
unless approved.

## M5: Living world depth

- Dragon behaviour states made explicit and saved: `NESTING` and `RESPONDING_TO_EVENTS` added; personality
  parameters per dragon.
- A world event scheduler: dragon migrations as events, village threats, rare creatures.
- Wildlife spawning and despawning by habitat, tied to the region registry.

## M6: MMO foundations (each a separate increment)

1. Chat: local, global and private.
2. Parties, with shared kills and quest credit.
3. **Accounts** (username, password, scrypt) migrated from tokens, with characters per account. **(approval: data
   model)**
4. Guilds.
5. Persistence repository with SQLite for local development. **(approval: dependency)** Then PostgreSQL for
   production. **(approval)**
6. Dungeons (ruins and caves with guardians and a boss).
7. Player markets.
8. Housing.

## M7: Deployment readiness (nothing deployed without approval)

- Environment configuration, a Dockerfile, `/health` and `/metrics`, structured logs, and documented backup and
  restore procedures.
- A deployment guide for a single small VM or a container host. **(approval: provider and cost before any deploy)**

## Risks to existing functionality, and how they are contained

| Risk | Where | Containment |
|---|---|---|
| The Valley look changes by accident | renderer, glyph registry, atmosphere | golden images in CI; quality flags default to the current look |
| Old saves misread | life and hero payloads, server file | fixture files and migrations in M1, before any format change |
| AI behaviour drifts with region indexing | wildlife and dragons | unchanged queries; `life.test.ts`; side-by-side statistics |
| Protocol change breaks clients | net | version check (exists); v2 kept alongside v3 for one milestone |
| Flaky timing tests | stream and dragon save timing | budgets with margins for CI hardware; never removed |
| Performance regressions | everything | benchmark reports per milestone, compared to `BASELINE_AUDIT.md` |
