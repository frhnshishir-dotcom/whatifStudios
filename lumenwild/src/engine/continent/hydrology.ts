import { SIZE, Biome, Water, type River, type Lake, type Fall, type Cave, type Pt } from './types';
import { fbm, valueNoise } from '../core/noise';
import { seedOf, hash2 } from '../core/rng';

interface RiverDesign { id: string; name: string; pts: Pt[]; falls: number[]; w0: number; w1: number }

/**
 * Designed river courses (control points), from springs in the high ground to the sea. They pass close to the
 * villages that need water: Silverrun by Frostwatch, Greenhaven and Marshlight; Amberflow by Moonrest and Windmere;
 * Thornbrook through the Thornwild into the marshes. `falls` are fractions of the course with a designed waterfall.
 */
export const RIVER_DESIGNS: RiverDesign[] = [
  { id: 'silverrun', name: 'Silverrun', w0: 1.0, w1: 3.6, falls: [0.12, 0.27],
    pts: [[468, 95], [452, 170], [446, 245], [459, 315], [440, 395], [415, 470], [411, 522], [440, 582], [500, 622], [575, 657], [650, 690], [705, 730], [760, 790], [810, 850], [860, 905], [905, 955]] },
  { id: 'amberflow', name: 'Amberflow', w0: 0.9, w1: 2.8, falls: [0.2],
    pts: [[338, 150], [310, 215], [287, 290], [284, 350], [289, 396], [263, 455], [240, 522], [222, 602], [214, 682], [219, 744], [205, 812], [190, 882], [175, 965]] },
  { id: 'thornbrook', name: 'Thornbrook', w0: 0.8, w1: 2.0, falls: [0.3],
    pts: [[700, 170], [735, 250], [770, 330], [792, 410], [781, 500], [765, 580], [742, 655], [705, 730]] },
];

export const LAKE_DESIGNS: Array<{ id: string; name: string; x: number; y: number; r: number }> = [
  { id: 'mirrormere', name: 'Mirrormere', x: 525, y: 565, r: 20 },
  { id: 'frost-tarn', name: 'Frost Tarn', x: 402, y: 280, r: 9 },
  { id: 'elderpool', name: 'Elderpool', x: 196, y: 448, r: 11 },
  { id: 'crater-lake', name: 'Crater Lake', x: 834, y: 392, r: 17 },
];

/** Catmull-Rom through the control points, sampled about every half cell. */
function spline(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * 2));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export interface Hydrology { rivers: River[]; lakes: Lake[]; falls: Fall[]; caves: Cave[] }

/**
 * Carve rivers (beds never rise downstream; designed falls cut a step and a gorge below it), lake basins and marsh
 * pools into the height field, and mark the water. Rivers are carved in order, so a tributary meets its main river
 * at the main river's bed.
 */
export function carveWater(seed: number, height: Float32Array, biome: Uint8Array, forest: Uint8Array, water: Uint8Array): Hydrology {
  const s = seedOf('continent-water', seed) % 100000;
  const W = SIZE;
  const at = (x: number, y: number) => height[Math.max(0, Math.min(W - 1, Math.round(y))) * W + Math.max(0, Math.min(W - 1, Math.round(x)))];

  // Sea.
  for (let i = 0; i < W * W; i++) if (biome[i] === Biome.Sea) water[i] = Water.Sea;

  // Lakes: level below the lowest rim point so the basin holds; bowl carved below it.
  const lakes: Lake[] = [];
  for (const d of LAKE_DESIGNS) {
    let rim = 1e9;
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2;
      rim = Math.min(rim, at(d.x + Math.cos(ang) * (d.r + 3), d.y + Math.sin(ang) * (d.r + 3)));
    }
    const level = Math.max(0.6, rim - 0.4);
    const R = d.r + 2;
    for (let y = d.y - R - 2; y <= d.y + R + 2; y++) for (let x = d.x - R - 2; x <= d.x + R + 2; x++) {
      if (x < 0 || y < 0 || x >= W || y >= W) continue;
      const ang = Math.atan2(y - d.y, x - d.x);
      const re = d.r * (0.85 + 0.3 * valueNoise(Math.cos(ang) * 2 + 5, Math.sin(ang) * 2 + 5, s + d.r));
      const dist = Math.hypot(x - d.x, y - d.y), i = y * W + x;
      if (dist <= re) {
        height[i] = Math.min(height[i], level - 0.4 - 3 * (1 - (dist / re) ** 2));
        water[i] = Water.Lake; forest[i] = 0;
      } else if (dist <= re + 2.5 && height[i] < level + 0.3) height[i] = level + 0.3;
    }
    lakes.push({ id: d.id, name: d.name, x: d.x, y: d.y, r: d.r, level });
  }

  // Rivers.
  const rivers: River[] = [], falls: Fall[] = [];
  for (const d of RIVER_DESIGNS) {
    const raw = spline(d.pts);
    // Meander: a smooth sideways offset, zero at the ends.
    const pts: Pt[] = raw.map((p, k) => {
      const q = raw[Math.min(raw.length - 1, k + 1)], r0 = raw[Math.max(0, k - 1)];
      const tx = q[0] - r0[0], ty = q[1] - r0[1], tl = Math.hypot(tx, ty) || 1;
      const f = k / (raw.length - 1), taper = Math.min(1, f * 12, (1 - f) * 12);
      const m = (fbm(k * 0.012, 0.5, 3, s + d.id.length * 17) - 0.5) * 14 * taper;
      return [p[0] - (ty / tl) * m, p[1] + (tx / tl) * m];
    });
    const n = pts.length, bed: number[] = new Array(n), hw: number[] = new Array(n);
    const fallAt = new Set(d.falls.map((f) => Math.floor(f * n)));
    let cap = Infinity;
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      hw[k] = d.w0 + (d.w1 - d.w0) * f;
      const depth = 1.1 + 1.1 * f;
      if (fallAt.has(k) && k > 0) cap = bed[k - 1] - 9;
      const g = at(pts[k][0], pts[k][1]);
      bed[k] = Math.min(k ? bed[k - 1] - 0.0015 : Infinity, g - depth, cap);
    }
    // Falls: designed steps and any natural drop of 4 m within 4 cells.
    let lastFall = -1e9;
    for (let k = 8; k < n; k++) {
      const drop = bed[k - 8] - bed[k];
      if (drop >= 4 && k - lastFall > 80 && at(pts[k][0], pts[k][1]) > 0) {
        let kk = k, best = 0;
        for (let j = k; j < Math.min(n, k + 16); j++) { const dj = bed[j - 1] - bed[j]; if (dj > best) { best = dj; kk = j; } }
        falls.push({ river: d.id, x: Math.round(pts[kk][0]), y: Math.round(pts[kk][1]), drop: Math.round((bed[Math.max(0, kk - 8)] - bed[Math.min(n - 1, kk + 8)]) * 10) / 10 });
        lastFall = kk;
        k = kk + 8;
      }
    }
    // Carve the channel and its banks.
    for (let k = 0; k < n; k++) {
      const [px, py] = pts[k];
      const ci = Math.round(py) * W + Math.round(px);
      if (ci >= 0 && ci < W * W && biome[ci] === Biome.Sea) break;
      const h = hw[k], R = h + 4;
      for (let y = Math.floor(py - R); y <= Math.ceil(py + R); y++) for (let x = Math.floor(px - R); x <= Math.ceil(px + R); x++) {
        if (x < 0 || y < 0 || x >= W || y >= W) continue;
        const dist = Math.hypot(x - px, y - py), i = y * W + x;
        if (dist <= h) {
          height[i] = Math.min(height[i], bed[k] - 0.4 * (1 - (dist / Math.max(0.5, h)) ** 2));
          if (water[i] !== Water.Sea) water[i] = Water.River;
          forest[i] = 0;
        } else if (dist <= R) {
          const t = (dist - h) / (R - h);
          height[i] = Math.min(height[i], bed[k] + 0.3 + (height[i] - bed[k] - 0.3) * t * t);
        }
      }
    }
    rivers.push({ id: d.id, name: d.name, points: pts.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]), halfWidth: hw, bed });
  }

  // Marsh pools.
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (biome[i] !== Biome.WhisperingMarshes || water[i] !== Water.None) continue;
    if (height[i] < 3.2 && fbm(x * 0.035, y * 0.035, 3, s + 90) > 0.57) { water[i] = Water.Marsh; height[i] = Math.min(height[i], 0.4); }
  }

  // Cave mouths on steep high ground (dragon lairs are picked from these later).
  const caves: Cave[] = [];
  const cand: Array<[number, number, number]> = [];
  for (let y = 8; y < W - 8; y += 4) for (let x = 8; x < W - 8; x += 4) {
    const i = y * W + x, b = biome[i];
    if (water[i] || height[i] < 20 || !(b === Biome.DragonPeaks || b === Biome.Thornwild || b === Biome.Elderwood)) continue;
    const slope = Math.max(Math.abs(at(x + 3, y) - at(x - 3, y)), Math.abs(at(x, y + 3) - at(x, y - 3))) / 6;
    if (slope > 1.1) cand.push([x, y, slope + hash2(x, y, s) * 0.5]);
  }
  cand.sort((a, b) => b[2] - a[2]);
  for (const [x, y] of cand) {
    if (caves.length >= 12) break;
    if (caves.some((c) => Math.hypot(c.x - x, c.y - y) < 70)) continue;
    caves.push({ x, y, lair: false });
  }
  return { rivers, lakes, falls, caves };
}
