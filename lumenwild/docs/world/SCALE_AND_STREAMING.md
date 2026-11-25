# Revised scale and streaming architecture (Phase 2, before implementation)

Scale: **100 m per map unit, provisional** (approved for Phase 2, not locked). Figures below are calculated from the
world files and the engine source; the laptop has not been measured.

## 1. A source correction first

`src/engine/world/World.ts` defines **one simulation cell = 1 m x 1 m**. The Phase 1 coordinate file assumed 2 m.
`world/config/coordinates.json` now says 1 m, and every figure here uses it.

## 2. World dimensions

| Quantity | Value |
|---|---|
| Map | 1000 x 1000 units → **100 km x 100 km** (10,000 km²) |
| Land (from the blueprint) | 84 % → about **8,400 km²** |
| Simulation cells (1 m) | 100,000 x 100,000 = 10¹⁰ |
| Chunks (16 x 16 m, the existing chunk) | 6,250 x 6,250 ≈ 39 million |
| Regions (256 x 256 m, one existing `World`) | 391 x 391 = **152,881** |
| Blueprint (design grid) | 500 x 500 samples of 200 m (1 MB of elevation) |
| Highest ground | Skyfall Summit about 1,600 m (blueprint maximum 1,675 m before the summit cap) |

## 3. Travel distances and times

Straight lines between villages, and road length where a road exists. Speeds: walk 1.4 m/s, run 5 m/s, horse 8 m/s,
dragon cruise 30 m/s.

| Between | Straight | By road | Walk | Run | Horse | Dragon (straight) |
|---|---|---|---|---|---|---|
| Lumenfall – Greenhaven | 22.0 km | about 25 km (King's Road) | 5.0 h | 1.4 h | 52 min | 12 min |
| Lumenfall – Frostwatch | 22.1 km | about 26 km (Northern Expedition Route) | 5.2 h | 1.4 h | 54 min | 12 min |
| Lumenfall – Marshlight | 22.7 km | about 27 km (Marsh Road) | 5.4 h | 1.5 h | 56 min | 13 min |
| Greenhaven – Windmere | 17.7 km | about 20 km (King's Road) | 4.0 h | 1.1 h | 42 min | 10 min |
| Greenhaven – Moonrest | 21.4 km | 22.5 km (Moonrest Trail) | 4.5 h | 1.3 h | 47 min | 12 min |
| Across the continent | 100 km | — | 20 h | 5.6 h | 3.5 h | 56 min |
| One region (256 m) | — | — | 3 min | 51 s | 32 s | 8.5 s |

**Gameplay implication (decision before locking):** at real speeds, the nearest neighbouring village is a 5-hour
walk and the continent is a day's walk. That is far beyond typical MMO maps (a few km to about 15 km across). Options:
(a) keep 100 m per unit with fast mounts, dragon flight and discovered fast-travel points; (b) a gameplay speed
multiplier; (c) a smaller unit (25-40 m per unit gives a 25-40 km continent, about 1-2 h village to village on foot).
Phase 2 is built so the unit is one number in `coordinates.json`; nothing else changes.

## 4. Terrain resolution and the 256 x 256 grid (mismatches)

| Mismatch | Consequence | Handling |
|---|---|---|
| Blueprint 200 m per sample vs 1 m cells (x200) | Design data cannot be stretched; it would be flat and blocky | Terrain synthesis: smooth macro shape from the blueprint, plus mid-scale relief (ridges, hills, gullies, 100 m-4 km), plus fine detail (1-40 m), plus rivers and lakes carved at true width |
| The valley (256 x 256 m) is 2.56 x 2.56 map units | The whole existing world is a speck on the continent map | The valley stays a separate sandbox world, unchanged |
| A region is 256 m; villages are 300-450 m across | A village can span two to four regions | Regions are a storage and streaming unit, not a gameplay unit; villages (Phase 3) are placed in continent coordinates |
| River widths in Phase 1 data (1.6-6 units = 160-600 m) | Amazon-sized rivers | Corrected to true widths: Lumen 25-80 m, brooks 4-16 m |
| Village footprints in Phase 1 (up to 1.6 km radius) | City-sized | Corrected: 140-220 m radius, 10-30 buildings |
| Terrace corrections (up to 2 km) | Too broad | 300-400 m |
| Absolute heights 0-1,600 m vs the oblique 2.5D view (0.75 screen rows per metre, valley relief 74 m) | A 300 m hillside would lift the view by 225 rows | Continent mode draws heights relative to the loaded area and uses a lower relief scale |
| Grades on the blueprint (200 m samples) look gentle (under 5 %) | Real slopes only exist at fine scale | Navigation and grade tests run on the 1 m terrain |

## 5. Memory and why everything must stream

Per cell: terrain 10 B (`World`), shading cache 11 B (`TerrainShader`), water 52 B (13 float arrays), so about 73 B.

| What | Size |
|---|---|
| The whole continent at 1 m | 10¹⁰ x 73 B ≈ **730 GB**: impossible |
| Active window: 3 x 3 regions = 768 x 768 m | 590,000 cells x 73 B ≈ **43 MB** |
| Objects in the window (trees and rocks, dense forest) | about 10,000-15,000 objects, about 2-3 MB |
| Region cache (generated regions just outside the window, up to 24) | about 0.8 MB each, **about 20 MB** |
| Blueprint (macro elevation, regions, water) | about 3 MB |
| Total for continent mode | **about 70 MB** of arrays (the valley today: 34 MB heap in use) |

Target: 8 GB RAM, integrated graphics (not yet measured on the laptop).

## 6. Streaming architecture

```
 world/ data files ─▶ Blueprint (200 m) ─▶ ContinentTerrain (pure: position ─▶ height, water, biome; seamless)
                                                   │
                                         RegionGenerator (256 x 256 m: terrain, materials, cover,
                                         water levels, trees, rocks, paths)  ◀── runs in a worker
                                                   │
                                         RegionCache (LRU, bounded)
                                                   │
 Engine (unchanged renderers, water, editor) ◀── WorldWindow: one 768 x 768 World = 3 x 3 regions around the focus
```

- **ContinentTerrain** is a pure function of continent position, so any two regions agree exactly along their
  shared edge (seamless by construction), on the main thread, in a worker or on a future server.
- **WorldWindow**: the engine keeps working on one `World` (768 x 768). When the focus crosses into another region,
  the window moves by one region. Terrain, shading cache, water and objects shift by 256 cells, the newly exposed row
  or column of three regions is copied in from the cache, and the camera shifts by the same amount, so the view does not
  jump. Only the new strip is re-shaded.
- **Water**: the existing simulation runs on the window. Rivers enter through sources and leave through drains at the
  window boundary, so rivers keep flowing. Lakes and the sea are pre-filled to their levels. After a shift the water
  state is moved with the terrain (velocities restart).
- **Generation budget**: a dragon at 30 m/s crosses a region every 8.5 s and needs three new regions per crossing.
  Target under 300 ms per region in a worker, so prefetching one ring ahead is enough. A shift must cost under 50 ms on
  the main thread.
- **Not generated**: anything outside the window and cache. The six regions are never built at full detail together.
- **Persistence**: valley saves are unchanged (format v1). Continent edits (per-region diffs) are a later step. Until then,
  continent mode does not autosave over valley slots.
- **Navigation**: long routes are planned on the blueprint grid (the existing A*). Walking follows them at 1 m with
  local checks (grade, water, bridges at the blueprint's crossings).

## 7. Acceptance tests for Phase 2

| Test | Target |
|---|---|
| Seamless | Two adjacent regions generated independently match along their shared edge; no height step above the local slope |
| Drainage | Along every river at 1 m the water surface never rises; river cells hold water; lakes are flat at their level |
| Mountains and valleys | Dragon Peaks summit within 1,500-1,750 m; ridges and valleys present; Heartlands rolling (under 200 m local relief) |
| Biome transitions | Across a region border the dominant biome changes over at least 500 m, not at a line |
| Agreement with the blueprint | Mean height of 200 m blocks within 25 m of the blueprint (away from rivers) |
| Streaming | After any sequence of moves the window equals a fresh generation of the same regions; memory stays bounded |
| Navigation | Every pair of villages has a route; walking Lumenfall–Greenhaven at 1 m stays on walkable grades except at bridges |
| Performance (this machine) | Region generation and window shift measured; continent mode frame time measured in the browser |
| Regressions | All 130 unit tests and 58 browser tests still pass; the valley is unchanged |
