import { World, shiftGrid, heapAlloc, type Alloc } from '../engine/world/World';
import type { ContinentTerrain, RegionData, RegionObject } from './terrain';
import type { Blueprint } from './blueprint';

/** Regions per side of the loaded window (3 x 3 = 768 x 768 m around the focus). */
export const WINDOW_REGIONS = 3;

const key = (rx: number, ry: number) => `${rx},${ry}`;

/**
 * Generated regions, least recently used first out. Generation runs in a worker when one is given (results arrive
 * asynchronously) or on the calling thread. Regions are pure functions of position, so a region can always be
 * regenerated identically after eviction.
 */
export class RegionCache {
  private map = new Map<string, RegionData>();
  private inflight = new Set<string>();
  readonly capacity: number;
  stats = { generated: 0, received: 0, evicted: 0, maxMs: 0, totalMs: 0 };
  private worker: Worker | null;
  onReady: ((r: RegionData) => void) | null = null;

  constructor(private terrain: ContinentTerrain, opts: { capacity?: number; worker?: Worker | null } = {}) {
    this.capacity = opts.capacity ?? 24;
    this.worker = opts.worker ?? null;
    if (this.worker) this.worker.onmessage = (e: MessageEvent<{ region: RegionData }>) => {
      const r = e.data.region;
      this.inflight.delete(key(r.rx, r.ry));
      this.put(r);
      this.stats.received++;
      this.onReady?.(r);
    };
  }

  get size(): number { return this.map.size; }
  has(rx: number, ry: number): boolean { return this.map.has(key(rx, ry)); }

  get(rx: number, ry: number): RegionData | undefined {
    const k = key(rx, ry), r = this.map.get(k);
    if (r) { this.map.delete(k); this.map.set(k, r); }
    return r;
  }

  /** The region now: from the cache, or generated on this thread. */
  ensure(rx: number, ry: number): RegionData {
    const hit = this.get(rx, ry);
    if (hit) return hit;
    const r = this.terrain.generateRegion(rx, ry);
    this.note(r);
    this.put(r);
    return r;
  }

  /** Ask for a region in the background (worker), or generate it now when there is no worker. */
  request(rx: number, ry: number): void {
    const k = key(rx, ry);
    if (this.map.has(k) || this.inflight.has(k)) return;
    if (!this.worker) { this.ensure(rx, ry); return; }
    this.inflight.add(k);
    this.worker.postMessage({ rx, ry });
  }

  private note(r: RegionData): void { this.stats.generated++; this.stats.totalMs += r.ms; this.stats.maxMs = Math.max(this.stats.maxMs, r.ms); }

  private put(r: RegionData): void {
    this.map.set(key(r.rx, r.ry), r);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.stats.evicted++;
    }
  }

  dispose(): void { this.worker?.terminate(); this.worker = null; }
}

/**
 * The loaded part of the continent: one World of 3 x 3 regions. Heights are stored relative to `datum` so the 2.5D
 * view and the water simulation work with numbers like the valley's. Moving the window by a region shifts every
 * array in place and writes only the newly uncovered strip.
 */
export class WorldWindow {
  readonly S: number;
  readonly W: number;
  readonly world: World;
  /** Region coordinates of the window's top-left region. */
  origin: [number, number] = [0, 0];
  datum = 0;
  /** Water surface relative to the datum (NaN = dry) and kind, per cell. */
  readonly waterLevel: Float32Array;
  readonly waterKind: Uint8Array;
  readonly biome: Uint8Array;
  /** Objects of each loaded region (region-local coordinates). */
  private regionObjects = new Map<string, RegionObject[]>();

  constructor(regionCells: number, alloc: Alloc = heapAlloc) {
    this.S = regionCells;
    this.W = regionCells * WINDOW_REGIONS;
    this.world = new World(this.W, this.W, alloc);
    this.waterLevel = new Float32Array(this.W * this.W).fill(NaN);
    this.waterKind = new Uint8Array(this.W * this.W);
    this.biome = new Uint8Array(this.W * this.W);
  }

  /** Region holding the window centre. */
  get centre(): [number, number] { return [this.origin[0] + 1, this.origin[1] + 1]; }

  /** Continent cell of a window cell, and back. */
  toContinent(x: number, y: number): [number, number] { return [this.origin[0] * this.S + x, this.origin[1] * this.S + y]; }
  toWindow(cx: number, cy: number): [number, number] { return [cx - this.origin[0] * this.S, cy - this.origin[1] * this.S]; }

  /** Load all nine regions around `centre` (region coordinates). The datum is set from their lowest ground. */
  load(centre: [number, number], get: (rx: number, ry: number) => RegionData, datum?: number): void {
    this.origin = [centre[0] - 1, centre[1] - 1];
    const regions: RegionData[] = [];
    for (let sy = 0; sy < WINDOW_REGIONS; sy++) for (let sx = 0; sx < WINDOW_REGIONS; sx++) regions.push(get(this.origin[0] + sx, this.origin[1] + sy));
    let lo = Infinity;
    for (const r of regions) for (const e of r.elev) if (e < lo) lo = e;
    this.datum = datum ?? Math.floor(Math.max(-50, lo) / 10) * 10 - 10;
    this.regionObjects.clear();
    regions.forEach((r, k) => this.write(k % WINDOW_REGIONS, Math.floor(k / WINDOW_REGIONS), r));
    this.world.markAllDirty();
  }

  /**
   * Move the window by (dx, dy) regions (each -1, 0 or 1). Arrays shift in place; the uncovered strip is written from
   * `get`. Returns the shift in cells (subtract it from anything held in window coordinates).
   */
  shift(dx: number, dy: number, get: (rx: number, ry: number) => RegionData): [number, number] {
    const S = this.S, W = this.W, sx = dx * S, sy = dy * S, w = this.world;
    for (const a of [w.elev, w.mat, w.cover, w.coverVar, w.moisture, w.magic, this.waterLevel, this.waterKind, this.biome]) shiftGrid(a, W, W, sx, sy);
    this.origin = [this.origin[0] + dx, this.origin[1] + dy];
    const live = new Set<string>();
    for (let gy = 0; gy < WINDOW_REGIONS; gy++) for (let gx = 0; gx < WINDOW_REGIONS; gx++) {
      const rx = this.origin[0] + gx, ry = this.origin[1] + gy;
      live.add(key(rx, ry));
      const fresh = (dx > 0 && gx === WINDOW_REGIONS - 1) || (dx < 0 && gx === 0) || (dy > 0 && gy === WINDOW_REGIONS - 1) || (dy < 0 && gy === 0);
      if (fresh) {
        this.write(gx, gy, get(rx, ry));
        w.markTerrainDirty(gx * S - 1, gy * S - 1, gx * S + S, gy * S + S);
      }
    }
    for (const k of [...this.regionObjects.keys()]) if (!live.has(k)) this.regionObjects.delete(k);
    w.terrainVersion++;
    return [sx, sy];
  }

  private write(gx: number, gy: number, r: RegionData): void {
    const S = this.S, W = this.W, w = this.world, d = this.datum;
    for (let j = 0; j < S; j++) {
      const o = (gy * S + j) * W + gx * S, s = j * S;
      for (let i = 0; i < S; i++) {
        w.elev[o + i] = r.elev[s + i] - d;
        const lv = r.waterLevel[s + i];
        this.waterLevel[o + i] = Number.isNaN(lv) ? NaN : lv - d;
      }
      w.mat.set(r.mat.subarray(s, s + S), o);
      w.cover.set(r.cover.subarray(s, s + S), o);
      w.coverVar.set(r.coverVar.subarray(s, s + S), o);
      w.moisture.set(r.moisture.subarray(s, s + S), o);
      w.magic.fill(0, o, o + S);
      this.waterKind.set(r.waterKind.subarray(s, s + S), o);
      this.biome.set(r.biome.subarray(s, s + S), o);
    }
    this.regionObjects.set(key(r.rx, r.ry), r.objects);
  }

  /** Objects of the regions entering at this strip (window coordinates). */
  objectsOf(gx: number, gy: number): RegionObject[] {
    const list = this.regionObjects.get(key(this.origin[0] + gx, this.origin[1] + gy)) ?? [];
    return list.map((o) => ({ ...o, x: o.x + gx * this.S, y: o.y + gy * this.S }));
  }

  /** All objects of the window (window coordinates). */
  allObjects(): RegionObject[] {
    const out: RegionObject[] = [];
    for (let gy = 0; gy < WINDOW_REGIONS; gy++) for (let gx = 0; gx < WINDOW_REGIONS; gx++) out.push(...this.objectsOf(gx, gy));
    return out;
  }

  /** Water depth per cell for the current contents (level - ground, 0 where dry). */
  waterDepth(out = new Float32Array(this.W * this.W)): Float32Array {
    const e = this.world.elev;
    for (let i = 0; i < out.length; i++) { const lv = this.waterLevel[i]; out[i] = Number.isNaN(lv) ? 0 : Math.max(0, lv - e[i]); }
    return out;
  }
}

export interface Port { x: number; y: number; rate: number }

/**
 * Where rivers cross the window's edge: sources where they flow in (so they keep running) and drains where they flow
 * out. Rates scale with channel width. Window coordinates.
 */
export function riverPorts(bp: Blueprint, win: WorldWindow, ratePerCell = 0.35): { sources: Port[]; drains: Port[] } {
  const mpu = bp.coords.metresPerUnit, W = win.W;
  const [ox, oy] = win.toContinent(0, 0);
  const inside = (x: number, y: number) => x >= ox && y >= oy && x < ox + W && y < oy + W;
  const sources: Port[] = [], drains: Port[] = [];
  for (const r of bp.rivers) {
    const def = bp.data.rivers.find((q) => q.id === r.id)!;
    const n = r.pts.length;
    for (let k = 0; k < n - 1; k++) {
      const ax = r.pts[k][0] * mpu, ay = r.pts[k][1] * mpu, bx = r.pts[k + 1][0] * mpu, by = r.pts[k + 1][1] * mpu;
      const ia = inside(ax, ay), ib = inside(bx, by);
      if (ia === ib) continue;
      // The point just inside the window on this segment.
      let lo = 0, hi = 1;
      for (let it = 0; it < 20; it++) { const m = (lo + hi) / 2; if (inside(ax + (bx - ax) * m, ay + (by - ay) * m) === ia) lo = m; else hi = m; }
      const t = ia ? lo : hi, px = ax + (bx - ax) * t - ox, py = ay + (by - ay) * t - oy;
      const hw = ((def.width[0] + (def.width[1] - def.width[0]) * (k / (n - 1))) * mpu) / 2;
      const list = ib ? sources : drains;
      // A three-cell band across the channel, just inside the edge the river crosses.
      const cx = Math.min(W - 4, Math.max(3, Math.round(px))), cy = Math.min(W - 4, Math.max(3, Math.round(py)));
      const R = Math.max(1, Math.round(hw * 1.2)), vertical = px < 4 || px > W - 4;
      for (let a = -R; a <= R; a++) for (let b = -1; b <= 1; b++) {
        const x = vertical ? cx + b : cx + a, y = vertical ? cy + a : cy + b;
        if (x < 1 || y < 1 || x >= W - 1 || y >= W - 1 || win.waterKind[y * W + x] === 0) continue;
        list.push({ x, y, rate: ib ? ratePerCell : 4 });
      }
    }
  }
  return { sources, drains };
}
