import type { World } from '../world/World';
import { Mat, Cover } from '../world/materials';
import { Rng, seedOf } from '../core/rng';
import { fbm, ridged, valueNoise } from '../core/noise';
import { smoothstep, clamp } from '../core/math';
import { assignSurface } from './terrain';
import type { ObjectStore } from '../objects/ObjectStore';

/**
 * Procedural fantasy landscape, built around its water:
 *  1. a meandering river spline from the northern highlands to the southern edge, with a distance / arc-length field;
 *  2. a river bed profile with one large and two small drops (waterfalls) and a gentle slope in between;
 *  3. terrain relative to the river: the regional level follows the bed of the nearest river point, so each fall
 *     becomes an escarpment facing the viewer (wiggled by noise away from the river); hills, highlands and rocky ridges
 *     rise with distance;
 *  4. channel, plunge pools, a lake, a mill race leaving and rejoining the river across an escarpment, small ponds;
 *  5. materials, a forest, banks, paths, a glowing glade, and objects (trees, rocks, mushrooms, bridge, cottage, mill).
 * Deterministic for a seed. `prefillWater` then sets water depths so the world starts flowing.
 */
export interface Feature { kind: string; x: number; y: number; note?: string }
export interface GenInfo {
  seed: number;
  river: Array<[number, number]>;
  source: [number, number];
  falls: Array<{ x: number; y: number; drop: number; big: boolean }>;
  features: Feature[];
  /** Per-cell water level to prefill (NaN = dry). */
  level: Float32Array;
}

const H0 = 25;

export function generateWorld(world: World, objects: ObjectStore, seed: number): GenInfo {
  const { w, h } = world;
  const rng = new Rng('world', seed);
  const ns = seedOf('wn', seed) % 9973;
  objects.clear();
  world.solid.fill(0);
  world.mat.fill(Mat.Grass);
  world.cover.fill(Cover.None);
  world.magic.fill(0);

  // ---- 1. River spline (control points every ~22 rows, smooth meanders, kept away from the sides)
  const ctrl: Array<[number, number]> = [];
  let cx = w * rng.range(0.38, 0.62);
  for (let y = -10; y <= h + 22; y += 22) {
    ctrl.push([cx, y]);
    cx = clamp(cx + rng.range(-26, 26) + (w / 2 - cx) * 0.18, 40, w - 40);
  }
  const pts: Array<[number, number]> = [];
  for (let k = 1; k < ctrl.length - 2; k++) {
    const [p0, p1, p2, p3] = [ctrl[k - 1], ctrl[k], ctrl[k + 1], ctrl[k + 2]];
    for (let t = 0; t < 1; t += 0.02) {
      const t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const x = f(p0[0], p1[0], p2[0], p3[0]), y = f(p0[1], p1[1], p2[1], p3[1]);
      if (y >= 0 && y < h) pts.push([x, y]);
    }
  }
  const S = new Float32Array(pts.length);
  for (let k = 1; k < pts.length; k++) S[k] = S[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  const L = S[S.length - 1];

  // ---- 2. Bed profile: one large and two small drops at seeded positions along the river.
  const pos = [rng.range(0.27, 0.36), rng.range(0.5, 0.58), rng.range(0.72, 0.8)];
  const bigAt = rng.int(0, 2);
  const drops = pos.map((p, k) => ({ s: p * L, drop: k === bigAt ? rng.range(9, 10.5) : rng.range(3.2, 4), big: k === bigAt }));
  const slope = 0.008;
  const bed = (s: number) => {
    let b = H0 - slope * s;
    for (const d of drops) if (s >= d.s) b -= d.drop;
    return b;
  };
  // Far from the river the escarpments soften into long slopes, so cliffs stay local to the valley.
  const bedSoft = (s: number) => {
    let b = H0 - slope * s;
    for (const d of drops) b -= d.drop * smoothstep(d.s - 34, d.s + 34, s);
    return b;
  };
  // Channel half-width: widens downstream and around each fall (the big fall gets a broad curtain).
  const cw = (s: number) => {
    let c = 1.4 + 2.2 * (s / L);
    for (const d of drops) c += (d.big ? 2.2 : 0.8) * Math.exp(-(((s - d.s) / 9) ** 2));
    return c;
  };
  // 1 on the flat stone lip just above a fall (water spreads across the whole width before it drops).
  const lipAt = (s: number) => {
    let l = 0;
    for (const d of drops) if (s < d.s + 0.5) l = Math.max(l, 1 - smoothstep(1.5, 5, d.s - s));
    return l;
  };
  const riverAt = (s: number): [number, number] => {
    let k = 0;
    while (k < S.length - 1 && S[k + 1] < s) k++;
    const t = S[k + 1] > S[k] ? (s - S[k]) / (S[k + 1] - S[k]) : 0;
    const a = pts[k], b = pts[Math.min(k + 1, pts.length - 1)];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  // ---- Nearest river point per cell: seed the raster, then two chamfer passes propagating the nearest seed.
  const N = w * h;
  const nx = new Float32Array(N).fill(-1e6), ny = new Float32Array(N).fill(-1e6), nsv = new Float32Array(N), dist = new Float32Array(N).fill(1e9);
  for (let k = 0; k < pts.length; k++) {
    const x = Math.round(pts[k][0]), y = Math.round(pts[k][1]);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x, d = Math.hypot(x - pts[k][0], y - pts[k][1]);
    if (d < dist[i]) { dist[i] = d; nx[i] = pts[k][0]; ny[i] = pts[k][1]; nsv[i] = S[k]; }
  }
  const relax = (i: number, j: number, x: number, y: number) => {
    if (dist[j] >= 1e9) return;
    const d = Math.hypot(x - nx[j], y - ny[j]);
    if (d < dist[i]) { dist[i] = d; nx[i] = nx[j]; ny[i] = ny[j]; nsv[i] = nsv[j]; }
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) relax(i, i - 1, x, y);
    if (y > 0) { relax(i, i - w, x, y); if (x > 0) relax(i, i - w - 1, x, y); if (x < w - 1) relax(i, i - w + 1, x, y); }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x < w - 1) relax(i, i + 1, x, y);
    if (y < h - 1) { relax(i, i + w, x, y); if (x < w - 1) relax(i, i + w + 1, x, y); if (x > 0) relax(i, i + w - 1, x, y); }
  }

  // ---- 3. Terrain relative to the river.
  const level = new Float32Array(N).fill(NaN);
  // Regional level: the bed of the nearest river point (wiggled away from the river). Where the nearest point jumps
  // between distant stretches (the medial axis between meanders) this field is discontinuous, so far from the river
  // it is replaced by a heavily blurred copy: sharp escarpments next to the river, smooth slopes elsewhere.
  const Rraw = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, d = dist[i], s = nsv[i];
    const sWig = s + (fbm(x / 26, y / 26, 3, ns + 3) - 0.5) * 18 * smoothstep(4, 22, d);
    Rraw[i] = bed(sWig) + (bedSoft(sWig) - bed(sWig)) * smoothstep(12, 38, d);
  }
  const Rblur = boxBlur(boxBlur(boxBlur(Rraw, w, h, 9), w, h, 9), w, h, 9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, d = dist[i], s = nsv[i];
    const away = smoothstep(4, 22, d);
    const R = Rraw[i] + (Rblur[i] - Rraw[i]) * smoothstep(5, 24, d);
    const hills = fbm(x / 48, y / 48, 4, ns + 5);
    const rock = ridged(x / 38, y / 38, 4, ns + 7);
    const north = Math.pow(clamp(1 - y / (h * 0.55), 0, 1), 1.6);
    const c = cw(s);
    let e: number;
    if (d < c) {
      const lp = lipAt(s);
      e = R - 0.95 * (1 - (d / c) ** 2) * (1 - lp) - 0.32 * lp;
    }
    else {
      const bank = smoothstep(c, c + 2.5, d) * 0.35;
      e = R + bank + Math.max(0, d - c - 2) * 0.045 + hills * 6 * smoothstep(6, 46, d) + north * 7 * smoothstep(10, 50, d) + rock * rock * 6 * smoothstep(14, 44, d);
      e += (fbm(x / 9, y / 9, 2, ns + 11) - 0.5) * 0.7 * away;
    }
    world.elev[i] = e;
    if (d < c + 0.6) level[i] = bed(s) - 0.18;
  }

  // ---- 4. Water bodies.
  const carveBasin = (px: number, py: number, rx: number, ry: number, depth: number, lvl: number, skip?: (i: number) => boolean) => {
    for (let y = Math.floor(py - ry - 1); y <= py + ry + 1; y++) for (let x = Math.floor(px - rx - 1); x <= px + rx + 1; x++) {
      if (!world.inBounds(x, y)) continue;
      const n = ((x - px) / rx) ** 2 + ((y - py) / ry) ** 2 + (valueNoise(x * 0.4, y * 0.4, ns + 13) - 0.5) * 0.25;
      if (n > 1) continue;
      const i = y * w + x;
      if (skip?.(i)) continue;
      world.elev[i] = Math.min(world.elev[i], lvl + 0.15 - depth * (1 - n));
      level[i] = lvl;
    }
  };
  const falls: GenInfo['falls'] = [];
  const features: Feature[] = [];
  for (const d of drops) {
    const [px, py] = riverAt(d.s + (d.big ? 5 : 3.5));
    // Only below the drop: the pool must not notch the lip upstream.
    carveBasin(px, py, d.big ? 7 : 4.8, d.big ? 5.5 : 3.8, d.big ? 1.6 : 1.2, bed(d.s + 6) - 0.18, (i) => nsv[i] < d.s + 0.5 && dist[i] < 14);
    const [fx, fy] = riverAt(d.s - 0.5);
    falls.push({ x: Math.round(fx), y: Math.round(fy), drop: d.drop, big: d.big });
    features.push({ kind: d.big ? 'large waterfall' : 'waterfall', x: Math.round(fx), y: Math.round(fy) });
  }
  // Lake on the longest gentle stretch between two falls.
  const segs = [0, ...drops.map((d) => d.s).sort((a, b) => a - b), L];
  let bestSeg = 0;
  for (let k = 1; k < segs.length - 1; k++) if (segs[k + 1] - segs[k] > segs[bestSeg + 1] - segs[bestSeg] && k > 0) bestSeg = k;
  const sLake = segs[bestSeg] + (segs[bestSeg + 1] - segs[bestSeg]) * 0.55;
  const [lx, ly] = riverAt(sLake);
  carveBasin(lx, ly, rng.range(11, 14), rng.range(7, 9), 1.8, bed(sLake) - 0.18);
  features.push({ kind: 'lake', x: Math.round(lx), y: Math.round(ly) });

  // Mill race: leaves the river above a small fall, bulges away, drops at the same escarpment, rejoins below.
  const small = drops.filter((d) => !d.big).sort((a, b) => a.s - b.s)[0];
  const side = rng.chance(0.5) ? 1 : -1;
  const sa = small.s - 26, sb = small.s + 16;
  const race: Array<[number, number, number]> = [];
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const s = sa + (sb - sa) * t;
    const [rx, ry] = riverAt(s), [qx, qy] = riverAt(s + 1);
    const dl = Math.hypot(qx - rx, qy - ry) || 1;
    const off = side * 9 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    race.push([rx - ((qy - ry) / dl) * off, ry + ((qx - rx) / dl) * off, s]);
  }
  let wheelAt: [number, number] | null = null;
  for (const [px, py, s] of race) {
    for (let y = Math.floor(py - 3); y <= py + 3; y++) for (let x = Math.floor(px - 3); x <= px + 3; x++) {
      if (!world.inBounds(x, y)) continue;
      const i = y * w + x, d = Math.hypot(x - px, y - py);
      if (dist[i] < cw(nsv[i]) + 0.3) continue; // the river itself
      const lvl = bed(s) - 0.25; // just below the river surface, so the race draws water from it
      if (d < 1.25) { world.elev[i] = Math.min(world.elev[i], lvl - 0.6); level[i] = lvl; world.mat[i] = Mat.Sand; }
      else if (d < 2.3 && !(level[i] === level[i])) { world.elev[i] = Math.max(Math.min(world.elev[i], lvl + 0.35), lvl + 0.15); world.mat[i] = Mat.Path; }
    }
    if (!wheelAt && s >= small.s) wheelAt = [Math.round(px), Math.round(py)];
  }
  features.push({ kind: 'mill race', x: Math.round(race[50][0]), y: Math.round(race[50][1]) });

  // Small ponds away from the river, on fairly level ground; the water level sits below the lowest rim cell.
  for (let k = 0, tries = 0; k < 3 && tries < 400; tries++) {
    const px = rng.range(24, w - 24), py = rng.range(h * 0.35, h - 20);
    const i = Math.round(py) * w + Math.round(px);
    if (dist[i] < 26 || features.some((f) => f.kind === 'pond' && Math.hypot(f.x - px, f.y - py) < 30)) continue;
    const r = rng.range(4, 6.5), ry = r * 0.75;
    let rimMin = 1e9, rimMax = -1e9;
    for (let a = 0; a < 32; a++) {
      const x = Math.round(px + Math.cos((a / 32) * Math.PI * 2) * (r + 1.5)), y = Math.round(py + Math.sin((a / 32) * Math.PI * 2) * (ry + 1.5));
      const e = world.elevAt(x, y);
      rimMin = Math.min(rimMin, e); rimMax = Math.max(rimMax, e);
    }
    if (rimMax - rimMin > 1.6) continue;
    carveBasin(px, py, r, ry, 1.2, rimMin - 0.2);
    features.push({ kind: 'pond', x: Math.round(px), y: Math.round(py) });
    k++;
  }

  // ---- 5. Surface, then water-side overrides.
  assignSurface(world, seed);
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i / w) | 0, d = dist[i], c = cw(nsv[i]);
    const wet = level[i] === level[i];
    const m = Math.round(clamp(Math.max(world.moisture[i] / 255, 1 - (wet ? 0 : d) / 18), 0, 1) * 255);
    world.moisture[i] = m;
    if (world.mat[i] === Mat.Path) { world.cover[i] = Cover.None; continue; }
    if (wet) { world.mat[i] = world.elev[i] < (level[i] - 0.6) ? Mat.Mud : Mat.Sand; world.cover[i] = Cover.None; continue; }
    if (d < c + 1.8) { world.mat[i] = valueNoise(x * 0.5, y * 0.5, ns + 17) > 0.55 ? Mat.Mud : Mat.Sand; world.cover[i] = valueNoise(x * 0.7, y * 0.7, ns + 19) > 0.62 ? Cover.Reeds : Cover.None; }
    else if (d < c + 4 && world.mat[i] !== Mat.Cliff) { world.mat[i] = Mat.Moss; world.cover[i] = valueNoise(x * 0.6, y * 0.6, ns + 23) > 0.5 ? Cover.Fern : Cover.MossPatch; }
  }
  // Stone river bed at the lips and under each curtain (the fall face shows rock, not soil).
  for (let i = 0; i < N; i++) {
    if (!(level[i] === level[i]) || dist[i] > cw(nsv[i]) + 1) continue;
    for (const d of drops) if (Math.abs(nsv[i] - d.s) < 4) { world.mat[i] = Mat.Stone; world.cover[i] = Cover.None; }
  }
  // Mossy stone at the waterfall lips.
  for (const f of falls) for (let y = f.y - 4; y <= f.y + 3; y++) for (let x = f.x - 7; x <= f.x + 7; x++) {
    if (!world.inBounds(x, y)) continue;
    const i = y * w + x;
    if (level[i] === level[i]) continue;
    world.mat[i] = valueNoise(x * 0.8, y * 0.8, ns + 29) > 0.5 ? Mat.Moss : Mat.Stone;
    world.cover[i] = world.mat[i] === Mat.Moss ? Cover.MossPatch : Cover.None;
  }

  // Clearings around structures (no trees or rocks in front of them).
  const clear = new Uint8Array(N);
  const clearRect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) clear[y * w + x] = 1;
  };
  // ---- Structures: bridge, cottage, mill, paths.
  const segMid = (k: number) => segs[k] + (segs[k + 1] - segs[k]) * (k === bestSeg ? 0.18 : 0.5);
  let bridgeSeg = (bestSeg + 1) % (segs.length - 1);
  if (segs[bridgeSeg + 1] - segs[bridgeSeg] < 30) bridgeSeg = bestSeg;
  const sBridge = segMid(bridgeSeg);
  const [bx, by] = riverAt(sBridge);
  const half = Math.ceil(cw(sBridge) + 2);
  const byi = Math.round(by), bx0 = Math.round(bx) - half, bx1 = Math.round(bx) + half;
  const deck = Math.max(world.elevAt(bx0, byi), world.elevAt(bx1, byi), bed(sBridge)) + 0.45;
  objects.add({ kind: 'bridge', x: bx0, y: byi, variant: 'wood', props: { length: bx1 - bx0 + 1, z: deck } });
  features.push({ kind: 'bridge', x: Math.round(bx), y: byi });
  clearRect(bx0 - 3, byi - 3, bx1 + 3, byi + 4);

  const flatten = (x0: number, y0: number, fw: number, fh: number, to?: number) => {
    let sum = 0, n = 0;
    for (let y = y0; y < y0 + fh; y++) for (let x = x0; x < x0 + fw; x++) if (world.inBounds(x, y)) { sum += world.elev[y * w + x]; n++; }
    const z = to ?? sum / Math.max(1, n);
    for (let y = y0 - 1; y <= y0 + fh; y++) for (let x = x0 - 1; x <= x0 + fw; x++) {
      if (!world.inBounds(x, y)) continue;
      const i = y * w + x, edge = x < x0 || y < y0 || x >= x0 + fw || y >= y0 + fh;
      if (level[i] === level[i]) continue;
      world.elev[i] = edge ? (world.elev[i] + z) / 2 : z;
      if (!edge) { world.mat[i] = Mat.Dirt; world.cover[i] = Cover.None; }
    }
    return z;
  };
  const dryFlat = (x: number, y: number, fw: number, fh: number) => {
    for (let yy = y - 1; yy <= y + fh; yy++) for (let xx = x - 1; xx <= x + fw; xx++) {
      if (!world.inBounds(xx, yy)) return false;
      const i = yy * w + xx;
      if (level[i] === level[i] || objects.occ[i]) return false;
    }
    let mn = 1e9, mx = -1e9;
    for (let yy = y; yy < y + fh; yy++) for (let xx = x; xx < x + fw; xx++) { const e = world.elev[yy * w + xx]; mn = Math.min(mn, e); mx = Math.max(mx, e); }
    return mx - mn < 1.2;
  };
  // Cottage: near one end of the bridge, on dry level ground.
  const cotSide = rng.chance(0.5) ? -1 : 1;
  let cottage: [number, number] | null = null;
  for (let r = 6; r < 26 && !cottage; r++) for (let a = 0; a < 16 && !cottage; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const x = Math.round((cotSide < 0 ? bx0 : bx1) + cotSide * r * Math.abs(Math.cos(ang)) - 2), y = Math.round(byi + r * Math.sin(ang) - 1);
    if (dryFlat(x, y, 5, 3)) cottage = [x, y];
  }
  if (cottage) {
    flatten(cottage[0], cottage[1], 5, 3);
    objects.add({ kind: 'cottage', x: cottage[0], y: cottage[1], variant: rng.chance(0.7) ? 'terracotta' : 'slate', props: {} });
    features.push({ kind: 'cottage', x: cottage[0], y: cottage[1] });
    clearRect(cottage[0] - 3, cottage[1] - 4, cottage[0] + 8, cottage[1] + 7);
    carvePath(world, [[cottage[0] + 2, cottage[1] + 3], [cotSide < 0 ? bx0 - 1 : bx1 + 1, byi]], level);
    // Garden: flowers around the cottage.
    for (let y = cottage[1] - 2; y <= cottage[1] + 5; y++) for (let x = cottage[0] - 3; x <= cottage[0] + 7; x++) {
      if (!world.inBounds(x, y)) continue;
      const i = y * w + x;
      if (objects.occ[i] || world.mat[i] === Mat.Path || level[i] === level[i]) continue;
      if (valueNoise(x * 0.9, y * 0.9, ns + 31) > 0.45) { world.cover[i] = Cover.Flowers; world.coverVar[i] = (x + y * 3) % 6; }
    }
  }
  // Mill beside the race: the house on dry ground, its wheel (3x3, centred 2 cells outside the house on the
  // wheelSide) standing in the race water just below the race's drop.
  if (wheelAt) {
    const [wx, wy] = wheelAt;
    let best: { x: number; y: number; side: number; score: number } | null = null;
    for (const side of [1, -1]) for (let yy = wy - 12; yy <= wy + 8; yy++) for (let ax = wx - 16; ax <= wx + 12; ax++) {
      const cxw = side > 0 ? ax + 5 : ax - 2, cyw = yy + 2;
      if (!world.inBounds(cxw, cyw) || !(level[cyw * w + cxw] === level[cyw * w + cxw])) continue;
      let ok = true;
      for (let y = yy - 1; y <= yy + 3 && ok; y++) for (let x = ax - 1; x <= ax + 4 && ok; x++) {
        if (!world.inBounds(x, y) || objects.occ[y * w + x]) ok = false;
        else if (y >= yy && y < yy + 3 && x >= ax && x < ax + 4 && level[y * w + x] === level[y * w + x]) ok = false;
      }
      if (!ok) continue;
      const score = Math.hypot(cxw - wx, cyw - wy) + (dist[cyw * w + cxw] < cw(nsv[cyw * w + cxw]) + 1 ? 6 : 0);
      if (!best || score < best.score) best = { x: ax, y: yy, side, score };
    }
    if (best) {
      flatten(best.x, best.y, 4, 3);
      if (objects.add({ kind: 'mill', x: best.x, y: best.y, variant: 'stone', props: { wheelSide: best.side } }) !== null) {
        features.push({ kind: 'water mill', x: best.x, y: best.y });
        clearRect(best.x - 5, best.y - 4, best.x + 9, best.y + 7);
        carvePath(world, [[best.x + 2, best.y + 3], [cotSide < 0 ? bx1 + 1 : bx0 - 1, byi]], level);
      }
    }
  }

  // ---- Glowing glade: far from the river, among the trees.
  let glade: [number, number] | null = null;
  for (let tries = 0; tries < 400 && !glade; tries++) {
    const x = Math.round(rng.range(34, w - 34)), y = Math.round(rng.range(h * 0.25, h - 30));
    const i = y * w + x;
    if (dist[i] < 34 || !dryFlat(x - 4, y - 3, 9, 7)) continue;
    glade = [x, y];
  }
  if (glade) {
    const [gx, gy] = glade;
    for (let y = gy - 10; y <= gy + 10; y++) for (let x = gx - 12; x <= gx + 12; x++) {
      if (!world.inBounds(x, y)) continue;
      const i = y * w + x, r = Math.hypot((x - gx) / 1.2, y - gy);
      if (r > 10 || level[i] === level[i]) continue;
      world.magic[i] = Math.round(255 * (1 - r / 10));
      if (r < 7) { world.mat[i] = Mat.Glade; world.cover[i] = valueNoise(x, y, ns + 37) > 0.62 ? Cover.Flowers : Cover.None; world.coverVar[i] = 3 + ((x + y) % 2) * 2; }
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + 0.3;
      objects.add({ kind: 'stone', x: Math.round(gx + Math.cos(a) * 7.5), y: Math.round(gy + Math.sin(a) * 5.5), variant: 'rune', props: { glow: 1 } });
    }
    objects.add({ kind: 'tree', x: gx, y: gy, variant: 'blossom', props: { size: 3, seed: rng.int(0, 999) } });
    for (let k = 0; k < 16; k++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(2, 6.5);
      objects.add({ kind: 'mushroom', x: Math.round(gx + Math.cos(a) * r * 1.2), y: Math.round(gy + Math.sin(a) * r), variant: rng.chance(0.5) ? 'glow' : 'violet', props: { count: rng.int(1, 3) } });
    }
    features.push({ kind: 'glowing glade', x: gx, y: gy });
  }

  // ---- Rocks at the fall lips and along banks; formations on the highlands.
  for (const f of falls) for (const sx of [-1, 1]) {
    const c = cw(nsv[f.y * w + f.x]);
    objects.add({ kind: 'rock', x: Math.round(f.x + sx * (c + 1.5)) - (sx < 0 ? 2 : 0), y: f.y - 1, variant: 'formation', props: { moss: 1, seed: rng.int(0, 999) } });
  }
  // ---- Trees, rocks and mushrooms by habitat (one candidate per jittered 3x3 cell block).
  for (let by0 = 0; by0 < h; by0 += 3) for (let bx0b = 0; bx0b < w; bx0b += 3) {
    const x = bx0b + rng.int(0, 2), y = by0 + rng.int(0, 2);
    if (!world.inBounds(x, y)) continue;
    const i = y * w + x;
    if (level[i] === level[i] || clear[i] || world.mat[i] === Mat.Path || world.mat[i] === Mat.Glade || objects.occ[i]) continue;
    const m = world.mat[i], d = dist[i], e = world.elev[i];
    const r = rng.float();
    if (m === Mat.ForestFloor) {
      if (r < 0.72) objects.add({ kind: 'tree', x, y, variant: e > 16 ? (rng.chance(0.7) ? 'pine' : 'oak') : rng.pick(['oak', 'oak', 'pine', 'birch']), props: { size: rng.int(1, 3), seed: rng.int(0, 999) } });
      else if (r < 0.8) objects.add({ kind: 'mushroom', x, y, variant: rng.chance(0.6) ? 'red' : 'brown', props: { count: rng.int(1, 3) } });
    } else if (d > cw(nsv[i]) + 1.5 && d < cw(nsv[i]) + 5 && r < 0.09) {
      objects.add({ kind: 'tree', x, y, variant: 'willow', props: { size: rng.int(1, 2), seed: rng.int(0, 999) } });
    } else if (d < cw(nsv[i]) + 3.5 && r < 0.12) {
      objects.add({ kind: 'rock', x, y, variant: 'boulder', props: { moss: rng.chance(0.5) ? 1 : 0, seed: rng.int(0, 999) } });
    } else if ((m === Mat.Stone || m === Mat.Cliff) && r < 0.06) {
      objects.add({ kind: 'rock', x, y, variant: rng.chance(0.3) ? 'formation' : 'big', props: { moss: rng.chance(0.3) ? 1 : 0, seed: rng.int(0, 999) } });
    } else if ((m === Mat.Grass || m === Mat.Meadow) && r < 0.035) {
      objects.add({ kind: 'tree', x, y, variant: rng.pick(['oak', 'birch', 'oak', 'pine']), props: { size: rng.int(1, 3), seed: rng.int(0, 999) } });
    }
  }

  // Source just below the top of the river.
  const [sx0, sy0] = riverAt(Math.min(L * 0.03, 8));
  world.markAllDirty();
  return { seed, river: pts.map(([x, y]) => [Math.round(x), Math.round(y)]), source: [Math.round(sx0), Math.round(sy0)], falls, features, level };
}

/** Separable box blur with clamped edges (running sums). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * k;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * k;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Lay a stone path along a polyline (2 cells wide, slight wobble), skipping water. */
function carvePath(world: World, pts: Array<[number, number]>, level: Float32Array): void {
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      const wob = Math.sin(t * Math.PI * 2 + ax) * 1.2;
      const x = Math.round(ax + (bx - ax) * t + wob * 0.4), y = Math.round(ay + (by - ay) * t + wob * 0.3);
      for (const [dx, dy] of [[0, 0], [1, 0]]) {
        const xx = x + dx, yy = y + dy;
        if (!world.inBounds(xx, yy)) continue;
        const i = yy * world.w + xx;
        if (level[i] === level[i]) continue;
        world.mat[i] = Mat.Path;
        world.cover[i] = Cover.None;
      }
    }
  }
}

/** Set initial water depth from the generator's level map (before the simulation starts). */
export function prefillWater(world: World, depth: Float32Array, info: GenInfo): number {
  let total = 0;
  for (let i = 0; i < world.n; i++) {
    const lv = info.level[i];
    if (lv === lv && !world.solid[i]) {
      const d = Math.max(0, lv - world.elev[i]);
      depth[i] = d;
      total += d;
    }
  }
  return total;
}
