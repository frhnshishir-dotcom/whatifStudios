import type { World } from '../world/World';
import type { ObjectStore } from '../objects/ObjectStore';
import { Mat } from '../world/materials';

/** A place worth visiting. */
export interface POI { x: number; y: number; kind: string; label: string; interest: number }
export type LandingPref = 'any' | 'water' | 'cliff' | 'shelter' | 'open' | 'glade';

interface WaterLike { depth: Float32Array; fall: Float32Array }
interface Feature { kind: string; x: number; y: number }

const TILE = 4;
/** Object heights in metres come from sprite rows at the reference relief (rows per metre). */
const ROWS_PER_M = 0.75;
const FEATURE_INTEREST: Record<string, number> = {
  'large waterfall': 1, waterfall: 0.8, lake: 0.7, pond: 0.45, 'glowing glade': 0.85, 'christmas tree': 0.75,
  'water mill': 0.5, bridge: 0.35, cottage: 0.35, 'mill race': 0.3,
};

/**
 * What the dragon can sense of the world, built on the existing grids: terrain, water depth and waterfalls from the
 * water view, objects from the store. Keeps a coarse 4 x 4 "obstacle top" grid (highest terrain, water surface or
 * object in each tile) for cheap flight clearance checks; it is rebuilt only when terrain or objects change.
 */
export class DragonSenses {
  readonly world: World;
  objects: ObjectStore;
  water: WaterLike | null;
  readonly tw: number;
  readonly th: number;
  private top: Float32Array;
  private builtFor = '';
  pois: POI[] = [];

  constructor(world: World, objects: ObjectStore, water: WaterLike | null) {
    this.world = world;
    this.objects = objects;
    this.water = water;
    this.tw = Math.ceil(world.w / TILE);
    this.th = Math.ceil(world.h / TILE);
    this.top = new Float32Array(this.tw * this.th);
  }

  private idx(x: number, y: number): number {
    const w = this.world;
    return Math.min(w.h - 1, Math.max(0, Math.floor(y))) * w.w + Math.min(w.w - 1, Math.max(0, Math.floor(x)));
  }
  terrain(x: number, y: number): number { return this.world.elev[this.idx(x, y)]; }
  depth(x: number, y: number): number { return this.water ? this.water.depth[this.idx(x, y)] : 0; }
  /** Terrain or water surface. */
  ground(x: number, y: number): number { const i = this.idx(x, y); return this.world.elev[i] + (this.water ? this.water.depth[i] : 0); }
  fall(x: number, y: number): number { return this.water ? this.water.fall[this.idx(x, y)] : 0; }

  /** Highest terrain / water / object top in the tile around (x, y). */
  obstacleTop(x: number, y: number): number {
    this.refresh();
    const tx = Math.min(this.tw - 1, Math.max(0, Math.floor(x / TILE))), ty = Math.min(this.th - 1, Math.max(0, Math.floor(y / TILE)));
    return this.top[ty * this.tw + tx];
  }

  /** Height of an object above its ground (metres). */
  objectHeight(id: number): number {
    const o = this.objects.objects.get(id);
    if (!o) return 0;
    let up = 0;
    for (const c of this.objects.sprite(o)) up = Math.max(up, c.up);
    return (up + 1) / ROWS_PER_M;
  }

  private builtAt = -1e9;

  refresh(force = false): void {
    const key = `${this.world.terrainVersion}:${this.objects.version}`;
    if (!force && key === this.builtFor) return;
    // While the world is being edited (a new version every frame), rebuild at most twice a second.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && this.builtFor !== '' && now - this.builtAt < 500) return;
    this.builtAt = now;
    this.builtFor = key;
    const w = this.world, top = this.top;
    top.fill(-1e9);
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      const t = ((y / TILE) | 0) * this.tw + ((x / TILE) | 0), g = this.ground(x, y);
      if (g > top[t]) top[t] = g;
    }
    for (const o of this.objects.objects.values()) {
      let up = 0, minDx = 0, maxDx = 0;
      for (const c of this.objects.sprite(o)) { up = Math.max(up, c.up); minDx = Math.min(minDx, c.dx); maxDx = Math.max(maxDx, c.dx); }
      const h = this.terrain(o.x, o.y) + (up + 1) / ROWS_PER_M;
      for (let y = o.y - 1; y <= o.y + 2; y++) for (let x = o.x + minDx; x <= o.x + maxDx; x++) {
        if (!w.inBounds(x, y)) continue;
        const t = ((y / TILE) | 0) * this.tw + ((x / TILE) | 0);
        if (h > top[t]) top[t] = h;
      }
    }
  }

  /** Steepness: height range over the 3 x 3 neighbourhood. */
  slope(x: number, y: number): number {
    let mn = Infinity, mx = -Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const e = this.terrain(x + dx, y + dy); mn = Math.min(mn, e); mx = Math.max(mx, e); }
    return mx - mn;
  }

  /** Solid, dry, level ground without objects nearby, away from the world edge. */
  isLandable(x: number, y: number): boolean {
    const w = this.world, cx = Math.round(x), cy = Math.round(y);
    if (cx < 5 || cy < 5 || cx > w.w - 6 || cy > w.h - 6) return false;
    if (this.slope(cx, cy) > 1.0) return false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const i = (cy + dy) * w.w + cx + dx;
      if (this.objects.occ[i]) return false;
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && this.water && this.water.depth[i] > 0.03) return false;
    }
    return true;
  }

  /** Count of objects of `kind` within r cells. */
  countNear(x: number, y: number, r: number, kind: string): number {
    let n = 0;
    for (const o of this.objects.inRect(x - r, y - r, x + r, y + r, [])) if (o.kind === kind && Math.hypot(o.x - x, o.y - y) <= r) n++;
    return n;
  }

  /** Under trees or beside cliffs (cover from rain). */
  isSheltered(x: number, y: number): boolean {
    if (this.countNear(x, y, 5, 'tree') >= 4) return true;
    let cliff = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (this.terrain(x + dx, y + dy) > this.terrain(x, y) + 2.5) cliff++;
    return cliff >= 6;
  }

  /** How well a landable spot suits a preference (higher is better). */
  landingScore(x: number, y: number, pref: LandingPref): number {
    const w = this.world, i = this.idx(x, y);
    switch (pref) {
      case 'water': {
        let wet = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (this.depth(x + dx, y + dy) > 0.2) wet++;
        return wet >= 2 ? 1 + Math.min(1, wet / 12) : -1;
      }
      case 'cliff': {
        let lower = 0, rock = 0;
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
          if (this.terrain(x + dx, y + dy) < this.terrain(x, y) - 1.5) lower++;
          const m = w.mat[this.idx(x + dx, y + dy)];
          if (m === Mat.Stone || m === Mat.Cliff) rock++;
        }
        return lower / 20 + rock / 30 + (this.terrain(x, y) - 10) * 0.02;
      }
      case 'shelter': return this.countNear(x, y, 6, 'tree') * 0.3 + (this.isSheltered(x, y) ? 1 : 0);
      case 'open': return 1 - this.countNear(x, y, 6, 'tree') * 0.2;
      case 'glade': return w.magic[i] / 255 * 2;
      default: return 0.5;
    }
  }

  /** Best landable spot near (cx, cy) for a preference, or null. Deterministic for a given random source. */
  findLanding(cx: number, cy: number, r: number, pref: LandingPref, rand: () => number): { x: number; y: number; score: number } | null {
    let best: { x: number; y: number; score: number } | null = null;
    for (let k = 0; k < 70; k++) {
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r;
      const x = Math.round(cx + Math.cos(a) * d), y = Math.round(cy + Math.sin(a) * d);
      if (!this.isLandable(x, y)) continue;
      const s = this.landingScore(x, y, pref) - (d / Math.max(1, r)) * 0.3;
      if (pref === 'water' && s < 0) continue;
      if (!best || s > best.score) best = { x, y, score: s };
    }
    return best;
  }

  /** A deep-water cell near (x, y) within r (for drinking), scanning outward. */
  nearestDeepWater(x: number, y: number, r: number): { x: number; y: number } | null {
    for (let d = 0; d <= r; d++) for (let a = 0; a < Math.max(1, d * 6); a++) {
      const t = (a / Math.max(1, d * 6)) * Math.PI * 2, px = Math.round(x + Math.cos(t) * d), py = Math.round(y + Math.sin(t) * d);
      if (this.world.inBounds(px, py) && this.depth(px, py) > 0.3) return { x: px, y: py };
    }
    return null;
  }

  /** Points of interest: generator landmarks (when known) plus what can be read from the grids. */
  scanPOIs(features: Feature[] | null): POI[] {
    const w = this.world, out: POI[] = [];
    const add = (x: number, y: number, kind: string, interest: number, label = kind) => {
      if (x < 8 || y < 8 || x > w.w - 9 || y > w.h - 9) return;
      if (out.some((p) => Math.hypot(p.x - x, p.y - y) < 12)) return;
      out.push({ x, y, kind, label, interest });
    };
    for (const f of features ?? []) if (FEATURE_INTEREST[f.kind] !== undefined) add(f.x, f.y, f.kind, FEATURE_INTEREST[f.kind], f.kind);
    // Waterfalls and open water read from the simulation.
    if (this.water) {
      for (let y = 8; y < w.h - 8; y += 3) for (let x = 8; x < w.w - 8; x += 3) if (this.fall(x, y) > 0.3) add(x, y, 'waterfall', 0.8);
      for (let y = 8; y < w.h - 8; y += 8) for (let x = 8; x < w.w - 8; x += 8) {
        let deep = 0;
        for (let dy = -3; dy <= 3; dy += 3) for (let dx = -3; dx <= 3; dx += 3) if (this.depth(x + dx, y + dy) > 0.6) deep++;
        if (deep >= 7) add(x, y, 'lake', 0.55, 'open water');
      }
    }
    // Peaks, cliffs, rock formations and clearings.
    const peaks: Array<[number, number, number]> = [];
    for (let y = 16; y < w.h - 16; y += 12) for (let x = 16; x < w.w - 16; x += 12) {
      let mx = -Infinity, px = x, py = y;
      for (let dy = -6; dy < 6; dy += 2) for (let dx = -6; dx < 6; dx += 2) { const e = this.terrain(x + dx, y + dy); if (e > mx) { mx = e; px = x + dx; py = y + dy; } }
      peaks.push([px, py, mx]);
    }
    peaks.sort((a, b) => b[2] - a[2]).slice(0, 3).forEach(([x, y]) => add(x, y, 'mountain', 0.5, 'high ground'));
    let cliffs = 0;
    for (let y = 10; y < w.h - 10 && cliffs < 3; y += 5) for (let x = 10; x < w.w - 10 && cliffs < 3; x += 5) {
      if (w.mat[y * w.w + x] === Mat.Cliff && this.slope(x, y) > 2.5) { const n = out.length; add(x, y, 'cliff', 0.45); if (out.length > n) cliffs++; }
    }
    let rocks = 0;
    for (const o of this.objects.objects.values()) if (o.kind === 'rock' && o.variant === 'formation' && rocks < 4) { const n = out.length; add(o.x, o.y, 'rocks', 0.4, 'rock formation'); if (out.length > n) rocks++; }
    let clear = 0;
    for (let y = 20; y < w.h - 20 && clear < 4; y += 14) for (let x = 20; x < w.w - 20 && clear < 4; x += 14) {
      if (this.isLandable(x, y) && this.countNear(x, y, 7, 'tree') === 0 && this.depth(x, y) < 0.01) { const n = out.length; add(x, y, 'clearing', 0.35); if (out.length > n) clear++; }
    }
    this.pois = out;
    return out;
  }
}
