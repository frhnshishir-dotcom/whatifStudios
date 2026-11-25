import { SIZE, Biome, Use, Water, type Continent, type Trail, type Crossing, type LandStats, type Pt, type Special } from './types';
import { generateTerrain } from './terrain';
import { carveWater } from './hydrology';
import { placeTerritories, HABITAT_DESIGNS } from './wilds';
import { VILLAGE_DESIGNS } from './cultures';
import { layoutVillage, type PlaceContext } from './villages';
import { placeSpecials, placeOutposts } from './sites';
import { costGrid, findPath, makeTrail, crossingsOf, rasterize } from './trails';

const W = SIZE;

/**
 * The whole continent at design level, deterministic for a seed: terrain and biomes, rivers, lakes and marshes, dragon
 * territories and wildlife habitats, five villages, special locations, a sparse trail network and outposts, then the
 * land-use map and its statistics. Pure (no DOM); about a second in Node.
 */
export function generateContinent(seed = 1): Continent {
  const ms: Record<string, number> = {};
  let t0 = performance.now();
  const lap = (k: string) => { const t = performance.now(); ms[k] = Math.round(t - t0); t0 = t; };

  const { height, biome, forest } = generateTerrain(seed);
  lap('terrain');
  const water = new Uint8Array(W * W);
  const hydro = carveWater(seed, height, biome, forest, water);
  lap('water');
  const territories = placeTerritories(height, water, hydro.caves);
  const habitats = HABITAT_DESIGNS.map((h) => ({ ...h }));
  const occ = new Uint8Array(W * W);
  const ctx: PlaceContext = { seed, height, water, forest, occ, rivers: hydro.rivers, territories, habitats };
  const forestBefore = forest.slice();
  const villages = VILLAGE_DESIGNS.map((d) => layoutVillage(ctx, d));
  lap('villages');
  const sctx = { seed, height, biome, water, forest, occ, villages, territories, habitats };
  const specials = placeSpecials(sctx, hydro.falls, hydro.lakes, hydro.caves);
  lap('specials');

  // Footpaths between villages: the minimum spanning tree of terrain-following paths, plus the cheapest extra link.
  const cost = costGrid(height, biome, water, forest, occ, territories, habitats);
  const pairs: Array<{ a: number; b: number; pts: Pt[]; cost: number }> = [];
  for (let a = 0; a < villages.length; a++) for (let b = a + 1; b < villages.length; b++) {
    const p = findPath(cost, villages[a].centre, villages[b].centre);
    if (p) pairs.push({ a, b, pts: p.pts, cost: p.cost });
  }
  pairs.sort((p, q) => p.cost - q.cost);
  const parent = villages.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const chosen: typeof pairs = [];
  const extra: typeof pairs = [];
  for (const p of pairs) {
    const ra = root(p.a), rb = root(p.b);
    if (ra !== rb) { parent[ra] = rb; chosen.push(p); } else extra.push(p);
  }
  if (extra.length) chosen.push(extra[0]);
  const trails: Trail[] = chosen.map((p) => makeTrail(`path-${villages[p.a].id}-${villages[p.b].id}`, null, villages[p.a].id, villages[p.b].id, p.pts, biome, water));
  lap('paths');

  const outposts = placeOutposts(sctx, trails, specials);
  // The mountain pass: from Frostwatch up to the nearest mountain shelter.
  const fw = villages.find((v) => v.id === 'frostwatch');
  const shelter = outposts.filter((o) => o.kind === 'mountain-shelter').sort((a, b) => fw ? Math.hypot(a.x - fw.centre[0], a.y - fw.centre[1]) - Math.hypot(b.x - fw.centre[0], b.y - fw.centre[1]) : 0)[0];
  if (fw && shelter) {
    const p = findPath(cost, fw.centre, [shelter.x, shelter.y]);
    if (p) trails.push(makeTrail('pass-frostwatch', 'mountain-pass', fw.id, shelter.id, p.pts, biome, water));
  }
  // Spurs to outposts that are close to a path; the rest stay hidden in the wilds.
  const main = trails.flatMap((t) => t.cells);
  for (const o of outposts) {
    if (o.kind === 'travellers-camp') continue;
    let best: Pt | null = null, bd = 1e9;
    for (let k = 0; k < main.length; k += 2) { const d = Math.hypot(main[k][0] - o.x, main[k][1] - o.y); if (d < bd) { bd = d; best = main[k]; } }
    if (best && bd <= 45 && bd > 3) {
      const p = findPath(cost, [o.x, o.y], best);
      if (p) trails.push(makeTrail(`spur-${o.id}`, 'spur', o.id, 'path', p.pts, biome, water));
    }
  }
  const trailCellSet = new Set(trails.flatMap((t) => t.cells.map(([x, y]) => y * W + x)));
  for (const o of outposts) o.onTrail = o.kind === 'travellers-camp' || trails.some((t) => t.from === o.id || t.to === o.id) || nearSet(trailCellSet, o.x, o.y, 6);
  lap('outposts');

  // Ancient roads: broken, overgrown straight roads between pairs of ruins.
  const ruins = specials.filter((s) => s.kind === 'ruin');
  const ancient: Trail[] = [];
  const used = new Set<string>();
  for (const a of ruins) {
    const b = ruins.filter((q) => q !== a && !used.has(q.id)).map((q) => ({ q, d: Math.hypot(q.x - a.x, q.y - a.y) })).filter((e) => e.d > 110 && e.d < 280).sort((e, f) => e.d - f.d)[0];
    if (!b || used.has(a.id) || ancient.length >= 3) continue;
    used.add(a.id); used.add(b.q.id);
    const cells = rasterize([[a.x, a.y], [b.q.x, b.q.y]]).filter((_, k) => k % 26 >= 7);
    ancient.push({ id: `ancient-${ancient.length + 1}`, kind: 'ancient-road', from: a.id, to: b.q.id, cells: cells.filter(([x, y]) => water[y * W + x] === Water.None && biome[y * W + x] !== Biome.Sea) });
  }
  trails.push(...ancient);

  const hwAt = (x: number, y: number) => {
    let best = 1e9, hw = 1;
    for (const r of hydro.rivers) for (let k = 0; k < r.points.length; k += 4) { const d = Math.hypot(r.points[k][0] - x, r.points[k][1] - y); if (d < best) { best = d; hw = r.halfWidth[k]; } }
    return hw;
  };
  const crossings: Crossing[] = trails.filter((t) => t.kind !== 'ancient-road').flatMap((t) => crossingsOf(t, biome, water, hwAt));

  // Land use: special zones, then paths, old roads, outposts, and finally villages and their farmland on top.
  const use = new Uint8Array(W * W);
  const disc = (x: number, y: number, r: number, f: (i: number) => void) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < W && dx * dx + dy * dy <= r * r) f(yy * W + xx);
    }
  };
  const landDry = (i: number) => biome[i] !== Biome.Sea && water[i] === Water.None;
  for (const s of specials) disc(s.x, s.y, s.r, (i) => { if (landDry(i)) use[i] = Use.Special; });
  for (const t of trails) for (const [x, y] of t.cells) {
    const i = y * W + x;
    if (biome[i] === Biome.Sea) continue;
    use[i] = t.kind === 'ancient-road' ? (use[i] === Use.Wild ? Use.AncientRoad : use[i]) : Use.Trail;
  }
  for (const o of outposts) disc(o.x, o.y, 7, (i) => { if (landDry(i) && (use[i] === Use.Wild || use[i] === Use.Special)) use[i] = Use.Outpost; });
  for (const v of villages) {
    for (const b of v.buildings) for (let y = b.y - 3; y < b.y + b.h + 3; y++) for (let x = b.x - 3; x < b.x + b.w + 3; x++) {
      const i = y * W + x;
      if (biome[i] !== Biome.Sea && (water[i] === Water.None || b.raised)) use[i] = Use.Village;
    }
    for (const l of v.lanes) for (const [x, y] of l) use[y * W + x] = Use.Village;
    disc(v.centre[0], v.centre[1], 4, (i) => { if (landDry(i)) use[i] = Use.Village; });
    for (const f of [...v.fields, ...v.pens]) for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) use[y * W + x] = Use.Farmland;
  }
  // How much ancient forest each village cleared (raised tree houses and stilt houses clear nothing).
  for (const v of villages) {
    let area = 0, cleared = 0;
    const R = 110;
    for (let y = v.centre[1] - R; y <= v.centre[1] + R; y++) for (let x = v.centre[0] - R; x <= v.centre[0] + R; x++) {
      if (x < 0 || y < 0 || x >= W || y >= W) continue;
      const i = y * W + x;
      if (use[i] !== Use.Village && use[i] !== Use.Farmland) continue;
      if (Math.min(...villages.map((q) => Math.hypot(q.centre[0] - x, q.centre[1] - y))) < Math.hypot(v.centre[0] - x, v.centre[1] - y)) continue;
      area++;
      if (forestBefore[i] >= 215 && forest[i] < 215) cleared++;
    }
    v.clearedAncient = Math.round((cleared / Math.max(1, area)) * 1000) / 1000;
  }
  lap('landuse');

  const stats = landStats(biome, use, villages, territories, habitats, specials);
  lap('stats');
  return {
    seed, size: W, height, biome, water, use, forest, rivers: hydro.rivers, lakes: hydro.lakes, falls: hydro.falls, caves: hydro.caves,
    territories, habitats, villages, outposts, specials, trails, crossings, stats, ms,
  };
}

function nearSet(set: Set<number>, x: number, y: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (set.has((y + dy) * W + x + dx)) return true;
  return false;
}

function landStats(biome: Uint8Array, use: Uint8Array, villages: Continent['villages'], terr: Continent['territories'], hab: Continent['habitats'], specials: Special[]): LandStats {
  const counts = new Float64Array(8);
  let land = 0;
  for (let i = 0; i < W * W; i++) if (biome[i] !== Biome.Sea) { land++; counts[use[i]]++; }
  const pct = (n: number) => Math.round((n / land) * 10000) / 100;
  // Land within 10 cells of an active path (multi-source BFS, Chebyshev).
  const dist = new Uint8Array(W * W).fill(255);
  let frontier: number[] = [];
  for (let i = 0; i < W * W; i++) if (use[i] === Use.Trail) { dist[i] = 0; frontier.push(i); }
  for (let d = 1; d <= 10; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= W) continue;
        const j = yy * W + xx;
        if (dist[j] === 255) { dist[j] = d; next.push(j); }
      }
    }
    frontier = next;
  }
  let near = 0;
  for (let i = 0; i < W * W; i++) if (biome[i] !== Biome.Sea && dist[i] <= 10) near++;
  const disturbed = (cx: number, cy: number, r: number) => {
    let n = 0, bad = 0;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(W - 1, Math.ceil(cy + r)); y++) for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = y * W + x;
      if (biome[i] === Biome.Sea) continue;
      n++;
      const u = use[i];
      if (u === Use.Village || u === Use.Farmland || u === Use.Outpost || u === Use.Trail || u === Use.AncientRoad) bad++;
    }
    return [n, bad];
  };
  let tn = 0, tb = 0, hn = 0, hb = 0;
  for (const t of terr) { const [n, b] = disturbed(t.x, t.y, t.r); tn += n; tb += b; }
  for (const h of hab) { const [n, b] = disturbed(h.x, h.y, h.r * 0.75); hn += n; hb += b; }
  void specials;
  return {
    landCells: land,
    wilderness: pct(counts[Use.Wild]),
    settlements: pct(counts[Use.Village] + counts[Use.Farmland] + counts[Use.Outpost] + counts[Use.Trail]),
    special: pct(counts[Use.Special] + counts[Use.AncientRoad]),
    villages: pct(counts[Use.Village]), farmland: pct(counts[Use.Farmland]), outposts: pct(counts[Use.Outpost]), trails: pct(counts[Use.Trail]),
    nearTrail: pct(near),
    buildings: villages.reduce((s, v) => s + v.buildings.filter((b) => b.counts).length, 0),
    population: villages.reduce((s, v) => s + v.residents.length, 0),
    territoryDisturbance: Math.round((tb / Math.max(1, tn)) * 10000) / 100,
    habitatDisturbance: Math.round((hb / Math.max(1, hn)) * 10000) / 100,
  };
}
