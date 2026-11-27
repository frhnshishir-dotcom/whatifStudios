# The server world (M2)

How the world server keeps an exact, living continent around players who may be anywhere on it, without stalling
its update loop. The browser's single-player world uses the same simulation code (`src/world/life/`).

## Regions

The continent is generated in 256 m × 256 m regions at 1 m. A region is a pure function of its position, so it can be
made anywhere and is identical wherever it is made.

`server/regionStore.ts` holds the server's regions.

**Generation runs on worker threads** (`server/regionWorker.ts`, `worker_threads`, no dependency):
- Each worker builds the blueprint and terrain once, then answers one region at a time.
- The region's arrays and its collision masks are transferred back, not copied.
- The update loop never generates a region; `tests/seamless.test.ts` and the acceptance run check this.
- Until a region arrives, terrain queries there answer from the coarse continent model, as the browser does outside
  its window. A move into a building in a region that is not yet exact is caught once it is.

**What is asked for:**
- Once a second, the 3 × 3 regions around every player are **pinned** and the missing ones are queued, nearest first.
- A region is never queued twice.
- On joining, and on respawning, the player's 3 × 3 regions are queued at once.

**The cache is sized by demand:**
- capacity = pinned + margin (27), within [minRegions 64, maxRegions 192], and never fewer than the pinned regions;
- past the capacity, the least recently used **unpinned** regions are dropped;
- a pinned region is never evicted;
- memory is bounded by max(192, 9 × players) regions, about 1.2 MB each.

**Workers run on demand:**
- At most 2 (1 on a two-core machine); each costs 70–90 MB.
- A worker is started when regions are queued and stopped after 30 s with nothing to do.
- If a worker fails, the region it was making is asked for again and a new worker is started.

**Building and tests:**
- `npm run server:build` (`server/build.mjs`) builds `dist-server/main.js` and `dist-server/regionWorker.js`.
- The unit tests build `dist-worker/regionWorker.js` first (`tests/setup/buildWorker.ts`), so servers in tests use
  real workers.
- Without a worker bundle, the store generates on the calling thread and counts it in `stats.syncFallback`. This is
  for development only, and tests require it to be 0.

## Wildlife: the region index

`Wildlife` (`src/world/life/wildlife.ts`) keeps its creatures indexed:
- **by region**, using the same 256 m grid as the terrain;
- **by group** (herd, pack, flock).

`creatures` is a `CreatureMap`, which reports what was added, replaced or removed. The index stays right however a
creature arrives: spawning, a guardian, a loaded save, a test placing one. Creatures that cross a region border are
moved to the new region's list after each step, so none is stepped twice.

**Each step classifies regions before visiting creatures:**
- **Dormant:** nowhere within `NEARBY_R` (2.6 km) of a player, and not loaded. The region is skipped without
  touching its creatures. They keep their state and catch up when someone returns.
- **Entirely within `NEARBY_R`:** the per-creature distance test is skipped.
- **Otherwise:** each creature is tested as before.

The tiers are unchanged: 0 inside the loaded area (full behaviour), 1 nearby (a coarse step about once a second),
2 dormant. `tests/seamless.test.ts` checks every creature's tier against the pre-index rule.

The index also serves:
- **Group look-ups** (a pack joining a fight, a flock fleeing, followers finding their leader). These scanned every
  creature on the continent; now they read the group's list.
- **`near(x, y, r)`:** server snapshots (creatures within 600 m of each player) and dragons looking for prey.
- **`awake()`:** the proximity hash for the next step holds only creatures outside dormant regions.

**What may differ from before:** the order in which creatures are stepped is now region by region, not the order they
were spawned. Behaviour is the same, but two creatures reaching the same prey in the same tick may resolve
differently. `stats.dormant` counts every creature in a dormant region, the living and the dead.

## Players near a point

Rules events (a hit, a drop, a door) go to the actor and to connected players within 120 m. The server routes them
through a grid of connected players (128 m cells), rebuilt each time events are sent, instead of comparing every
event with every session.

Snapshots still list every player for every client. Limiting that is interest management, planned for M3.

## The coarse water test

`siteQuery().wet(x, y, margin)` answers "is this water?" outside the exact regions. It is used by:
- creatures moving outside the loaded area;
- movement checks before a region arrives;
- village planning.

It measured every river segment within 2.5 km of the point. River segments are now also filed in 256 m cells, each
where it can wet a point (its half-width + 16 m). For the margins callers use (≤ 16 m), the point's own cell lists
every segment that can matter, so the answer is the same with far fewer segments to measure. Larger margins still use
the 1 km buckets. `tests/seamless.test.ts` checks it against an exhaustive search; the village layouts, bridge and
terrain tests are unchanged.

## Acceptance (M2)

`npm run test:accept` runs `tests/acceptance/m2-seamless.test.ts` alone, because it measures time. CI runs it as its
own step. The run:
- 18 players over WebSockets, three in each of the six villages, walking and fighting for 30 s;
- every 5 s, one player per village travels 400 m into new ground.

Required:
- server update p95 < 15 ms and worst update < 50 ms;
- no region generated on the loop, and every traveller's ground arrives;
- region cache within its capacity, and heap growth bounded;
- every player gets snapshots, and players in the same place see identical creatures and dragons;
- snapshots hold only what is near, and the wildlife index is intact;
- the world saves and loads with everyone in it.

Results: [docs/benchmarks/2026-11-27-m2-after.md](../benchmarks/2026-11-27-m2-after.md).
