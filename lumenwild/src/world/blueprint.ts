import type { WorldData, MapPt, Region } from './schema';
import { WorldCoords } from './coords';
import { fbm, ridged } from '../engine/core/noise';
import { seedOf } from '../engine/core/rng';
import { smoothstep } from '../engine/core/math';
import { findPath } from '../engine/continent/trails';

/**
 * Phase 1 map blueprint: the authored world data turned into a design-resolution elevation field (2 map units per
 * sample), water, regions, routed roads and dragon corridors, plus the geography checks the specification asks for.
 * It is a design tool, not the game terrain: Phase 2 generates playable terrain from the same data.
 */

export const W_NONE = 0, W_SEA = 1, W_LAKE = 2, W_RIVER = 3, W_MARSH = 4;

export interface RiverProfile {
  id: string; name: string; pts: MapPt[]; surface: number[];
  /** Largest rise of the uncarved ground above the lowest point upstream of it (m): a barrier the river would have to cut. */
  barrier: number;
  falls: Array<{ at: MapPt; drop: number }>;
  mouthOk: boolean; joinOk: boolean; detail: string;
}
export interface RoutedRoad {
  id: string; name: string; cls: string; pts: MapPt[];
  length: number; straight: number; maxGrade: number; meanGrade: number;
  /** Where the steepest stretch is. */
  maxGradeAt: MapPt;
  bridges: Array<{ at: MapPt; river: string; name?: string }>;
  legs: number; ok: boolean; detail: string;
}
export interface Corridor { from: string; to: string; a: MapPt; b: MapPt; maxGround: number; cruise: number; climbGrade: number; overflights: Array<{ id: string; agl: number }>; ok: boolean }
export interface SettlementCheck { id: string; region: string; slope: number; waterDist: number; roads: number; ok: boolean; issues: string[] }
export interface Check { id: string; ok: boolean; detail: string }

export interface Blueprint {
  data: WorldData; coords: WorldCoords;
  /** Samples per side and map units per sample. */
  N: number; unit: number;
  elev: Float32Array; region: Int8Array; water: Uint8Array; slope: Float32Array;
  rivers: RiverProfile[]; lakeLevels: Record<string, number>; roads: RoutedRoad[]; corridors: Corridor[];
  landing: Record<string, MapPt[]>; settlements: SettlementCheck[];
  regionStats: Record<string, { p10: number; p50: number; p90: number; share: number }>;
  checks: Check[]; ms: Record<string, number>;
}

/** Closest point on a polyline: distance, the segment parameter and the index of the segment. */
function nearestOnLine(line: ArrayLike<number>[], x: number, y: number): { d: number; seg: number; t: number } {
  let best = Infinity, seg = 0, bt = 0;
  for (let k = 0; k < line.length - 1; k++) {
    const ax = line[k][0], ay = line[k][1], bx = line[k + 1][0], by = line[k + 1][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) { best = d; seg = k; bt = t; }
  }
  return { d: best, seg, t: bt };
}

function chaikin(p: MapPt[], it = 2, closed = false): MapPt[] {
  let a = p;
  for (let k = 0; k < it; k++) {
    const b: MapPt[] = closed ? [] : [a[0]];
    const n = closed ? a.length : a.length - 1;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = a[i], [x1, y1] = a[(i + 1) % a.length];
      b.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    if (!closed) b.push(a[a.length - 1]);
    a = b;
  }
  return a;
}

/** Points every `step` map units along a polyline. */
function resample(p: MapPt[], step: number): MapPt[] {
  const out: MapPt[] = [p[0]];
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1], L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

/** Two-pass chamfer distance (in samples) from cells where `src` is true. */
function distance(N: number, src: (i: number) => boolean): Float32Array {
  const d = new Float32Array(N * N).fill(1e9);
  for (let i = 0; i < N * N; i++) if (src(i)) d[i] = 0;
  const R2 = Math.SQRT2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
    if (y > 0) { d[i] = Math.min(d[i], d[i - N] + 1); if (x > 0) d[i] = Math.min(d[i], d[i - N - 1] + R2); if (x < N - 1) d[i] = Math.min(d[i], d[i - N + 1] + R2); }
  }
  for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
    const i = y * N + x;
    if (x < N - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
    if (y < N - 1) { d[i] = Math.min(d[i], d[i + N] + 1); if (x < N - 1) d[i] = Math.min(d[i], d[i + N + 1] + R2); if (x > 0) d[i] = Math.min(d[i], d[i + N - 1] + R2); }
  }
  return d;
}

/** Two passes of a separable box blur (radius in samples). */
function blur(N: number, f: Float32Array, R: number): Float32Array {
  let a = Float32Array.from(f), b = new Float32Array(N * N);
  for (let pass = 0; pass < 2; pass++) for (const horiz of [true, false]) {
    for (let line = 0; line < N; line++) {
      const at = (q: number) => { const qq = Math.max(0, Math.min(N - 1, q)); return horiz ? line * N + qq : qq * N + line; };
      let sum = 0;
      for (let q = -R; q <= R; q++) sum += a[at(q)];
      for (let q = 0; q < N; q++) { b[at(q)] = sum / (2 * R + 1); sum += a[at(q + R + 1)] - a[at(q - R)]; }
    }
    [a, b] = [b, a];
  }
  return a;
}

export function buildBlueprint(data: WorldData): Blueprint {
  const ms: Record<string, number> = {};
  let t0 = performance.now();
  const lap = (k: string) => { const t = performance.now(); ms[k] = Math.round(t - t0); t0 = t; };
  const coords = new WorldCoords(data.coordinates);
  const N = coords.blueprintN, U = data.coordinates.blueprintSampleUnits, mpu = coords.metresPerUnit;
  const salt = seedOf('blueprint', data.world.seed) % 100000;
  const mx = (i: number) => (i + 0.5) * U;

  // 1. Coastline: smoothed, ragged outline; land by scanline fill.
  const raw = chaikin(data.coastline.points, 3, true);
  const outline: MapPt[] = raw.map((p, k) => {
    const q = raw[(k + 1) % raw.length], o = raw[(k - 1 + raw.length) % raw.length];
    const tx = q[0] - o[0], ty = q[1] - o[1], tl = Math.hypot(tx, ty) || 1;
    const n = (fbm(p[0] * 0.03, p[1] * 0.03, 4, salt + 1) - 0.5) * 2 * data.coastline.raggedness;
    return [p[0] + (ty / tl) * n, p[1] - (tx / tl) * n];
  });
  const land = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const y = mx(j), xs: number[] = [];
    for (let k = 0; k < outline.length; k++) {
      const [x0, y0] = outline[k], [x1, y1] = outline[(k + 1) % outline.length];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let i = Math.max(0, Math.ceil(xs[k] / U - 0.5)); i <= Math.min(N - 1, Math.floor(xs[k + 1] / U - 0.5)); i++) land[j * N + i] = 1;
    }
  }
  // Chamfer distances step on diagonal coasts; a light blur keeps the coastal slope (and its shading) smooth.
  const coastD = blur(N, distance(N, (i) => land[i] === 0), 3);
  const seaD = distance(N, (i) => land[i] === 1);
  lap('coast');

  // 2. Regions (warped nearest anchor, soft-blended base planes).
  const regions = data.regions;
  const region = new Int8Array(N * N).fill(-1);
  const elev = new Float32Array(N * N);
  const plane = (r: Region, x: number, y: number) => r.base.elevation + r.base.gradient[0] * (x - r.base.at[0]) + r.base.gradient[1] * (y - r.base.at[1]);
  const dr = new Float64Array(regions.length);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = mx(i), y = mx(j);
    const wx = x + (fbm(x * 0.005, y * 0.005, 3, salt + 2) - 0.5) * 90 + (fbm(x * 0.02, y * 0.02, 2, salt + 4) - 0.5) * 24;
    const wy = y + (fbm(x * 0.005, y * 0.005, 3, salt + 3) - 0.5) * 90 + (fbm(x * 0.02, y * 0.02, 2, salt + 5) - 0.5) * 24;
    let best = 0, dmin = Infinity;
    regions.forEach((r, ri) => {
      let d = Infinity;
      for (const a of r.anchors) d = Math.min(d, Math.hypot(wx - a[0], wy - a[1]));
      dr[ri] = d;
      if (d < dmin) { dmin = d; best = ri; }
    });
    let ws = 0, e = 0;
    regions.forEach((r, ri) => {
      const dd = dr[ri] - dmin;
      if (dd > 170) return;
      const w = Math.exp(-dd / 40);
      ws += w; e += w * plane(r, x, y);
    });
    elev[k] = e / ws;
    if (land[k]) region[k] = best;
  }
  lap('regions');

  // 3. Mountain ranges: crest heights along authored ridgelines, with style-dependent ruggedness.
  for (const m of data.ranges) {
    const hw = m.halfWidth;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of m.crest) { x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]); }
    for (let j = Math.max(0, Math.floor((y0 - hw) / U)); j <= Math.min(N - 1, Math.ceil((y1 + hw) / U)); j++) {
      for (let i = Math.max(0, Math.floor((x0 - hw) / U)); i <= Math.min(N - 1, Math.ceil((x1 + hw) / U)); i++) {
        const x = mx(i), y = mx(j), q = nearestOnLine(m.crest, x, y);
        if (q.d >= hw) continue;
        const a = m.crest[q.seg], b = m.crest[q.seg + 1];
        let hc = a[2] + (b[2] - a[2]) * q.t;
        if (m.style === 'alpine') hc *= 0.84 + 0.3 * ridged(x * 0.02, y * 0.02, 4, salt + 10);
        else if (m.style === 'jagged') hc *= 0.72 + 0.5 * ridged(x * 0.04, y * 0.04, 3, salt + 11);
        else if (m.style === 'volcanic') hc *= 0.9 + 0.2 * fbm(x * 0.03, y * 0.03, 3, salt + 12);
        else hc *= 0.94 + 0.12 * fbm(x * 0.02, y * 0.02, 3, salt + 13);
        const p = (1 - (q.d / hw) ** 2) ** 2, k = j * N + i;
        if (hc > elev[k]) elev[k] += (hc - elev[k]) * p;
      }
    }
  }
  lap('ranges');

  // 4. Basins, plateaus, fissures, gentle detail, coast.
  const E = data.elevation;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = mx(i), y = mx(j);
    let e = elev[k];
    for (const b of E.basins) { const d = Math.hypot(x - b.at[0], y - b.at[1]); if (d < b.radius && b.floor < e) e += (b.floor - e) * smoothstep(b.radius, b.radius * 0.25, d); }
    for (const p of E.plateaus) { const d = Math.hypot(x - p.at[0], y - p.at[1]); if (d < p.radius * 1.8) e += (p.elevation - e) * smoothstep(p.radius * 1.8, p.radius * 0.5, d); }
    for (const f of E.fissures) { const q = nearestOnLine(f.line, x, y); if (q.d < f.width * 2) e -= f.depth * (1 - smoothstep(0, f.width * 2, q.d)); }
    e += (fbm(x * E.detail.scale, y * E.detail.scale, 4, salt + 20) - 0.5) * 2 * E.detail.amplitude * Math.max(40, e);
    if (land[k]) e = 1.5 + (e - 1.5) * smoothstep(0, E.coastFalloff, coastD[k] * U);
    else e = -3 - Math.min(90, seaD[k] * U * 1.4);
    elev[k] = e;
  }
  const water = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) if (!land[k]) water[k] = W_SEA;
  const marshIdx = regions.findIndex((r) => r.id === 'whispering-marshes');
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (region[k] === marshIdx && elev[k] < 16 && fbm(mx(i) * 0.03, mx(j) * 0.03, 3, salt + 30) > 0.56) { water[k] = W_MARSH; elev[k] = Math.min(elev[k], 3); }
  }
  lap('shaping');

  const at = (x: number, y: number) => {
    const gx = Math.max(0, Math.min(N - 1.001, x / U - 0.5)), gy = Math.max(0, Math.min(N - 1.001, y / U - 0.5));
    const i0 = Math.floor(gx), j0 = Math.floor(gy), tx = gx - i0, ty = gy - j0, k = j0 * N + i0;
    return (elev[k] * (1 - tx) + elev[k + 1] * tx) * (1 - ty) + (elev[k + N] * (1 - tx) + elev[k + N + 1] * tx) * ty;
  };
  const idxAt = (x: number, y: number) => Math.max(0, Math.min(N - 1, Math.floor(y / U))) * N + Math.max(0, Math.min(N - 1, Math.floor(x / U)));

  // 5. Lakes: level just below the lowest rim point, so each basin holds water.
  const lakeLevels: Record<string, number> = {};
  for (const l of data.lakes) {
    let rim = Infinity;
    for (let a = 0; a < 48; a++) { const g = (a / 48) * Math.PI * 2; rim = Math.min(rim, at(l.at[0] + Math.cos(g) * (l.radius + 3), l.at[1] + Math.sin(g) * (l.radius + 3))); }
    const level = rim - 1;
    lakeLevels[l.id] = level;
    const R = l.radius * 1.2 + 4;
    for (let j = Math.max(0, Math.floor((l.at[1] - R) / U)); j <= Math.min(N - 1, Math.ceil((l.at[1] + R) / U)); j++) {
      for (let i = Math.max(0, Math.floor((l.at[0] - R) / U)); i <= Math.min(N - 1, Math.ceil((l.at[0] + R) / U)); i++) {
        const x = mx(i), y = mx(j), k = j * N + i, g = Math.atan2(y - l.at[1], x - l.at[0]);
        const re = l.radius * (0.85 + 0.3 * fbm(Math.cos(g) * 1.5 + 3, Math.sin(g) * 1.5 + 3, 3, salt + l.radius));
        const d = Math.hypot(x - l.at[0], y - l.at[1]);
        if (d <= re) { elev[k] = Math.min(elev[k], level - 2 - 14 * (1 - (d / re) ** 2)); water[k] = W_LAKE; }
        else if (d <= re + 3 && elev[k] < level + 1) elev[k] = level + 1;
      }
    }
  }
  lap('lakes');

  // 6. Rivers: the surface never rises downstream; authored falls step it down; channels and valleys are carved.
  const rivers: RiverProfile[] = [];
  for (const r of data.rivers) {
    const raw2 = resample(chaikin(r.path, 2), 0.5);
    const n = raw2.length;
    const pts: MapPt[] = raw2.map((p, k) => {
      const f = k / (n - 1), taper = Math.min(1, f * 15, (1 - f) * 15);
      const q = raw2[Math.min(n - 1, k + 1)], o = raw2[Math.max(0, k - 1)], tx = q[0] - o[0], ty = q[1] - o[1], tl = Math.hypot(tx, ty) || 1;
      const m = (fbm(k * 0.02, 0.5, 3, salt + r.id.length * 7) - 0.5) * 6 * taper;
      return [p[0] - (ty / tl) * m, p[1] + (tx / tl) * m];
    });
    const parent = r.from ? rivers.find((q) => q.id === r.from) : undefined;
    const surface: number[] = new Array(n), ground: number[] = new Array(n);
    let low = Infinity, barrier = 0, cap = Infinity;
    const fallIdx = new Map<number, number>();
    for (const f of r.falls ?? []) {
      let bk = 0, bd = Infinity;
      pts.forEach((p, k) => { const d = Math.hypot(p[0] - f.at[0], p[1] - f.at[1]); if (d < bd) { bd = d; bk = k; } });
      fallIdx.set(bk, f.drop);
    }
    for (let k = 0; k < n; k++) {
      const [x, y] = pts[k], g = at(x, y), wi = water[idxAt(x, y)], f = k / (n - 1);
      ground[k] = g;
      if (wi !== W_LAKE && wi !== W_SEA) { if (g > low) barrier = Math.max(barrier, g - low); low = Math.min(low, g); }
      const depth = 2 + 4 * f;
      let s: number;
      if (k === 0) {
        if (parent) { const q = nearestOnLine(parent.pts, x, y); s = parent.surface[Math.min(parent.surface.length - 1, q.seg)]; }
        else if (r.source) s = lakeLevels[r.source] ?? g - depth;
        else s = g - depth;
      } else s = Math.min(surface[k - 1] - 0.01, wi === W_LAKE ? surface[k - 1] : g - depth);
      if (fallIdx.has(k)) cap = s - fallIdx.get(k)!;
      surface[k] = Math.min(s, cap);
    }
    // Base level: a river flowing into a lake or another river never cuts below that water's surface.
    let base = -Infinity;
    const lakeMouth = data.lakes.find((l) => l.id === r.mouth);
    if (lakeMouth) base = lakeLevels[lakeMouth.id];
    const intoRiver = rivers.find((q) => q.id === r.mouth);
    if (intoRiver) { const q = nearestOnLine(intoRiver.pts, pts[n - 1][0], pts[n - 1][1]); base = intoRiver.surface[Math.min(intoRiver.surface.length - 1, q.seg)]; }
    for (let k = 0; k < n; k++) surface[k] = Math.max(surface[k], base);
    // Falls: 25 m or more within 4 map units.
    const falls: Array<{ at: MapPt; drop: number }> = [];
    for (let k = 8; k < n; k++) {
      const drop = surface[k - 8] - surface[k];
      if (drop >= 25 && !falls.some((q) => Math.hypot(q.at[0] - pts[k][0], q.at[1] - pts[k][1]) < 15)) {
        let kk = k, bestDrop = 0;
        for (let j = k; j < Math.min(n, k + 12); j++) { const dj = surface[Math.max(0, j - 8)] - surface[j]; if (dj > bestDrop) { bestDrop = dj; kk = j; } }
        falls.push({ at: [Math.round(pts[kk][0]), Math.round(pts[kk][1])], drop: Math.round(bestDrop) });
      }
    }
    // Carve. Banks are shaped from the ground as it was before this river (applying the profile to already-carved
    // ground at every overlapping sample would compound into a flat floor with a vertical wall).
    const pre = elev.slice();
    for (let k = 0; k < n; k++) {
      const [px, py] = pts[k], f = k / (n - 1);
      const hw = (r.width[0] + (r.width[1] - r.width[0]) * f) / 2, mountain = surface[k] > 600;
      // Valley width grows with how deep the river sits below the land: gentle banks in the lowlands, gorges in the mountains.
      const entrench = Math.max(0, ground[k] - surface[k]);
      const ch = Math.max(hw, 1.2), vw = mountain ? hw * 2 + 4 : surface[k] > 300 ? Math.max(hw * 3 + 8, hw + entrench * 0.5) : Math.max(hw * 5 + 16, hw + entrench * 0.9);
      for (let j = Math.max(0, Math.floor((py - vw) / U)); j <= Math.min(N - 1, Math.ceil((py + vw) / U)); j++) {
        for (let i = Math.max(0, Math.floor((px - vw) / U)); i <= Math.min(N - 1, Math.ceil((px + vw) / U)); i++) {
          const k2 = j * N + i, d = Math.hypot(mx(i) - px, mx(j) - py);
          if (d > vw || water[k2] === W_SEA) continue;
          if (d <= ch) { elev[k2] = Math.min(elev[k2], surface[k] - 1); if (water[k2] !== W_LAKE) water[k2] = W_RIVER; }
          else elev[k2] = Math.min(elev[k2], surface[k] + Math.max(0, pre[k2] - surface[k]) * smoothstep(ch, vw, d));
        }
      }
    }
    // Where it ends.
    const [lx, ly] = pts[n - 1];
    let mouthOk = false, joinOk = true, detail = '';
    if (r.mouth === 'sea') { mouthOk = water[idxAt(lx, ly)] === W_SEA || land[idxAt(lx, ly)] === 0; detail = mouthOk ? 'reaches the sea' : 'ends on land'; }
    else if (r.mouth === 'split') { mouthOk = data.rivers.some((q) => q.from === r.id); detail = 'divides into distributaries'; }
    else {
      const lake = data.lakes.find((l) => l.id === r.mouth);
      if (lake) { mouthOk = Math.hypot(lx - lake.at[0], ly - lake.at[1]) <= lake.radius + 6; joinOk = surface[n - 1] >= lakeLevels[lake.id] - 1; detail = `flows into ${lake.name}`; }
      else {
        const into = rivers.find((q) => q.id === r.mouth);
        if (into) {
          const q = nearestOnLine(into.pts, lx, ly);
          mouthOk = q.d <= 6;
          joinOk = surface[n - 1] >= into.surface[Math.min(into.surface.length - 1, q.seg)] - 1;
          detail = `joins ${into.name}`;
        }
      }
    }
    if (parent) { const q = nearestOnLine(parent.pts, pts[0][0], pts[0][1]); joinOk = joinOk && q.d <= 6; }
    rivers.push({ id: r.id, name: r.name, pts, surface, barrier: Math.round(barrier), falls, mouthOk, joinOk, detail });
  }
  lap('rivers');

  // 7. Slope (m per m) and distance to fresh water (map units).
  const slope = new Float32Array(N * N);
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    slope[k] = Math.hypot(elev[k + 1] - elev[k - 1], elev[k + N] - elev[k - N]) / (2 * U * mpu);
  }
  const fresh = distance(N, (i) => water[i] === W_RIVER || water[i] === W_LAKE);
  lap('slope');

  // 8. Roads: A* on a 4-unit grid, reusing the continent pathfinder; legs between authored stops.
  const G = N / 2, STEP = U * 2;
  const placeAt = (v: string | MapPt): MapPt => {
    if (typeof v !== 'string') return v;
    const s = data.settlements.find((q) => q.id === v) ?? data.landmarks.find((q) => q.id === v);
    return s ? s.at : [0, 0];
  };
  const nests = data.territories.filter((t) => t.kind === 'nest');
  const roadCost = (pass: boolean) => {
    const c = new Float32Array(G * G);
    const extra: Record<string, number> = { 'dragon-peaks': 0.8, elderwood: 0.7, 'hollow-lands': 0.8, 'whispering-marshes': 1.2 };
    for (let gj = 0; gj < G; gj++) for (let gi = 0; gi < G; gi++) {
      const k = (gj * 2 + 1) * N + gi * 2 + 1, wv = water[k];
      if (wv === W_SEA || wv === W_LAKE || gi < 1 || gj < 1 || gi >= G - 1 || gj >= G - 1) { c[gj * G + gi] = Infinity; continue; }
      const g = slope[k];
      if (g > (pass ? 0.8 : 0.32)) { c[gj * G + gi] = Infinity; continue; }
      let v = 1 + (extra[regions[region[k]]?.id] ?? 0) + 220 * g * g;
      if (wv === W_RIVER) v += 60;
      if (wv === W_MARSH) v += 4;
      const x = (gi + 0.5) * STEP, y = (gj + 0.5) * STEP;
      for (const t of nests) if (Math.hypot(x - t.centre[0], y - t.centre[1]) < t.radius * 0.85) v += 500;
      c[gj * G + gi] = v;
    }
    return c;
  };
  const costLow = roadCost(false), costPass = roadCost(true);
  const roads: RoutedRoad[] = [];
  for (const r of data.roads) {
    const stops = r.via.map(placeAt);
    let pts: MapPt[] = [];
    let ok = true;
    for (let s = 0; s < stops.length - 1; s++) {
      const p = findPath(r.pass ? costPass : costLow, stops[s], stops[s + 1], { G, step: STEP, minCost: 1 });
      if (!p) { ok = false; break; }
      pts = pts.concat(s ? p.pts.slice(1) : p.pts);
    }
    if (pts.length < 2) {
      roads.push({ id: r.id, name: r.name, cls: r.class, pts, length: 0, straight: 0, maxGrade: 0, maxGradeAt: [0, 0], meanGrade: 0, bridges: [], legs: stops.length - 1, ok: false, detail: 'no route within the grade limit' });
      continue;
    }
    let smooth = chaikin(pts, 2);
    if (smooth.some(([x, y]) => water[idxAt(x, y)] === W_LAKE || water[idxAt(x, y)] === W_SEA)) smooth = pts;
    const fine = resample(smooth, 1);
    let length = 0, maxGrade = 0, gsum = 0, gn = 0, maxAt: MapPt = [0, 0];
    for (let k = 1; k < fine.length; k++) length += Math.hypot(fine[k][0] - fine[k - 1][0], fine[k][1] - fine[k - 1][1]);
    for (let k = 3; k < fine.length; k += 3) {
      const a = fine[k - 3], b = fine[k], run = Math.hypot(b[0] - a[0], b[1] - a[1]) * mpu;
      // Bridges and their approaches carry the road level: skip windows within 6 units of a river or lake.
      if (run <= 0 || fresh[idxAt(b[0], b[1])] * U < 6 || fresh[idxAt(a[0], a[1])] * U < 6 || water[idxAt(b[0], b[1])] !== W_NONE) continue;
      const gr = Math.abs(at(b[0], b[1]) - at(a[0], a[1])) / run;
      if (gr > maxGrade) { maxGrade = gr; maxAt = [Math.round(b[0]), Math.round(b[1])]; }
      gsum += gr; gn++;
    }
    let straight = 0;
    for (let s = 0; s < stops.length - 1; s++) straight += Math.hypot(stops[s + 1][0] - stops[s][0], stops[s + 1][1] - stops[s][1]);
    const bridges: RoutedRoad['bridges'] = [];
    let inRiver = false, runStart = 0;
    const named = data.landmarks.filter((l) => l.kind === 'bridge');
    for (let k = 0; k < fine.length; k++) {
      const w = water[idxAt(fine[k][0], fine[k][1])] === W_RIVER;
      if (w && !inRiver) { inRiver = true; runStart = k; }
      if ((!w || k === fine.length - 1) && inRiver) {
        inRiver = false;
        const m = fine[(runStart + k) >> 1];
        let rid = '', rd = Infinity;
        for (const rv of rivers) { const q = nearestOnLine(rv.pts, m[0], m[1]); if (q.d < rd) { rd = q.d; rid = rv.id; } }
        const nb = named.find((l) => Math.hypot(l.at[0] - m[0], l.at[1] - m[1]) < 16);
        if (!bridges.some((b) => Math.hypot(b.at[0] - m[0], b.at[1] - m[1]) < 8 || (nb && b.name === nb.name))) {
          bridges.push({ at: [Math.round(m[0]), Math.round(m[1])], river: rid, name: nb?.name });
        }
      }
    }
    // Mountain passes climb by switchbacks where the blueprint grade exceeds 35 %.
    const limit = r.pass ? 0.8 : r.class === 'major' ? 0.2 : 0.3;
    ok = ok && maxGrade <= limit;
    roads.push({ id: r.id, name: r.name, cls: r.class, pts: smooth, length: Math.round(length), straight: Math.round(straight), maxGrade: Math.round(maxGrade * 1000) / 1000, maxGradeAt: maxAt,
      meanGrade: Math.round((gsum / Math.max(1, gn)) * 1000) / 1000, bridges, legs: stops.length - 1, ok,
      detail: pts.length < 2 ? 'no route' : `${Math.round(length)} units, max grade ${(maxGrade * 100).toFixed(0)}%${maxGrade > limit ? ` exceeds ${limit * 100}% at (${maxAt.join(', ')})` : ''}${r.pass && maxGrade > 0.35 ? ' (switchbacks)' : ''}` });
  }
  lap('roads');

  // 9. Settlements: region, ground, water, roads.
  const settlements: SettlementCheck[] = data.settlements.map((s) => {
    const k = idxAt(s.at[0], s.at[1]);
    let sl = 0, n = 0;
    for (let j = -s.footprintRadius; j <= s.footprintRadius; j += U) for (let i = -s.footprintRadius; i <= s.footprintRadius; i += U) {
      if (i * i + j * j > s.footprintRadius ** 2) continue;
      sl += slope[idxAt(s.at[0] + i, s.at[1] + j)]; n++;
    }
    sl /= Math.max(1, n);
    const wd = fresh[k] * U, nroads = data.roads.filter((r) => r.via.includes(s.id)).length;
    const reg = regions[region[k]]?.id ?? 'sea';
    const issues: string[] = [];
    const maxSlope = s.kind === 'city' ? 0.1 : s.kind === 'village' ? 0.15 : 0.3;
    if (reg !== s.region) issues.push(`lies in ${reg}, declared ${s.region}`);
    if (sl > maxSlope) issues.push(`ground too steep (${(sl * 100).toFixed(0)}%)`);
    if (wd > (s.kind === 'city' ? 30 : 45)) issues.push(`fresh water ${Math.round(wd)} units away`);
    if (water[k] !== W_NONE) issues.push('centre is in water');
    if (nroads < (s.kind === 'city' ? 3 : 1)) issues.push(`only ${nroads} road(s)`);
    for (const t of nests) if (Math.hypot(s.at[0] - t.centre[0], s.at[1] - t.centre[1]) < t.radius) issues.push(`inside dragon territory ${t.name}`);
    return { id: s.id, region: reg, slope: Math.round(sl * 1000) / 1000, waterDist: Math.round(wd), roads: nroads, ok: issues.length === 0, issues };
  });

  // 10. Dragons: landing sites and corridors.
  const landing: Record<string, MapPt[]> = {};
  for (const t of nests) {
    const cand: Array<[number, number, number]> = [];
    for (let j = Math.max(0, Math.floor((t.centre[1] - t.radius) / U)); j <= Math.min(N - 1, Math.ceil((t.centre[1] + t.radius) / U)); j++) {
      for (let i = Math.max(0, Math.floor((t.centre[0] - t.radius) / U)); i <= Math.min(N - 1, Math.ceil((t.centre[0] + t.radius) / U)); i++) {
        const k = j * N + i, x = mx(i), y = mx(j);
        if (Math.hypot(x - t.centre[0], y - t.centre[1]) > t.radius || water[k] !== W_NONE || slope[k] > 0.3) continue;
        cand.push([x, y, elev[k] / 100 - slope[k] * 10]);
      }
    }
    cand.sort((a, b) => b[2] - a[2]);
    const pick: MapPt[] = [];
    for (const c of cand) { if (pick.length >= 4) break; if (pick.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) >= 10)) pick.push([Math.round(c[0]), Math.round(c[1])]); }
    landing[t.id] = pick;
  }
  const F = data.flight;
  const tById = new Map(data.territories.map((t) => [t.id, t]));
  const corridors: Corridor[] = F.edges.map(([fa, fb]) => {
    const A = tById.get(fa)!, B = tById.get(fb)!;
    const a = A.nest ?? A.centre, b = B.nest ?? B.centre;
    const line = resample([a, b], 1);
    let maxGround = 0;
    for (const p of line) maxGround = Math.max(maxGround, at(p[0], p[1]));
    let cruise = maxGround + F.clearance;
    const overflights: Corridor['overflights'] = [];
    for (const s of data.settlements) {
      const q = nearestOnLine([a, b], s.at[0], s.at[1]);
      if (q.d > s.footprintRadius + 15) continue;
      const g = at(s.at[0], s.at[1]);
      if (cruise - g < F.settlementMinAGL) cruise = g + F.settlementMinAGL;
      overflights.push({ id: s.id, agl: 0 });
    }
    for (const o of overflights) o.agl = Math.round(cruise - at(placeAt(o.id)[0], placeAt(o.id)[1]));
    const climbRun = Math.min(40, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2) * mpu;
    const climbGrade = Math.max(0, cruise - at(a[0], a[1])) / climbRun;
    return { from: fa, to: fb, a, b, maxGround: Math.round(maxGround), cruise: Math.round(cruise), climbGrade: Math.round(climbGrade * 100) / 100, overflights, ok: cruise <= F.ceiling };
  });
  lap('dragons');

  // 11. Region statistics.
  const regionStats: Blueprint['regionStats'] = {};
  let landN = 0;
  for (let k = 0; k < N * N; k++) if (region[k] >= 0) landN++;
  regions.forEach((r, ri) => {
    const v: number[] = [];
    for (let k = 0; k < N * N; k++) if (region[k] === ri && water[k] === W_NONE) v.push(elev[k]);
    v.sort((a, b) => a - b);
    const q = (f: number) => Math.round(v[Math.floor(f * (v.length - 1))] ?? 0);
    regionStats[r.id] = { p10: q(0.1), p50: q(0.5), p90: q(0.9), share: Math.round((v.length / landN) * 1000) / 10 };
  });

  const bp: Blueprint = { data, coords, N, unit: U, elev, region, water, slope, rivers, lakeLevels, roads, corridors, landing, settlements, regionStats, checks: [], ms };
  bp.checks = runChecks(bp);
  lap('checks');
  return bp;
}

/** Region id at a map point. */
export function regionAt(bp: Blueprint, x: number, y: number): string {
  const k = Math.max(0, Math.min(bp.N - 1, Math.floor(y / bp.unit))) * bp.N + Math.max(0, Math.min(bp.N - 1, Math.floor(x / bp.unit)));
  return bp.data.regions[bp.region[k]]?.id ?? 'sea';
}

/** The specification's map acceptance tests that can be evaluated on the blueprint. */
function runChecks(bp: Blueprint): Check[] {
  const { N, data, region, water, elev } = bp;
  const out: Check[] = [];
  // 1-2. One connected landmass; every region reachable on foot from Lumenfall.
  const start = data.settlements.find((s) => s.kind === 'city') ?? data.settlements[0];
  const seen = new Uint8Array(N * N);
  const s0 = Math.floor(start.at[1] / bp.unit) * N + Math.floor(start.at[0] / bp.unit);
  const stack = [s0]; seen[s0] = 1;
  let reached = 0, landN = 0;
  for (let k = 0; k < N * N; k++) if (region[k] >= 0) landN++;
  const regionsReached = new Set<number>();
  while (stack.length) {
    const k = stack.pop()!; reached++; regionsReached.add(region[k]);
    const x = k % N, y = (k / N) | 0;
    for (const m of [x > 0 ? k - 1 : -1, x < N - 1 ? k + 1 : -1, y > 0 ? k - N : -1, y < N - 1 ? k + N : -1]) {
      if (m >= 0 && !seen[m] && region[m] >= 0) { seen[m] = 1; stack.push(m); }
    }
  }
  out.push({ id: 'connected-continent', ok: reached / landN > 0.995, detail: `${((reached / landN) * 100).toFixed(1)}% of land connected to Lumenfall` });
  out.push({ id: 'six-regions-reachable', ok: data.regions.every((_, ri) => regionsReached.has(ri)), detail: `${regionsReached.size} of ${data.regions.length} regions reachable without crossing water` });
  // 3-4. Rivers descend, end where they should, and join correctly.
  for (const r of bp.rivers) {
    const mono = r.surface.every((v, k) => k === 0 || v <= r.surface[k - 1] + 1e-6);
    out.push({ id: `river-${r.id}`, ok: mono && r.mouthOk && r.joinOk && r.barrier <= 60, detail: `${r.detail}; barrier ${r.barrier} m; ${r.falls.length} falls` });
  }
  // Landmarks in their regions (borders are soft: within 8 units counts).
  const wrong = data.landmarks.filter((l) => {
    for (let dy = -8; dy <= 8; dy += 4) for (let dx = -8; dx <= 8; dx += 4) if (regionAt(bp, l.at[0] + dx, l.at[1] + dy) === l.region) return false;
    return true;
  });
  out.push({ id: 'landmarks-in-regions', ok: wrong.length === 0, detail: wrong.length ? `outside their region: ${wrong.map((l) => l.id).join(', ')}` : `${data.landmarks.length} landmarks in their declared regions` });
  // Region elevations roughly match the specification.
  for (const r of data.regions) {
    const s = bp.regionStats[r.id];
    const ok = s.p10 >= r.elevation[0] * 0.5 - 30 && s.p90 <= r.elevation[1] * 1.15 + 30;
    out.push({ id: `elevation-${r.id}`, ok, detail: `p10 ${s.p10} m, median ${s.p50} m, p90 ${s.p90} m (spec ${r.elevation[0]}-${r.elevation[1]} m), ${s.share}% of land` });
  }
  // 5-6. Settlements and roads.
  for (const s of bp.settlements) out.push({ id: `settlement-${s.id}`, ok: s.ok, detail: s.ok ? `slope ${(s.slope * 100).toFixed(0)}%, water ${s.waterDist} units, ${s.roads} road(s)` : s.issues.join('; ') });
  for (const r of bp.roads) out.push({ id: `road-${r.id}`, ok: r.ok && r.length >= r.straight, detail: `${r.detail}; ${r.bridges.length} bridge(s)` });
  // 8-9. Dragons.
  for (const t of data.territories.filter((q) => q.kind === 'nest')) {
    const k = Math.floor(t.nest![1] / bp.unit) * N + Math.floor(t.nest![0] / bp.unit);
    out.push({ id: t.id, ok: water[k] === W_NONE && (bp.landing[t.id]?.length ?? 0) >= 3, detail: `nest at ${Math.round(elev[k])} m, ${bp.landing[t.id]?.length ?? 0} landing sites` });
  }
  for (const c of bp.corridors) out.push({ id: `corridor:${c.from.replace('territory-', '')}-${c.to.replace('territory-', '')}`, ok: c.ok, detail: `cruise ${c.cruise} m over ground up to ${c.maxGround} m${c.overflights.length ? `; over ${c.overflights.map((o) => `${o.id} at ${o.agl} m`).join(', ')}` : ''}` });
  return out;
}
