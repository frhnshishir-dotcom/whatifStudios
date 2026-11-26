/**
 * Shared pieces of the living world (wildlife, villagers, dragons, players). Everything lives in continent metres and
 * reads the ground through a TerrainQuery, so the same simulation runs in the browser (backed by the loaded window)
 * and on a server (backed by generated regions).
 */

export interface TerrainQuery {
  /** Ground height (m, absolute); on a bridge deck, the deck. */
  height(x: number, y: number): number;
  /** Open water (river, lake, sea, pool, or a deep pond) at a point. */
  water(x: number, y: number): boolean;
  /** Can something walk here (land or a bridge deck, not inside a building or rock, not a cliff)? */
  walkable(x: number, y: number): boolean;
  /** Region (biome) id. */
  biome(x: number, y: number): string;
  /** Is 1 m detail available here (inside the loaded area)? Outside, answers are coarse. */
  detailed(x: number, y: number): boolean;
}

export interface LifeClock {
  /** Hour of day 0..24. */
  hour: number;
  /** Rain 0..1. */
  rain: number;
  /** Simulation seconds since the start of the world clock. */
  t: number;
}

export type AgentKind = 'creature' | 'villager' | 'player' | 'dragon';

/** Anything other agents can see: position, what it is, how big a threat it is. */
export interface Agent {
  id: string;
  kind: AgentKind;
  /** Species, role or name tag (for perception rules). */
  tag: string;
  x: number;
  y: number;
  /** Height above ground (m); 0 on the ground. */
  alt: number;
  alive: boolean;
}

/** A uniform grid of agents for neighbourhood queries (rebuilt each tick for the agents being simulated). */
export class SpatialHash {
  private cells = new Map<number, Agent[]>();
  constructor(readonly cell = 32) {}
  clear(): void { this.cells.clear(); }
  private key(cx: number, cy: number): number { return (cy + 32768) * 65536 + (cx + 32768); }
  add(a: Agent): void {
    const k = this.key(Math.floor(a.x / this.cell), Math.floor(a.y / this.cell));
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push(a);
  }
  /** Agents within r of (x, y) (excluding `self`). */
  near(x: number, y: number, r: number, out: Agent[] = [], self?: Agent): Agent[] {
    out.length = 0;
    const c = this.cell, x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c), y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const l = this.cells.get(this.key(cx, cy));
      if (!l) continue;
      for (const a of l) if (a !== self && Math.hypot(a.x - x, a.y - y) <= r) out.push(a);
    }
    return out;
  }
}

/** Deterministic 0..1 from a string and numbers (spawning, personalities). */
export function hashOf(...parts: Array<string | number>): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) { const s = String(p); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } h ^= 0x9e; h = Math.imul(h, 16777619) >>> 0; }
  return h / 4294967296;
}

/** Seeded generator (mulberry32). */
export function rngOf(...parts: Array<string | number>): () => number {
  let a = Math.floor(hashOf(...parts) * 4294967296) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const angleTo = (ax: number, ay: number, bx: number, by: number) => Math.atan2(by - ay, bx - ax);
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Is the hour inside [from, to) on a 24 h clock (wrapping past midnight)? */
export const inHours = (h: number, from: number, to: number) => (from <= to ? h >= from && h < to : h >= from || h < to);

/**
 * Step a walker toward (tx, ty) at `speed`, sliding around obstacles: tries the direct heading, then headings turned
 * by up to 90 degrees either way. Returns the distance moved.
 */
export function walkToward(a: { x: number; y: number; h: number }, tx: number, ty: number, speed: number, dt: number, q: TerrainQuery, canSwim = false): number {
  const d = Math.hypot(tx - a.x, ty - a.y);
  if (d < 0.05) return 0;
  const step = Math.min(d, speed * dt), want = Math.atan2(ty - a.y, tx - a.x);
  for (const off of [0, 0.5, -0.5, 1, -1, 1.57, -1.57]) {
    const h = want + off, nx = a.x + Math.cos(h) * step, ny = a.y + Math.sin(h) * step;
    if (q.walkable(nx, ny) || (canSwim && q.water(nx, ny))) { a.x = nx; a.y = ny; a.h = h; return step; }
  }
  return 0;
}
