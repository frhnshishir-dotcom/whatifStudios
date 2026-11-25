import { SIZE, Biome, Water, type Pt, type Trail, type TrailKind, type Crossing, type Territory, type Habitat } from './types';
import { OCC_BUILDING, OCC_FIELD, OCC_LANE } from './villages';

const W = SIZE, STEP = 4, G = SIZE / STEP;

/**
 * Travel cost on a coarse grid (4 x 4 cells per node): open, gentle ground is cheap; slopes cost quadratically, forest
 * and marsh more, river crossings a fixed premium (bridge or ford), lakes and sea are impassable, and dragon
 * territories and wildlife cores are avoided. Paths therefore follow valleys and contours, not straight lines.
 */
export function costGrid(height: Float32Array, biome: Uint8Array, water: Uint8Array, forest: Uint8Array, occ: Uint8Array, terr: Territory[], hab: Habitat[]): Float32Array {
  const cost = new Float32Array(G * G);
  const base: Record<number, number> = { [Biome.Heartlands]: 1, [Biome.GoldenPlains]: 1, [Biome.Elderwood]: 1.8, [Biome.Thornwild]: 2.2, [Biome.DragonPeaks]: 1.9, [Biome.WhisperingMarshes]: 2.4 };
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const x = gx * STEP + 2, y = gy * STEP + 2, i = y * W + x;
    const wv = water[i];
    if (biome[i] === Biome.Sea || wv === Water.Sea || wv === Water.Lake || gx < 1 || gy < 1 || gx >= G - 1 || gy >= G - 1) { cost[gy * G + gx] = Infinity; continue; }
    const hx = height[i + STEP] - height[i - STEP], hy = height[i + STEP * W] - height[i - STEP * W];
    const grade = Math.hypot(hx, hy) / (2 * STEP);
    let c = (base[biome[i]] ?? 1.5) + 30 * grade * grade + (forest[i] / 255) * 0.8;
    let river = false, building = false, field = false, lane = false;
    for (let dy = 0; dy < STEP; dy++) for (let dx = 0; dx < STEP; dx++) {
      const j = (gy * STEP + dy) * W + gx * STEP + dx;
      if (water[j] === Water.River) river = true;
      if (water[j] === Water.Lake) c += 50;
      if (occ[j] === OCC_BUILDING) building = true;
      else if (occ[j] === OCC_FIELD) field = true;
      else if (occ[j] === OCC_LANE) lane = true;
    }
    if (river) c += 14;
    if (wv === Water.Marsh) c += 3;
    if (building) c += 60;
    if (field) c += 2;
    if (lane) c = Math.max(0.6, c - 1);
    for (const t of terr) if ((x - t.x) ** 2 + (y - t.y) ** 2 < t.r * t.r) c += 400;
    for (const h of hab) if ((x - h.x) ** 2 + (y - h.y) ** 2 < (h.r * 0.75) ** 2) c += 25;
    cost[gy * G + gx] = c;
  }
  return cost;
}

/** A* over the coarse grid (8-connected, octile heuristic). Returns world points (node centres) and the path cost. */
export function findPath(cost: Float32Array, from: Pt, to: Pt): { pts: Pt[]; cost: number } | null {
  const sx = Math.min(G - 2, Math.max(1, Math.floor(from[0] / STEP))), sy = Math.min(G - 2, Math.max(1, Math.floor(from[1] / STEP)));
  const tx = Math.min(G - 2, Math.max(1, Math.floor(to[0] / STEP))), ty = Math.min(G - 2, Math.max(1, Math.floor(to[1] / STEP)));
  const n = G * G, g = new Float32Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
  const heap: number[] = [], f = new Float32Array(n);
  const push = (k: number) => {
    heap.push(k);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (f[heap[p]] <= f[k]) break; heap[i] = heap[p]; i = p; }
    heap[i] = k;
  };
  const pop = (): number => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const fm = () => (m === i ? f[last] : f[heap[m]]);
        if (l < heap.length && f[heap[l]] < fm()) m = l;
        if (r < heap.length && f[heap[r]] < fm()) m = r;
        if (m === i) break;
        heap[i] = heap[m]; i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  const hx = (k: number) => { const dx = Math.abs((k % G) - tx), dy = Math.abs(Math.floor(k / G) - ty); return 0.6 * (Math.max(dx, dy) + 0.414 * Math.min(dx, dy)); };
  const s = sy * G + sx, t = ty * G + tx;
  const cs = cost[s], ct = cost[t];
  cost[s] = Math.min(cs, 1); cost[t] = Math.min(ct, 1);
  g[s] = 0; f[s] = hx(s); push(s);
  let found = false;
  while (heap.length) {
    const k = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === t) { found = true; break; }
    const kx = k % G, ky = Math.floor(k / G);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = kx + dx, ny = ky + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      const m = ny * G + nx;
      if (closed[m] || cost[m] === Infinity) continue;
      const step = ((cost[k] + cost[m]) / 2) * (dx && dy ? 1.4142 : 1);
      const ng = g[k] + step;
      if (ng < g[m]) { g[m] = ng; came[m] = k; f[m] = ng + hx(m); push(m); }
    }
  }
  cost[s] = cs; cost[t] = ct;
  if (!found) return null;
  const nodes: Pt[] = [];
  for (let k = t; k !== -1; k = came[k]) nodes.push([(k % G) * STEP + 2, Math.floor(k / G) * STEP + 2]);
  nodes.reverse();
  nodes[0] = [from[0], from[1]];
  nodes[nodes.length - 1] = [to[0], to[1]];
  return { pts: nodes, cost: g[t] };
}

/** Chaikin smoothing (keeps the end points). */
function smooth(p: Pt[], iterations = 2): Pt[] {
  let a = p;
  for (let it = 0; it < iterations; it++) {
    const b: Pt[] = [a[0]];
    for (let i = 0; i < a.length - 1; i++) {
      const [x0, y0] = a[i], [x1, y1] = a[i + 1];
      b.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    b.push(a[a.length - 1]);
    a = b;
  }
  return a;
}

/** Cells along a polyline (no duplicates, 8-connected). */
export function rasterize(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n);
      const key = y * W + x;
      if (!seen.has(key)) { seen.add(key); out.push([x, y]); }
    }
  }
  return out;
}

export function kindAt(biome: number, water: number): TrailKind {
  if (water === Water.Marsh || biome === Biome.WhisperingMarshes) return 'boardwalk';
  if (biome === Biome.DragonPeaks) return 'mountain-pass';
  if (biome === Biome.Elderwood || biome === Biome.Thornwild) return 'forest-trail';
  return 'footpath';
}

/** Turn a coarse path into trail cells; smoothed unless smoothing would cut into a lake or the sea. */
export function makeTrail(id: string, kind: TrailKind | null, from: string, to: string, pts: Pt[], biome: Uint8Array, water: Uint8Array): Trail {
  let cells = rasterize(smooth(pts));
  if (cells.some(([x, y]) => water[y * W + x] === Water.Lake || water[y * W + x] === Water.Sea)) cells = rasterize(pts);
  let k = kind;
  if (!k) {
    const votes = new Map<TrailKind, number>();
    for (const [x, y] of cells) { const kk = kindAt(biome[y * W + x], water[y * W + x]); votes.set(kk, (votes.get(kk) ?? 0) + 1); }
    k = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return { id, kind: k, from, to, cells };
}

/** Bridges and fords where a trail meets a river; boardwalks across open marsh water. */
export function crossingsOf(t: Trail, biome: Uint8Array, water: Uint8Array, halfWidthAt: (x: number, y: number) => number): Crossing[] {
  const out: Crossing[] = [];
  let run: Pt[] = [], runKind = 0;
  const flush = () => {
    if (run.length) {
      const [x, y] = run[run.length >> 1];
      if (runKind === Water.River) {
        const b = biome[y * W + x];
        const rocky = b === Biome.DragonPeaks || b === Biome.Elderwood || b === Biome.Thornwild;
        out.push({ x, y, kind: rocky && halfWidthAt(x, y) <= 2.2 ? 'stone-crossing' : 'wooden-bridge', trail: t.id });
      } else if (run.length >= 3) out.push({ x, y, kind: 'boardwalk', trail: t.id });
    }
    run = []; runKind = 0;
  };
  for (const [x, y] of t.cells) {
    const w = water[y * W + x];
    if (w === Water.River || w === Water.Marsh) {
      if (runKind && runKind !== w) flush();
      runKind = w; run.push([x, y]);
    } else flush();
  }
  flush();
  return out;
}
