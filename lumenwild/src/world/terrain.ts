import { type Blueprint, regionField, lakeRadius, marshPool, blueprintSalt } from './blueprint';
import type { WorldData } from './schema';
import { fbm, ridged } from '../engine/core/noise';
import { hash2 } from '../engine/core/rng';
import { smoothstep } from '../engine/core/math';
import { Mat, Cover } from '../engine/world/materials';
import { Uniformizer, biomeShares, pickBiome, pickBiomeEdge, UNBLENDED, packBlend, SHARE_FLOOR } from './ecotone';
import { planVillage, type VillagePlan, type SiteQuery } from './villages';
import { BUILDING_TYPES } from '../engine/objects/defs';

type WorldLake = WorldData['lakes'][number];

/**
 * Continent terrain at 1 m, from the blueprint. Every value is a pure function of continent position, so regions
 * generated separately (main thread, worker, server) agree exactly along their edges. Layers:
 *  macro  smooth bicubic surface of the blueprint (before river carving)
 *  meso   ridges, hills and gullies (100 m - 4 km), strength by region, flattened along valleys and near shores
 *  micro  1-40 m roughness
 *  water  rivers carved at their true width with banks scaled to how deep they cut; lakes at the blueprint level;
 *         marsh pools; the sea below 0 m
 *  biomes natural patches at borders (see ecotone.ts): shares from the blueprint tilted by elevation, slope and
 *         wetness; patches from smooth warped noise; clumped ground cover; ground colour leaning toward the
 *         neighbouring biome by its share; tree density blended across borders so groves cross them
 */

export const WK_NONE = 0, WK_SEA = 1, WK_LAKE = 2, WK_RIVER = 3, WK_MARSH = 4;

/**
 * A generated object (region-local cell). `props` holds non-default properties; a `z` there is an absolute height
 * (m) and becomes relative to the window's datum when the object is placed.
 */
export interface RegionObject { kind: 'tree' | 'rock' | 'mushroom' | 'building' | 'span' | 'mill'; x: number; y: number; variant: string; props?: Record<string, number> }

/** A road bridge where a road crosses a river (continent metres; deck height absolute). */
export interface BridgeSite { road: string; river: string; x: number; y: number; dir: 0 | 1; length: number; z: number; cx: number; cy: number }
export interface RegionData {
  rx: number; ry: number; size: number;
  /** Continent cell of the region's top-left cell. */
  ox: number; oy: number;
  elev: Float32Array; mat: Uint8Array; cover: Uint8Array; coverVar: Uint8Array; moisture: Uint8Array;
  /** Water surface (m) per cell, NaN where dry; and what kind of water. */
  waterLevel: Float32Array; waterKind: Uint8Array;
  /** Region index of the cell's biome patch (255 = sea). */
  biome: Uint8Array;
  /** Ground-colour blend toward a neighbouring biome (see ecotone.packBlend); 0 = none. */
  blend: Uint32Array;
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
  /** Road bridges (where each road's path crosses a river). */
  readonly bridges: BridgeSite[] = [];
  /** Village plans, made on first use (pure: the same in a worker and on the main thread). */
  private plans = new Map<string, VillagePlan>();
  private salt: number;
  private marsh: number;
  /** fbm ranks: 2 and 3 octaves. */
  private u2: Uniformizer;
  private u3: Uniformizer;
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
    this.u2 = new Uniformizer(2, 7001);
    this.u3 = new Uniformizer(3, 7002);
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
      for (const b of r.bridges) { const site = this.bridgeSite(out, b.at[0] * this.mpu, b.at[1] * this.mpu, r.id, b.river); if (site) this.bridges.push(site); }
    }
  }

  /** Inside a river channel (continent metres)? */
  private inRiver(x: number, y: number): { s: number; h: number; dx: number; dy: number } | null {
    for (const si of this.segsNear(x - 1, y - 1, x + 1, y + 1)) {
      const sg = this.segs[si], d = segDist(sg, x, y);
      if (d.d < d.h) { const L = Math.hypot(sg.bx - sg.ax, sg.by - sg.ay) || 1; return { s: d.s, h: d.h, dx: (sg.bx - sg.ax) / L, dy: (sg.by - sg.ay) / L }; }
    }
    return null;
  }

  /**
   * Where a road's path crosses the river near a blueprint bridge: the wet stretch of the path (sampled every metre)
   * nearest the blueprint point gives the crossing; the deck runs across the river along the axis nearer its normal,
   * from bank to bank plus 4 m onto each, above the river surface.
   */
  private bridgeSite(pts: number[], bx: number, by: number, road: string, river: string): BridgeSite | null {
    const runs: Array<Array<[number, number]>> = [];
    let run: Array<[number, number]> | null = null;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k], ay = pts[k + 1], cx = pts[k + 2], cy = pts[k + 3];
      if (Math.min(Math.hypot(ax - bx, ay - by), Math.hypot(cx - bx, cy - by)) > 300) { run = null; continue; }
      const L = Math.hypot(cx - ax, cy - ay), n = Math.max(1, Math.ceil(L));
      for (let t = 0; t < n; t++) {
        const x = ax + ((cx - ax) * t) / n, y = ay + ((cy - ay) * t) / n;
        if (this.inRiver(x, y)) { if (!run) runs.push((run = [])); run.push([x, y]); } else run = null;
      }
    }
    if (!runs.length) return null;
    let best = runs[0], bd = Infinity;
    for (const r of runs) { const m = r[r.length >> 1], d = Math.hypot(m[0] - bx, m[1] - by); if (d < bd) { bd = d; best = r; } }
    const [cx, cy] = best[best.length >> 1];
    const here = this.inRiver(cx, cy)!;
    // Across the river: along x when the river runs more north-south, along y when it runs more east-west.
    const dir: 0 | 1 = Math.abs(here.dy) >= Math.abs(here.dx) ? 0 : 1;
    const ux = dir === 0 ? 1 : 0, uy = dir === 0 ? 0 : 1;
    const reach = (sgn: number) => { let t = 0; while (t < 400 && this.inRiver(cx + ux * sgn * (t + 1), cy + uy * sgn * (t + 1))) t++; return t + 1; };
    const a = reach(-1), b = reach(1), length = Math.round(a + b + 8);
    const x = Math.round(dir === 0 ? cx - a - 4 : cx - 1), y = Math.round(dir === 0 ? cy - 1 : cy - a - 4);
    return { road, river, x, y, dir, length, z: here.s + 1.4 + 0.02 * here.h, cx, cy };
  }

  /** Ground and water as village planning reads them (smooth ground; rivers, lakes and the sea). */
  siteQuery(): SiteQuery {
    const w = new Float64Array(this.bp.data.regions.length), mpu = this.mpu, lakes = this.bp.data.lakes;
    return {
      z: (x, y) => {
        const sd = this.segsNear(x - 1, y - 1, x + 1, y + 1).map((i) => segDist(this.segs[i], x, y));
        const near = lakes.filter((l) => Math.hypot(l.at[0] * mpu - x, l.at[1] * mpu - y) < (l.radius + 9) * mpu);
        const n = this.node(x, y, sd, near, w);
        // River valleys are carved below the smooth ground: follow the bank down near a river.
        let z = n.macro + n.meso;
        for (const d of sd) if (d.d < d.h * 6 + 60) z = Math.min(z, d.s + 0.3 + Math.max(0, z - d.s - 0.3) * smoothstep(d.h, d.h * 6 + 60, d.d));
        return z;
      },
      wet: (x, y, margin) => {
        if (this.macroAt(x, y) < 1) return true;
        for (const i of this.segsNear(x - margin, y - margin, x + margin, y + margin)) { const d = segDist(this.segs[i], x, y); if (d.d < d.h + margin) return true; }
        for (const l of lakes) {
          const dx = x - l.at[0] * mpu, dy = y - l.at[1] * mpu, dd = Math.hypot(dx, dy);
          if (dd < (l.radius * 1.2 + 1) * mpu + margin && dd < lakeRadius(this.bp.data, l, Math.atan2(dy, dx)) * mpu + margin) return true;
        }
        return false;
      },
    };
  }

  /** The village plans whose area meets a rectangle (continent metres). */
  villagesNear(x0: number, y0: number, x1: number, y1: number): VillagePlan[] {
    const out: VillagePlan[] = [];
    for (const s of this.bp.data.settlements) {
      const r = s.footprintRadius * this.mpu + 40, sx = s.at[0] * this.mpu, sy = s.at[1] * this.mpu;
      if (sx + r < x0 || sx - r > x1 || sy + r < y0 || sy - r > y1) continue;
      out.push(this.village(s.id)!);
    }
    return out;
  }

  /** A village's plan (made once). */
  village(id: string): VillagePlan | null {
    let p = this.plans.get(id);
    if (p) return p;
    const s = this.bp.data.settlements.find((q) => q.id === id);
    if (!s) return null;
    const r = s.footprintRadius * this.mpu + 60, sx = s.at[0] * this.mpu, sy = s.at[1] * this.mpu;
    const roads: Array<Array<[number, number]>> = [];
    for (const path of this.paths) {
      const a = path.pts, near: Array<[number, number]> = [];
      for (let k = 0; k + 1 < a.length; k += 2) if (Math.hypot(a[k] - sx, a[k + 1] - sy) < r) near.push([a[k], a[k + 1]]);
      if (near.length > 1) roads.push(near);
    }
    p = planVillage(s, this.siteQuery(), roads, this.mpu, this.regionCells);
    this.plans.set(id, p);
    return p;
  }

  /**
   * Draw villages and bridges into a generated region: levelled pads, lanes and the square, fields; building, mill
   * and bridge objects (each in the region holding its anchor cell).
   */
  private buildSettlements(out: RegionData, kind: Uint8Array, M: number): void {
    const S = out.size, ox = out.ox, oy = out.oy;
    const land = (i: number, j: number) => kind[(j + 1) * M + i + 1] === WK_NONE;
    for (const v of this.villagesNear(ox, oy, ox + S, oy + S)) {
      if (v.bbox[2] < ox || v.bbox[0] > ox + S || v.bbox[3] < oy || v.bbox[1] > oy + S) continue;
      const laneMat = v.culture === 'frost-lodge' || v.culture === 'elder-grove' ? Mat.Dirt : Mat.Path;
      // Fields first (lanes and pads draw over their edges).
      for (const f of v.fields) {
        for (let y = Math.max(f.y0, oy); y < Math.min(f.y1, oy + S); y++) for (let x = Math.max(f.x0, ox); x < Math.min(f.x1, ox + S); x++) {
          const i = x - ox, j = y - oy, k = j * S + i;
          if (!land(i, j) || out.mat[k] === Mat.Path) continue;
          const row = Math.floor((f.dir === 0 ? y - f.y0 : x - f.x0) / 2) % 2, edge = x === f.x0 || y === f.y0 || x === f.x1 - 1 || y === f.y1 - 1;
          if (f.kind === 'pasture') { out.mat[k] = Mat.Meadow; out.cover[k] = edge ? Cover.TallGrass : (hash2(x, y, 41) < 0.2 ? Cover.Clover : Cover.ShortGrass); }
          else if (f.kind === 'gardens') { out.mat[k] = Mat.Meadow; out.cover[k] = edge ? Cover.Fern : row ? Cover.Flowers : Cover.Clover; }
          else if (edge) { out.mat[k] = Mat.Grass; out.cover[k] = Cover.TallGrass; }
          else if (row) { out.mat[k] = Mat.Dirt; out.cover[k] = Cover.None; }
          else { out.mat[k] = v.culture === 'plains-farmstead' ? Mat.DryGrass : Mat.Meadow; out.cover[k] = v.culture === 'plains-farmstead' ? Cover.GoldenGrass : Cover.TallGrass; }
          out.blend[k] = 0;
        }
      }
      // Square and lanes.
      const paint = (x: number, y: number) => {
        const i = x - ox, j = y - oy;
        if (i < 0 || j < 0 || i >= S || j >= S || !land(i, j)) return;
        const k = j * S + i;
        out.mat[k] = laneMat; out.cover[k] = Cover.None; out.blend[k] = 0;
      };
      const sq = v.square;
      for (let y = -sq.r; y <= sq.r; y++) for (let x = -sq.r; x <= sq.r; x++) if (x * x + y * y <= sq.r * sq.r) paint(sq.x + x, sq.y + y);
      const hw = v.laneWidth >> 1;
      for (const lane of v.lanes) for (let k = 0; k + 1 < lane.length; k++) {
        const [ax, ay] = lane[k], [bx, by] = lane[k + 1];
        for (let t = 0; t <= 6; t++) { const x = Math.round(ax + ((bx - ax) * t) / 6), y = Math.round(ay + ((by - ay) * t) / 6); for (let dy = -hw; dy <= hw; dy++) for (let dx = -hw; dx <= hw; dx++) paint(x + dx, y + dy); }
      }
      // Buildings: pads levelled from this region's ground (a pad never crosses a region edge), then the objects.
      for (const b of v.buildings) {
        const inside = b.x - 1 >= ox && b.y - 1 >= oy && b.x + b.w < ox + S && b.y + b.d < oy + S;
        if (b.pad && inside) {
          let sum = 0, n = 0;
          for (let y = b.y; y < b.y + b.d; y++) for (let x = b.x; x < b.x + b.w; x++) { sum += out.elev[(y - oy) * S + x - ox]; n++; }
          const z = sum / n;
          for (let y = b.y - 1; y <= b.y + b.d; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) {
            const k = (y - oy) * S + x - ox;
            out.elev[k] = z; out.mat[k] = Mat.Dirt; out.cover[k] = Cover.None; out.blend[k] = 0;
          }
        }
        if (b.x < ox || b.y < oy || b.x >= ox + S || b.y >= oy + S) continue;
        if (b.type === 'water-mill') out.objects.push({ kind: 'mill', x: b.x - ox, y: b.y - oy, variant: 'stone', props: { wheelSide: b.wheelSide ?? 1 } });
        else out.objects.push({ kind: 'building', x: b.x - ox, y: b.y - oy, variant: v.culture, props: { t: BUILDING_TYPES.indexOf(b.type as never), w: b.w, d: b.d, floors: b.floors } });
      }
    }
    for (const br of this.bridges) {
      if (br.x < ox || br.y < oy || br.x >= ox + S || br.y >= oy + S) continue;
      out.objects.push({ kind: 'span', x: br.x - ox, y: br.y - oy, variant: 'timber', props: { length: br.length, dir: br.dir, z: br.z } });
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

    /** Smooth ground (macro + meso) at the coarse nodes: what ecology reads for elevation and slope. */
    const cSmooth = new Float32Array(CN * CN);
    for (let k = 0; k < CN * CN; k++) cSmooth[k] = cMacro[k] + cMeso[k];

    // Fine elevation and water over the region plus a one-cell margin.
    const E = new Float32Array(M * M), level = new Float32Array(M * M).fill(NaN), kind = new Uint8Array(M * M);
    /** Wetness 0..1 (pure: near rivers, lakes, the marsh, the coast and valley floors). */
    const wet = new Float32Array(M * M);
    const wr = new Float64Array(R), levels = new Map<number, number>();
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const xm = ox - 1 + i + 0.5, ym = oy - 1 + j + 0.5, k = j * M + i, ux = xm / mpu, uy = ym / mpu;
      const macro = bil(cMacro, xm, ym);
      let micro = 0;
      for (let r = 0; r < R; r++) {
        wr[r] = bil(cW, xm, ym, R, r);
        if (wr[r] > 0.001) micro += wr[r] * this.styles[r].micro;
      }
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
      let wv = this.marsh >= 0 ? wr[this.marsh] * 0.9 : 0;
      wv = Math.max(wv, 0.35 * smoothstep(0, -25, smooth - macro), 0.5 * (1 - smoothstep(2, 12, macro)));
      if (near) for (const si of near) {
        const d = segDist(segs[si], xm, ym);
        if (d.d < d.h + 80) wv = Math.max(wv, 1 - smoothstep(d.h, d.h + 80, d.d));
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
        if (d < re + 150) wv = Math.max(wv, 1 - smoothstep(re, re + 150, d));
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
      E[k] = e; level[k] = lv; kind[k] = kd; wet[k] = wv;
    }

    // Materials, cover, moisture, paths, trees and rocks for the region proper.
    const out: RegionData = {
      rx, ry, size: S, ox, oy, elev: new Float32Array(S * S), mat: new Uint8Array(S * S), cover: new Uint8Array(S * S), coverVar: new Uint8Array(S * S),
      moisture: new Uint8Array(S * S), waterLevel: new Float32Array(S * S), waterKind: new Uint8Array(S * S), biome: new Uint8Array(S * S), blend: new Uint32Array(S * S), objects: [], ms: 0,
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
    const baseMoist: Record<string, number> = { 'whispering-marshes': 200, elderwood: 150, heartlands: 110, 'golden-plains': 70, 'dragon-peaks': 90, 'hollow-lands': 40 };
    /** Biome shares per cell (ecology-tilted; used again for trees and rocks). */
    const P = new Float32Array(S * S * R), pr = new Float64Array(R), wcell = new Float64Array(R);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i, km = (j + 1) * M + i + 1, e = E[km];
      const sl = Math.hypot(E[km + 1] - E[km - 1], E[km + M] - E[km - M]) / 2;
      const kd = kind[km], gx = ox + i, gy = oy + j, xm = gx + 0.5, ym = gy + 0.5, n = fbm(gx / 90, gy / 90, 3, salt + 8);
      out.elev[k] = e; out.waterLevel[k] = level[km]; out.waterKind[k] = kd;
      out.coverVar[k] = Math.floor(hash2(gx, gy, salt + 9) * 256);
      // Biome patch: shares (blueprint weights tilted by ecology), then a smooth warped noise picks within them.
      // Ecology reads the smooth ground (elevation and slope over 8 m), not the 1 m roughness, so it varies smoothly.
      let several = 0;
      for (let r = 0; r < R; r++) { wcell[r] = bil(cW, xm, ym, R, r); if (wcell[r] > SHARE_FLOOR) several++; }
      if (several > 1) {
        const zs = (x: number, y: number) => bil(cSmooth, x, y);
        const slE = Math.hypot(zs(xm + 4, ym) - zs(xm - 4, ym), zs(xm, ym + 4) - zs(xm, ym - 4)) / 8;
        biomeShares(ids, wcell, zs(xm, ym), slE, wet[km], pr);
      } else biomeShares(ids, wcell, e, sl, wet[km], pr);
      let present = 0, top = 0;
      for (let r = 0; r < R; r++) { P[k * R + r] = pr[r]; if (pr[r] > 0) present++; if (pr[r] > pr[top]) top = r; }
      // (In a core only one biome is present: no patch noise needed.)
      let b = top, edge = Infinity;
      if (kd === WK_SEA) b = 255;
      else if (present > 1) [b, edge] = pickBiomeEdge(pr, this.patchU(xm, ym));
      out.biome[k] = b;
      const id = ids[b] ?? 'sea';
      let moist = 0;
      for (let r = 0; r < R; r++) moist += pr[r] * (baseMoist[ids[r]] ?? 100);
      out.moisture[k] = kd === WK_SEA ? 255 : Math.min(255, Math.round(moist * 0.6 + 255 * Math.max(0, 1 - wd[k] / 30) * 0.5));
      // Clumped cover (a few metres), not single random cells.
      const cl = this.u2.at(fbm(gx / 5, gy / 5, 2, salt + 180));
      let mat: number = Mat.Grass, cover: number = Cover.ShortGrass;
      // North-facing slopes (ground rising to the south) hold snow lower.
      const north = Math.max(0, Math.min(1, (E[km + M] - E[km - M]) / 2 / 0.4));
      if (kd !== WK_NONE) { mat = kd === WK_MARSH ? Mat.Bog : kd === WK_SEA ? Mat.Sand : e < (level[km] - 2.5) ? Mat.Stone : Mat.Sand; cover = Cover.None; }
      else if (e > 1030 + n * 120 - north * 90 && sl < 1.1) { mat = Mat.Snow; cover = Cover.None; }
      else if (sl > 0.9) { mat = Mat.Cliff; cover = Cover.None; }
      else if (sl > 0.55) { mat = id === 'dragon-peaks' || id === 'hollow-lands' ? (this.u2.at(fbm(gx / 4, gy / 4, 2, salt + 181)) < 0.5 ? Mat.Scree : Mat.Stone) : Mat.Stone; cover = Cover.None; }
      else if (wd[k] <= 2 && e < 3) { mat = Mat.Sand; cover = Cover.None; }
      else [mat, cover] = this.ground(id, e, sl, n, wd[k], gx, gy, cl);
      if (path[k] && kd === WK_NONE) { mat = Mat.Path; cover = Cover.None; }
      out.mat[k] = mat; out.cover[k] = cover;
      // Ground colour leans toward the strongest other biome here, by how much of the ground is theirs, and toward
      // half-way at a patch edge (feathered over a few metres), so patches have soft rims.
      if (kd === WK_NONE && b !== 255 && !UNBLENDED.has(mat) && pr[b] < 0.97) {
        let b2 = -1;
        for (let r = 0; r < R; r++) if (r !== b && (b2 < 0 || pr[r] > pr[b2])) b2 = r;
        const amt = Math.max(Math.min(0.6, (1 - pr[b]) * 0.9), 0.5 * (1 - smoothstep(0, 0.12, edge)));
        if (b2 >= 0 && pr[b2] > 0.02) {
          const m2 = this.ground(ids[b2], e, sl, n, wd[k], gx, gy, cl)[0];
          if (m2 !== mat && !UNBLENDED.has(m2)) out.blend[k] = packBlend(mat, m2, amt);
        }
      }
    }
    this.placeObjects(out, path, wd, E, M, P);
    this.buildSettlements(out, kind, M);
    out.ms = performance.now() - t0;
    return out;
  }

  /** Patch noise at a point: smooth, domain-warped, ranked to 0..1 (patches of tens of metres with ragged edges). */
  private patchU(x: number, y: number): number {
    const s = this.salt, wx = (fbm(x / 110, y / 110, 2, s + 170) - 0.5) * 90, wy = (fbm(x / 110, y / 110, 2, s + 171) - 0.5) * 90;
    return this.u3.at(fbm((x + wx) / 48, (y + wy) / 48, 3, s + 172));
  }

  /**
   * Ground material and cover a biome gives a spot of land (gentle ground; snow, cliffs and steep rock are decided
   * before). `n`: 90 m noise; `wd`: metres to water (capped at 30); `cl`: clump rank 0..1.
   */
  private ground(id: string, e: number, sl: number, n: number, wd: number, gx: number, gy: number, cl: number): [number, number] {
    const salt = this.salt;
    switch (id) {
      case 'heartlands':
        return [n > 0.58 ? Mat.Meadow : Mat.Grass, cl < 0.07 ? Cover.Flowers : cl < 0.16 ? Cover.Clover : n > 0.6 ? Cover.TallGrass : Cover.ShortGrass];
      case 'golden-plains': {
        // Dry golden grassland, wind-combed; meadow hollows and wildflower drifts.
        const fl = fbm(gx / 140, gy / 140, 2, salt + 140);
        return [n > 0.64 ? Mat.Meadow : Mat.DryGrass, fl > 0.66 && cl < 0.4 ? Cover.Flowers : cl < 0.55 ? Cover.GoldenGrass : n > 0.5 ? Cover.TallGrass : Cover.ShortGrass];
      }
      case 'elderwood':
        return [n > 0.55 ? Mat.Moss : Mat.ForestFloor, cl < 0.25 ? Cover.Fern : cl < 0.5 ? Cover.Litter : cl < 0.62 ? Cover.MossPatch : Cover.None];
      case 'whispering-marshes':
        // Bog at the water's edge, reed beds around it, wet moss and tussocks between.
        if (wd <= 2) return [Mat.Bog, cl < 0.75 ? Cover.Reeds : Cover.None];
        if (wd <= 6) return [n > 0.45 ? Mat.Bog : Mat.Mud, cl < 0.55 ? Cover.Reeds : Cover.TallGrass];
        return [n > 0.66 ? Mat.Moss : n < 0.32 ? Mat.Mud : Mat.Bog, cl < 0.35 ? Cover.Reeds : cl < 0.8 ? Cover.TallGrass : Cover.MossPatch];
      case 'hollow-lands': {
        // Ash and bare rock, thorn scrub, and ember cracks that glow along the fissures.
        if (this.emberCrack(gx + 0.5, gy + 0.5)) return [Mat.Ash, Cover.Embers];
        const n2 = fbm(gx / 50, gy / 50, 2, salt + 150);
        return [n > 0.5 ? Mat.Ash : n2 > 0.62 ? Mat.Stone : sl > 0.35 ? Mat.Scree : Mat.Dirt, cl < 0.05 ? Cover.Thorns : Cover.None];
      }
      case 'dragon-peaks':
        // Scree below the snow, alpine meadow below the scree, pine forest in the valleys.
        if (e > 870 + n * 100) return [n > 0.55 ? Mat.Stone : Mat.Scree, cl < 0.06 ? Cover.MossPatch : Cover.None];
        if (e > 720 + n * 80) return [n > 0.5 ? Mat.Meadow : Mat.Grass, cl < 0.12 ? Cover.Flowers : cl < 0.3 ? Cover.MossPatch : Cover.ShortGrass];
        return [n > 0.6 ? Mat.Moss : Mat.ForestFloor, cl < 0.3 ? Cover.Litter : cl < 0.38 ? Cover.Fern : Cover.None];
      default:
        return [Mat.Grass, Cover.ShortGrass];
    }
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

  /**
   * Trees and rocks on jittered grids; none on water, paths or village sites. Density is the share-weighted blend of
   * every biome present (so forests thin out across a border and groves cross it), modulated by groves and clearings;
   * the species come from a coarser patch of the same shares, so stands of one biome's trees reach into the next.
   */
  private placeObjects(out: RegionData, path: Uint8Array, wd: Float32Array, E: Float32Array, M: number, P: Float32Array): void {
    const S = out.size, salt = this.salt, ids = this.bp.data.regions.map((r) => r.id), R = ids.length;
    const villages = this.bp.data.settlements.map((s) => ({ x: s.at[0] * this.mpu, y: s.at[1] * this.mpu, r: s.footprintRadius * this.mpu + 40 }));
    const nearVillage = (x: number, y: number) => villages.some((v) => Math.hypot(x - v.x, y - v.y) < v.r);
    const SPECIES: Record<string, string[]> = {
      elderwood: ['oak', 'oak', 'pine', 'birch', 'willow'], heartlands: ['oak', 'birch', 'blossom'], 'golden-plains': ['oak', 'oak', 'birch'],
      'whispering-marshes': ['willow', 'willow', 'willow', 'dead', 'birch'], 'hollow-lands': ['dead', 'dead', 'dead', 'pine'], 'dragon-peaks': ['pine', 'pine', 'pine', 'birch'],
    };
    /** Tree density (chance per 5 m grid cell) of a biome at a spot. */
    const DENS_AT = (id: string, e: number, forest: number, copse: number): number => {
      switch (id) {
        case 'elderwood': return 0.55 * forest;
        case 'heartlands': return 0.07 * forest * copse;
        case 'golden-plains': return 0.012; // lone trees, evenly rare
        case 'whispering-marshes': return 0.12 * forest;
        case 'hollow-lands': return 0.05 * forest;
        case 'dragon-peaks': return 0.32 * forest * smoothstep(800, 660, e); // tree line below the meadows
        default: return 0.05 * forest;
      }
    };
    const ROCKS: Record<string, number> = { 'dragon-peaks': 0.14, 'hollow-lands': 0.12, 'golden-plains': 0.035 };
    const G = 5;
    const bridges = this.bridges.filter((b) => b.x - 6 < out.ox + S && b.x + (b.dir ? 3 : b.length) + 6 > out.ox && b.y - 6 < out.oy + S && b.y + (b.dir ? b.length : 3) + 6 > out.oy)
      .map((b) => ({ x0: b.x - 4, y0: b.y - 4, x1: b.x + (b.dir ? 3 : b.length) + 3, y1: b.y + (b.dir ? b.length : 3) + 3 }));
    const ok = (i: number, j: number) => {
      const k = j * S + i, km = (j + 1) * M + i + 1;
      if (i < 1 || j < 1 || i >= S - 1 || j >= S - 1 || out.waterKind[k] !== WK_NONE || wd[k] < 2) return false;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const q = (j + dy) * S + i + dx; if (q >= 0 && q < S * S && path[q]) return false; }
      // Keep bridge decks and their approaches clear (rocks and trees can reach a few cells from their anchor).
      const gx = out.ox + i, gy = out.oy + j;
      for (const b of bridges) if (gx >= b.x0 && gx <= b.x1 && gy >= b.y0 && gy <= b.y1) return false;
      return Math.hypot(E[km + 1] - E[km - 1], E[km + M] - E[km - M]) / 2 < 0.6;
    };
    const shares = new Float64Array(R);
    for (let gj = 0; gj < S / G; gj++) for (let gi = 0; gi < S / G; gi++) {
      const gx = out.ox + gi * G, gy = out.oy + gj * G;
      const i = gi * G + Math.floor(hash2(gx, gy, salt + 20) * G), j = gj * G + Math.floor(hash2(gx, gy, salt + 21) * G);
      if (!ok(i, j)) continue;
      const k = j * S + i, x = out.ox + i, y = out.oy + j;
      if (out.biome[k] === 255 || nearVillage(x, y)) continue;
      for (let r = 0; r < R; r++) shares[r] = P[k * R + r];
      const e = out.elev[k];
      const forest = Math.min(1.6, Math.max(0, (fbm(x / 600, y / 600, 3, salt + 22) - 0.3) * 2.6));
      const copse = 1 + 6 * smoothstep(0.62, 0.75, fbm(x / 250, y / 250, 3, salt + 23));
      let d = 0;
      for (let r = 0; r < R; r++) if (shares[r] >= 0.005) d += shares[r] * DENS_AT(ids[r], e, forest, copse);
      // The patch's own biome sets most of the density (forest patches are denser than the meadow beside them);
      // the blend lets stands carry across. Groves and clearings (about 140 m) do not stop at a border.
      const own = ids[out.biome[k]];
      d = 0.6 * DENS_AT(own, e, forest, copse) + 0.4 * d;
      d *= 0.55 + 0.9 * this.u2.at(fbm(x / 140, y / 140, 2, salt + 190));
      if (hash2(gx, gy, salt + 24) < d) {
        const sp = ids[pickBiome(shares, this.u2.at(fbm(x / 170, y / 170, 2, salt + 191)))];
        const kinds = SPECIES[sp] ?? ['oak'];
        out.objects.push({ kind: 'tree', x: i, y: j, variant: kinds[Math.floor(hash2(gx, gy, salt + 25) * kinds.length)] });
        if (sp === 'elderwood' && hash2(gx, gy, salt + 26) < 0.04 && ok(i + 2, j + 1)) out.objects.push({ kind: 'mushroom', x: i + 2, y: j + 1, variant: hash2(gx, gy, salt + 27) < 0.3 ? 'glow' : 'brown' });
      }
    }
    const RG = 11;
    for (let gj = 0; gj < Math.floor(S / RG); gj++) for (let gi = 0; gi < Math.floor(S / RG); gi++) {
      const gx = out.ox + gi * RG, gy = out.oy + gj * RG;
      const i = gi * RG + 1 + Math.floor(hash2(gx, gy, salt + 30) * (RG - 2)), j = gj * RG + 1 + Math.floor(hash2(gx, gy, salt + 31) * (RG - 2));
      if (!ok(i, j)) continue;
      const k = j * S + i, id = ids[out.biome[k]];
      if (!id) continue;
      let d = 0;
      for (let r = 0; r < R; r++) d += P[k * R + r] * (ROCKS[ids[r]] ?? 0.012);
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

