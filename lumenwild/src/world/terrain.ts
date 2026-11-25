import { type Blueprint, regionField, lakeRadius, marshPool, blueprintSalt } from './blueprint';
import type { WorldData } from './schema';
import { fbm, ridged } from '../engine/core/noise';
import { hash2 } from '../engine/core/rng';
import { smoothstep } from '../engine/core/math';
import { Mat, Cover } from '../engine/world/materials';

type WorldLake = WorldData['lakes'][number];

/**
 * Continent terrain at 1 m, from the blueprint. Every value is a pure function of continent position, so regions
 * generated separately (main thread, worker, server) agree exactly along their edges. Layers:
 *  macro  smooth bicubic surface of the blueprint (before river carving)
 *  meso   ridges, hills and gullies (100 m - 4 km), strength by region, flattened along valleys and near shores
 *  micro  1-40 m roughness
 *  water  rivers carved at their true width with banks scaled to how deep they cut; lakes at the blueprint level;
 *         marsh pools; the sea below 0 m
 */

export const WK_NONE = 0, WK_SEA = 1, WK_LAKE = 2, WK_RIVER = 3, WK_MARSH = 4;

export interface RegionObject { kind: 'tree' | 'rock' | 'mushroom'; x: number; y: number; variant: string }
export interface RegionData {
  rx: number; ry: number; size: number;
  /** Continent cell of the region's top-left cell. */
  ox: number; oy: number;
  elev: Float32Array; mat: Uint8Array; cover: Uint8Array; coverVar: Uint8Array; moisture: Uint8Array;
  /** Water surface (m) per cell, NaN where dry; and what kind of water. */
  waterLevel: Float32Array; waterKind: Uint8Array;
  /** Dominant region index per cell (255 = sea). */
  biome: Uint8Array;
  objects: RegionObject[];
  ms: number;
}

interface Seg { ax: number; ay: number; bx: number; by: number; sa: number; sb: number; ha: number; hb: number }
interface Style { meso: number; ridged: boolean; micro: number }

const STYLE: Record<string, Style> = {
  'dragon-peaks': { meso: 260, ridged: true, micro: 3 },
  'hollow-lands': { meso: 150, ridged: true, micro: 2 },
  elderwood: { meso: 45, ridged: false, micro: 1.2 },
  heartlands: { meso: 28, ridged: false, micro: 0.9 },
  'golden-plains': { meso: 14, ridged: false, micro: 0.7 },
  'whispering-marshes': { meso: 2, ridged: false, micro: 0.25 },
};

const COARSE = 8; // metres between coarse nodes
/** Offsets (m) at which marsh rims look for a neighbouring pool level. */
const RIM: Array<[number, number]> = [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]];

export class ContinentTerrain {
  readonly bp: Blueprint;
  readonly mpu: number;
  readonly regionCells: number;
  /** Continent size in cells (per side). */
  readonly cells: number;
  private field: (x: number, y: number, w: Float64Array) => number;
  private styles: Style[];
  private segs: Seg[] = [];
  private bucket = new Map<number, number[]>();
  private paths: Array<{ cls: string; pts: Float64Array }> = [];
  private salt: number;
  private marsh: number;
  private peaks: number;
  private hollow: number;
  /** Hollow Lands fissures in metres (ember cracks follow them). */
  private fissures: Array<{ pts: number[]; w: number }>;

  constructor(bp: Blueprint) {
    this.bp = bp;
    this.mpu = bp.coords.metresPerUnit;
    this.regionCells = bp.data.coordinates.regionCells;
    this.cells = bp.coords.cells;
    this.field = regionField(bp.data);
    this.styles = bp.data.regions.map((r) => STYLE[r.id] ?? STYLE.heartlands);
    this.salt = blueprintSalt(bp.data);
    this.marsh = bp.data.regions.findIndex((r) => r.id === 'whispering-marshes');
    this.peaks = bp.data.regions.findIndex((r) => r.id === 'dragon-peaks');
    this.hollow = bp.data.regions.findIndex((r) => r.id === 'hollow-lands');
    this.fissures = bp.data.elevation.fissures.map((f) => ({ pts: f.line.flatMap((q) => [q[0] * this.mpu, q[1] * this.mpu]), w: f.width * this.mpu }));
    // River segments in metres, bucketed by 1 km cells (with room for wide valleys).
    for (const r of bp.rivers) {
      const def = bp.data.rivers.find((q) => q.id === r.id)!;
      const n = r.pts.length;
      for (let k = 0; k < n - 1; k++) {
        const f0 = k / (n - 1), f1 = (k + 1) / (n - 1);
        const s: Seg = {
          ax: r.pts[k][0] * this.mpu, ay: r.pts[k][1] * this.mpu, bx: r.pts[k + 1][0] * this.mpu, by: r.pts[k + 1][1] * this.mpu,
          sa: r.surface[k], sb: r.surface[k + 1],
          ha: ((def.width[0] + (def.width[1] - def.width[0]) * f0) * this.mpu) / 2, hb: ((def.width[0] + (def.width[1] - def.width[0]) * f1) * this.mpu) / 2,
        };
        const id = this.segs.push(s) - 1, m = 2500;
        for (let gy = Math.floor((Math.min(s.ay, s.by) - m) / 1000); gy <= Math.floor((Math.max(s.ay, s.by) + m) / 1000); gy++) {
          for (let gx = Math.floor((Math.min(s.ax, s.bx) - m) / 1000); gx <= Math.floor((Math.max(s.ax, s.bx) + m) / 1000); gx++) {
            const key = gy * 100000 + gx;
            let b = this.bucket.get(key);
            if (!b) this.bucket.set(key, (b = []));
            b.push(id);
          }
        }
      }
    }
    // Paths: the blueprint's routes in metres, densified every 10 m with a gentle meander that is the same wherever
    // it is evaluated (driven by distance along the route).
    for (const r of bp.roads) {
      if (r.pts.length < 2) continue;
      const out: number[] = [];
      let along = 0;
      for (let k = 0; k < r.pts.length - 1; k++) {
        const ax = r.pts[k][0] * this.mpu, ay = r.pts[k][1] * this.mpu, bx = r.pts[k + 1][0] * this.mpu, by = r.pts[k + 1][1] * this.mpu;
        const L = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(L / 10)), nx = -(by - ay) / (L || 1), ny = (bx - ax) / (L || 1);
        for (let s = 0; s < steps; s++) {
          const t = s / steps, d = along + L * t, m = (fbm(d / 160, 0.5, 3, this.salt + 77) - 0.5) * 16;
          out.push(ax + (bx - ax) * t + nx * m, ay + (by - ay) * t + ny * m);
        }
        along += L;
      }
      const last = r.pts[r.pts.length - 1];
      out.push(last[0] * this.mpu, last[1] * this.mpu);
      this.paths.push({ cls: r.cls, pts: Float64Array.from(out) });
    }
  }

  /** Bicubic (Catmull-Rom) of the blueprint's pre-river elevation at a point in metres. */
  macroAt(xm: number, ym: number): number {
    const bp = this.bp, N = bp.N, U = bp.unit, e = bp.elevPre;
    const gx = xm / this.mpu / U - 0.5, gy = ym / this.mpu / U - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy), tx = gx - ix, ty = gy - iy;
    const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    const row = (j: number) => {
      const jj = Math.max(0, Math.min(N - 1, j)) * N, c = (i: number) => e[jj + Math.max(0, Math.min(N - 1, i))];
      return cr(c(ix - 1), c(ix), c(ix + 1), c(ix + 2), tx);
    };
    return cr(row(iy - 1), row(iy), row(iy + 1), row(iy + 2), ty);
  }

  /** River segments that can influence a rectangle (metres). */
  private segsNear(x0: number, y0: number, x1: number, y1: number): number[] {
    const set = new Set<number>();
    for (let gy = Math.floor(y0 / 1000); gy <= Math.floor(y1 / 1000); gy++) for (let gx = Math.floor(x0 / 1000); gx <= Math.floor(x1 / 1000); gx++) {
      for (const s of this.bucket.get(gy * 100000 + gx) ?? []) set.add(s);
    }
    return [...set];
  }

  /**
   * Smooth ground at a point: the macro surface and the meso relief (by region style, damped near rivers, lakes and
   * the coast). `sd` are the distances to the nearby river segments; `w` receives the region weights.
   */
  private node(xm: number, ym: number, sd: Array<{ d: number; h: number }>, lakes: WorldLake[], w: Float64Array): { macro: number; meso: number } {
    const mpu = this.mpu, salt = this.salt, R = w.length;
    const macro = this.macroAt(xm, ym);
    this.field(xm / mpu, ym / mpu, w);
    let meso = 0;
    for (let r = 0; r < R; r++) {
      if (w[r] < 0.01) continue;
      const st = this.styles[r];
      const shape = st.ridged ? (ridged(xm / 2200, ym / 2200, 4, salt + 101) - 0.35) * 2 + (fbm(xm / 700, ym / 700, 3, salt + 102) - 0.5) * 0.6
        : (fbm(xm / 1500, ym / 1500, 4, salt + 103) - 0.5) * 2;
      meso += w[r] * st.meso * shape;
    }
    // Valleys and shores are flatter: damp relief near rivers, lakes and the coast; keep the summits at their height.
    let damp = smoothstep(0, 40, macro);
    for (const d of sd) if (d.d < 3000) damp = Math.min(damp, smoothstep(d.h * 2, d.h * 6 + 900, d.d));
    for (const l of lakes) damp = Math.min(damp, smoothstep(l.radius * mpu, (l.radius + 8) * mpu, Math.hypot(xm - l.at[0] * mpu, ym - l.at[1] * mpu)));
    meso *= damp;
    if (meso > 0 && macro > 1250) meso *= smoothstep(1700, 1250, macro);
    return { macro, meso };
  }

  /**
   * Marsh water level for the 64 m cell holding a point: the smooth ground at the cell's centre, 0.3 m down. One flat
   * level per cell keeps pools near rest when they are filled, so they settle (and sleep) quickly.
   */
  private marshLevel(xm: number, ym: number, cache: Map<number, number>): number {
    const gx = Math.floor(xm / 64), gy = Math.floor(ym / 64), key = gy * 4096 + gx;
    let v = cache.get(key);
    if (v === undefined) {
      const cx = (gx + 0.5) * 64, cy = (gy + 0.5) * 64, mpu = this.mpu;
      const sd = this.segsNear(cx - 1, cy - 1, cx + 1, cy + 1).map((i) => segDist(this.segs[i], cx, cy));
      const lakes = this.bp.data.lakes.filter((l) => Math.hypot(l.at[0] * mpu - cx, l.at[1] * mpu - cy) < (l.radius + 9) * mpu);
      const n = this.node(cx, cy, sd, lakes, new Float64Array(this.bp.data.regions.length));
      v = Math.max(0.3, n.macro + n.meso - 0.3);
      cache.set(key, v);
    }
    return v;
  }

  /**
   * Generate one region (rx, ry): 256 x 256 cells of 1 m. Fields are computed with a one-cell margin so slopes (and
   * the materials that depend on them) are identical on both sides of a region edge.
   */
  generateRegion(rx: number, ry: number): RegionData {
    const t0 = performance.now();
    const S = this.regionCells, ox = rx * S, oy = ry * S, M = S + 2;
    const R = this.bp.data.regions.length, mpu = this.mpu, salt = this.salt;
    // Coarse nodes (every 8 m) over the region plus margin: macro, meso and region weights.
    const CN = Math.ceil(M / COARSE) + 2, cx0 = ox - 1 - COARSE, cy0 = oy - 1 - COARSE;
    const cMacro = new Float32Array(CN * CN), cMeso = new Float32Array(CN * CN), cW = new Float32Array(CN * CN * R);
    /** Per coarse node: the river segments whose valley can reach it (most nodes have none). */
    const cSegs: Array<number[] | null> = new Array(CN * CN).fill(null);
    const segs = this.segsNear(ox - 2600, oy - 2600, ox + S + 2600, oy + S + 2600).map((i) => this.segs[i]);
    const w = new Float64Array(R);
    const lakes = this.bp.data.lakes.filter((l) => Math.hypot(l.at[0] * mpu - (ox + S / 2), l.at[1] * mpu - (oy + S / 2)) < (l.radius * 1.2 + 6) * mpu + S);
    for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) {
      const xm = cx0 + i * COARSE, ym = cy0 + j * COARSE, k = j * CN + i;
      const sd = segs.map((s) => segDist(s, xm, ym));
      const { macro, meso } = this.node(xm, ym, sd, lakes, w);
      for (let r = 0; r < R; r++) if (w[r] >= 0.01) cW[k * R + r] = w[r];
      cMacro[k] = macro; cMeso[k] = meso;
      // Segments whose valley can reach this node (ground here, plus a margin for the cells around it).
      const top = macro + Math.max(0, meso) + 15;
      sd.forEach((d, si) => {
        const vw = Math.min(2500, Math.max(d.h * 6 + 60, Math.max(0, top - d.s) * 8));
        if (d.d < vw + 20) (cSegs[k] ??= []).push(si);
      });
    }
    const bil = (a: Float32Array, xm: number, ym: number, stride = 1, off = 0) => {
      const gx = (xm - cx0) / COARSE, gy = (ym - cy0) / COARSE, i = Math.floor(gx), j = Math.floor(gy), tx = gx - i, ty = gy - j;
      const k = (j * CN + i) * stride + off, kn = k + CN * stride;
      return (a[k] * (1 - tx) + a[k + stride] * tx) * (1 - ty) + (a[kn] * (1 - tx) + a[kn + stride] * tx) * ty;
    };

    // Fine elevation and water over the region plus a one-cell margin.
    const E = new Float32Array(M * M), level = new Float32Array(M * M).fill(NaN), kind = new Uint8Array(M * M), biome = new Uint8Array(M * M);
    const wr = new Float64Array(R), levels = new Map<number, number>();
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const xm = ox - 1 + i + 0.5, ym = oy - 1 + j + 0.5, k = j * M + i, ux = xm / mpu, uy = ym / mpu;
      const macro = bil(cMacro, xm, ym);
      let micro = 0, wsum = 0, best = 0, bw = -1;
      for (let r = 0; r < R; r++) {
        wr[r] = bil(cW, xm, ym, R, r);
        if (wr[r] <= 0.001) continue;
        micro += wr[r] * this.styles[r].micro;
        // Ecotones: the dominant biome is picked with probability ~ weight^3, so borders mix over hundreds of metres.
        const v = wr[r] * wr[r] * wr[r];
        wsum += v;
        if (wr[r] > bw) { bw = wr[r]; best = r; }
      }
      let pick = hash2(ox + i, oy + j, salt + 5) * wsum, chosen = best;
      for (let r = 0; r < R && wsum > 0; r++) { const v = wr[r] ** 3; if (wr[r] > 0.001 && (pick -= v) <= 0) { chosen = r; break; } }
      const smooth = macro + bil(cMeso, xm, ym);
      let base = smooth + micro * (fbm(xm / 35, ym / 35, 3, salt + 110) - 0.5) * 2 + (hash2(ox + i, oy + j, salt + 6) - 0.5) * 0.3;
      // Dragon Peaks and Hollow Lands: rock steps (flat shelves, steep risers) on the high ground, in patches.
      const tw = (this.peaks >= 0 ? wr[this.peaks] : 0) + (this.hollow >= 0 ? wr[this.hollow] : 0);
      if (tw > 0.05 && macro > 250) {
        const H = this.hollow >= 0 && wr[this.hollow] > 0.5 ? 18 : 12, f = base / H, fl = Math.floor(f), fr = f - fl;
        const amt = tw * smoothstep(250, 500, macro) * smoothstep(0.4, 0.6, fbm(xm / 420, ym / 420, 2, salt + 120));
        if (amt > 0) base += ((fl + fr ** 4) * H - base) * amt;
      }
      let e = base, lv = NaN, kd = WK_NONE;
      if (macro < 0 || base < 0) { lv = 0; kd = e < 0 ? WK_SEA : WK_NONE; if (kd === WK_NONE) lv = NaN; }
      // Rivers (each carves from the uncarved ground; the lowest result wins). Only segments listed on the nearest node.
      const near = cSegs[Math.round((ym - cy0) / COARSE) * CN + Math.round((xm - cx0) / COARSE)];
      if (near) for (const si of near) {
        const d = segDist(segs[si], xm, ym);
        const entrench = Math.max(0, base - d.s), vw = Math.min(2500, Math.max(d.h * 6 + 60, entrench * 8));
        if (d.d >= vw) continue;
        if (d.d < d.h) {
          const bed = d.s - (1 + 0.04 * d.h) * (1 - (d.d / d.h) ** 2) - 0.3;
          if (bed < e) e = bed;
          if (kd !== WK_SEA) { lv = d.s; kd = WK_RIVER; }
        } else {
          const bank = d.s + 0.3 + Math.max(0, base - d.s - 0.3) * smoothstep(d.h, vw, d.d);
          if (bank < e) e = bank;
        }
      }
      // Lakes.
      for (const l of lakes) {
        const L = this.bp.lakeLevels[l.id], dx = xm - l.at[0] * mpu, dy = ym - l.at[1] * mpu, d = Math.hypot(dx, dy);
        if (d > l.radius * 1.15 * mpu + 300) continue;
        const re = lakeRadius(this.bp.data, l, Math.atan2(dy, dx)) * mpu;
        if (d < re) { e = Math.min(e, L - 2 - 14 * (1 - (d / re) ** 2)); lv = L; kd = WK_LAKE; }
        else if (d < re + 300 && kd !== WK_RIVER) e = Math.max(e, Math.min(L + 0.6 + (d - re) * 0.015, base));
      }
      // Marsh pools and meandering channels: many small pools (tens of metres) inside the blueprint's wet zones, and
      // narrow channels between them. Their surface sits below the smooth ground, so the rims hold the water.
      if (kd === WK_NONE && this.marsh >= 0 && wr[this.marsh] > 0.35 && macro > 0.5) {
        const zone = marshPool(this.bp.data, ux, uy), wet = smoothstep(0.38, 0.56, zone) * smoothstep(0.35, 0.6, wr[this.marsh]);
        const p = fbm(xm / 38, ym / 38, 3, salt + 130), ch = Math.abs(fbm(xm / 260, ym / 260, 3, salt + 131) - 0.5);
        const pt = 0.75 - 0.08 * wet, pool = p > pt, chan = wet > 0.2 && ch < 0.004 + 0.006 * wet;
        // Only on flat ground (rims must hold a flat surface); one level per 64 m cell.
        const g = Math.hypot(bil(cMacro, xm + 4, ym) + bil(cMeso, xm + 4, ym) - bil(cMacro, xm - 4, ym) - bil(cMeso, xm - 4, ym),
          bil(cMacro, xm, ym + 4) + bil(cMeso, xm, ym + 4) - bil(cMacro, xm, ym - 4) - bil(cMeso, xm, ym - 4)) / 8;
        if ((pool || chan) && g < 0.006 && wr[this.marsh] > 0.4) {
          const Lp = this.marshLevel(xm, ym, levels), depth = pool ? 0.25 + 0.9 * Math.min(1, (p - pt) / 0.08) : 0.35;
          e = Math.min(e, Lp - depth); lv = Lp; kd = WK_MARSH;
        } else if (g < 0.009) {
          // Dry marsh ground stands above the water of any pool beside it, by more than the largest level step
          // between two 64 m cells on flat ground (0.006 x 64 m), so pools that cross a cell edge cannot spill.
          let top = -Infinity;
          for (const [dx, dy] of RIM) top = Math.max(top, this.marshLevel(xm + dx, ym + dy, levels));
          e = Math.max(e, top + 0.4);
        }
      }
      E[k] = e; level[k] = lv; kind[k] = kd; biome[k] = kd === WK_SEA ? 255 : chosen;
    }

    // Materials, cover, moisture, paths, trees and rocks for the region proper.
    const out: RegionData = {
      rx, ry, size: S, ox, oy, elev: new Float32Array(S * S), mat: new Uint8Array(S * S), cover: new Uint8Array(S * S), coverVar: new Uint8Array(S * S),
      moisture: new Uint8Array(S * S), waterLevel: new Float32Array(S * S), waterKind: new Uint8Array(S * S), biome: new Uint8Array(S * S), objects: [], ms: 0,
    };
    const ids = this.bp.data.regions.map((r) => r.id);
    const path = this.rasterPaths(ox, oy, S);
    // Distance to water (m, capped at 30) for moisture and shores.
    const wd = new Float32Array(S * S).fill(30);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) if (kind[(j + 1) * M + i + 1] !== WK_NONE) wd[j * S + i] = 0;
    for (let pass = 0; pass < 2; pass++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const ii = pass ? S - 1 - i : i, jj = pass ? S - 1 - j : j, k = jj * S + ii, st = pass ? 1 : -1;
      if (ii + st >= 0 && ii + st < S) wd[k] = Math.min(wd[k], wd[k + st] + 1);
      if (jj + st >= 0 && jj + st < S) wd[k] = Math.min(wd[k], wd[k + st * S] + 1);
    }
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i, km = (j + 1) * M + i + 1, e = E[km];
      const sl = Math.hypot(E[km + 1] - E[km - 1], E[km + M] - E[km - M]) / 2;
      const kd = kind[km], b = biome[km], gx = ox + i, gy = oy + j, h = hash2(gx, gy, salt + 7), n = fbm(gx / 90, gy / 90, 3, salt + 8);
      out.elev[k] = e; out.waterLevel[k] = level[km]; out.waterKind[k] = kd; out.biome[k] = b;
      out.coverVar[k] = Math.floor(hash2(gx, gy, salt + 9) * 256);
      const id = ids[b] ?? 'sea';
      const baseMoist: Record<string, number> = { 'whispering-marshes': 200, elderwood: 150, heartlands: 110, 'golden-plains': 70, 'dragon-peaks': 90, 'hollow-lands': 40, sea: 255 };
      out.moisture[k] = Math.min(255, Math.round((baseMoist[id] ?? 100) * 0.6 + 255 * Math.max(0, 1 - wd[k] / 30) * 0.5));
      let mat: number = Mat.Grass, cover: number = Cover.ShortGrass;
      // North-facing slopes (ground rising to the south) hold snow lower.
      const north = Math.max(0, Math.min(1, (E[km + M] - E[km - M]) / 2 / 0.4));
      if (kd !== WK_NONE) { mat = kd === WK_MARSH ? Mat.Bog : kd === WK_SEA ? Mat.Sand : e < (level[km] - 2.5) ? Mat.Stone : Mat.Sand; cover = Cover.None; }
      else if (e > 1030 + n * 120 - north * 90 && sl < 1.1) { mat = Mat.Snow; cover = Cover.None; }
      else if (sl > 0.9) { mat = Mat.Cliff; cover = Cover.None; }
      else if (sl > 0.55) { mat = id === 'dragon-peaks' || id === 'hollow-lands' ? (h < 0.5 ? Mat.Scree : Mat.Stone) : Mat.Stone; cover = Cover.None; }
      else if (wd[k] <= 2 && e < 3) { mat = Mat.Sand; cover = Cover.None; }
      else switch (id) {
        case 'heartlands': mat = n > 0.58 ? Mat.Meadow : Mat.Grass; cover = h < 0.07 ? Cover.Flowers : h < 0.16 ? Cover.Clover : n > 0.6 ? Cover.TallGrass : Cover.ShortGrass; break;
        case 'golden-plains': {
          // Dry golden grassland, wind-combed; meadow hollows and wildflower drifts.
          const fl = fbm(gx / 140, gy / 140, 2, salt + 140);
          mat = n > 0.64 ? Mat.Meadow : Mat.DryGrass;
          cover = fl > 0.66 && h < 0.4 ? Cover.Flowers : h < 0.55 ? Cover.GoldenGrass : n > 0.5 ? Cover.TallGrass : Cover.ShortGrass;
          break;
        }
        case 'elderwood': mat = n > 0.55 ? Mat.Moss : Mat.ForestFloor; cover = h < 0.25 ? Cover.Fern : h < 0.5 ? Cover.Litter : h < 0.62 ? Cover.MossPatch : Cover.None; break;
        case 'whispering-marshes':
          // Bog at the water's edge, reed beds around it, wet moss and tussocks between.
          if (wd[k] <= 2) { mat = Mat.Bog; cover = h < 0.75 ? Cover.Reeds : Cover.None; }
          else if (wd[k] <= 6) { mat = n > 0.45 ? Mat.Bog : Mat.Mud; cover = h < 0.55 ? Cover.Reeds : Cover.TallGrass; }
          else { mat = n > 0.66 ? Mat.Moss : n < 0.32 ? Mat.Mud : Mat.Bog; cover = h < 0.35 ? Cover.Reeds : h < 0.8 ? Cover.TallGrass : Cover.MossPatch; }
          break;
        case 'hollow-lands': {
          // Ash and bare rock, thorn scrub, and ember cracks that glow along the fissures.
          const n2 = fbm(gx / 50, gy / 50, 2, salt + 150);
          mat = n > 0.5 ? Mat.Ash : n2 > 0.62 ? Mat.Stone : sl > 0.35 ? Mat.Scree : Mat.Dirt;
          cover = h < 0.05 ? Cover.Thorns : Cover.None;
          if (this.emberCrack(gx + 0.5, gy + 0.5)) { mat = Mat.Ash; cover = Cover.Embers; }
          break;
        }
        case 'dragon-peaks':
          // Scree below the snow, alpine meadow below the scree, pine forest in the valleys.
          if (e > 870 + n * 100) { mat = n > 0.55 ? Mat.Stone : Mat.Scree; cover = h < 0.06 ? Cover.MossPatch : Cover.None; }
          else if (e > 720 + n * 80) { mat = n > 0.5 ? Mat.Meadow : Mat.Grass; cover = h < 0.12 ? Cover.Flowers : h < 0.3 ? Cover.MossPatch : Cover.ShortGrass; }
          else { mat = n > 0.6 ? Mat.Moss : Mat.ForestFloor; cover = h < 0.3 ? Cover.Litter : h < 0.38 ? Cover.Fern : Cover.None; }
          break;
      }
      if (path[k] && kd === WK_NONE) { mat = Mat.Path; cover = Cover.None; }
      out.mat[k] = mat; out.cover[k] = cover;
    }
    this.placeObjects(out, path, wd, E, M);
    out.ms = performance.now() - t0;
    return out;
  }

  /**
   * Ember cracks: thin glowing lines that wander along the Hollow Lands fissures (and, rarely, elsewhere in the
   * Hollow Lands). Pure function of position.
   */
  private emberCrack(x: number, y: number): boolean {
    let near = 0;
    for (const f of this.fissures) {
      const a = f.pts;
      for (let k = 0; k + 3 < a.length; k += 2) {
        const dx = a[k + 2] - a[k], dy = a[k + 3] - a[k + 1], l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a[k]) * dx + (y - a[k + 1]) * dy) / l2));
        const d = Math.hypot(a[k] + dx * t - x, a[k + 1] + dy * t - y);
        if (d < f.w * 1.5) near = Math.max(near, 1 - d / (f.w * 1.5));
      }
    }
    const c = Math.abs(fbm(x / 70, y / 70, 3, this.salt + 160) - 0.5);
    return c < 0.003 + 0.012 * near;
  }

  /** 1 = a path cell. Major roads 3 m wide, minor 2 m, trails 1.5 m. */
  private rasterPaths(ox: number, oy: number, S: number): Uint8Array {
    const m = new Uint8Array(S * S);
    for (const p of this.paths) {
      const hw = p.cls === 'major' ? 1.5 : p.cls === 'minor' ? 1 : 0.75, a = p.pts;
      for (let k = 0; k + 3 < a.length; k += 2) {
        const ax = a[k], ay = a[k + 1], bx = a[k + 2], by = a[k + 3];
        if (Math.max(ax, bx) < ox - 3 || Math.min(ax, bx) > ox + S + 3 || Math.max(ay, by) < oy - 3 || Math.min(ay, by) > oy + S + 3) continue;
        const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L * 2));
        for (let s = 0; s <= n; s++) {
          const x = ax + ((bx - ax) * s) / n, y = ay + ((by - ay) * s) / n;
          for (let yy = Math.floor(y - hw); yy <= Math.floor(y + hw); yy++) for (let xx = Math.floor(x - hw); xx <= Math.floor(x + hw); xx++) {
            const i = xx - ox, j = yy - oy;
            if (i >= 0 && j >= 0 && i < S && j < S && Math.hypot(xx + 0.5 - x, yy + 0.5 - y) <= hw) m[j * S + i] = 1;
          }
        }
      }
    }
    return m;
  }

  /** Trees and rocks on jittered grids (density by biome, forest patches and slope); none on water, paths or village sites. */
  private placeObjects(out: RegionData, path: Uint8Array, wd: Float32Array, E: Float32Array, M: number): void {
    const S = out.size, salt = this.salt, ids = this.bp.data.regions.map((r) => r.id);
    const villages = this.bp.data.settlements.map((s) => ({ x: s.at[0] * this.mpu, y: s.at[1] * this.mpu, r: s.footprintRadius * this.mpu + 40 }));
    const nearVillage = (x: number, y: number) => villages.some((v) => Math.hypot(x - v.x, y - v.y) < v.r);
    const DENS: Record<string, [number, string[]]> = {
      elderwood: [0.55, ['oak', 'oak', 'pine', 'birch', 'willow']], heartlands: [0.07, ['oak', 'birch', 'blossom']],
      'golden-plains': [0.012, ['oak', 'oak', 'birch']], 'whispering-marshes': [0.12, ['willow', 'willow', 'willow', 'dead', 'birch']],
      'hollow-lands': [0.05, ['dead', 'dead', 'dead', 'pine']], 'dragon-peaks': [0.32, ['pine', 'pine', 'pine', 'birch']],
    };
    const G = 5;
    const ok = (i: number, j: number) => {
      const k = j * S + i, km = (j + 1) * M + i + 1;
      if (i < 1 || j < 1 || i >= S - 1 || j >= S - 1 || out.waterKind[k] !== WK_NONE || wd[k] < 2) return false;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const q = (j + dy) * S + i + dx; if (q >= 0 && q < S * S && path[q]) return false; }
      return Math.hypot(E[km + 1] - E[km - 1], E[km + M] - E[km - M]) / 2 < 0.6;
    };
    for (let gj = 0; gj < S / G; gj++) for (let gi = 0; gi < S / G; gi++) {
      const gx = out.ox + gi * G, gy = out.oy + gj * G;
      const i = gi * G + Math.floor(hash2(gx, gy, salt + 20) * G), j = gj * G + Math.floor(hash2(gx, gy, salt + 21) * G);
      if (!ok(i, j)) continue;
      const k = j * S + i, id = ids[out.biome[k]];
      if (!id || nearVillage(out.ox + i, out.oy + j)) continue;
      const [d0, kinds] = DENS[id] ?? [0.05, ['oak']];
      const e = out.elev[k];
      let d = d0 * Math.min(1.6, Math.max(0, (fbm((out.ox + i) / 600, (out.oy + j) / 600, 3, salt + 22) - 0.3) * 2.6));
      if (id === 'dragon-peaks') d *= smoothstep(800, 660, e); // tree line below the alpine meadows
      if (id === 'heartlands') d *= 1 + 6 * smoothstep(0.62, 0.75, fbm((out.ox + i) / 250, (out.oy + j) / 250, 3, salt + 23)); // copses
      if (id === 'golden-plains') d = d0; // lone trees, evenly rare
      if (hash2(gx, gy, salt + 24) < d) {
        out.objects.push({ kind: 'tree', x: i, y: j, variant: kinds[Math.floor(hash2(gx, gy, salt + 25) * kinds.length)] });
        if (id === 'elderwood' && hash2(gx, gy, salt + 26) < 0.04 && ok(i + 2, j + 1)) out.objects.push({ kind: 'mushroom', x: i + 2, y: j + 1, variant: hash2(gx, gy, salt + 27) < 0.3 ? 'glow' : 'brown' });
      }
    }
    const RG = 11;
    for (let gj = 0; gj < Math.floor(S / RG); gj++) for (let gi = 0; gi < Math.floor(S / RG); gi++) {
      const gx = out.ox + gi * RG, gy = out.oy + gj * RG;
      const i = gi * RG + 1 + Math.floor(hash2(gx, gy, salt + 30) * (RG - 2)), j = gj * RG + 1 + Math.floor(hash2(gx, gy, salt + 31) * (RG - 2));
      if (!ok(i, j)) continue;
      const k = j * S + i, id = ids[out.biome[k]];
      const d = id === 'dragon-peaks' ? 0.14 : id === 'hollow-lands' ? 0.12 : id === 'golden-plains' ? 0.035 : 0.012;
      if (hash2(gx, gy, salt + 32) >= d || nearVillage(out.ox + i, out.oy + j)) continue;
      const v = hash2(gx, gy, salt + 33);
      // Plains: weathered outcrops standing out of the grass; Hollow Lands: jagged formations and big rocks.
      const variant = id === 'golden-plains' ? (v < 0.6 ? 'formation' : 'big') : id === 'hollow-lands' ? (v < 0.4 ? 'formation' : v < 0.7 ? 'big' : 'boulder') : v < 0.7 ? 'boulder' : 'big';
      out.objects.push({ kind: 'rock', x: i, y: j, variant });
    }
  }
}

/** Distance from a point to a river segment, with the interpolated surface and half-width there. */
function segDist(s: Seg, x: number, y: number): { d: number; s: number; h: number } {
  const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2));
  return { d: Math.hypot(s.ax + dx * t - x, s.ay + dy * t - y), s: s.sa + (s.sb - s.sa) * t, h: s.ha + (s.hb - s.ha) * t };
}

