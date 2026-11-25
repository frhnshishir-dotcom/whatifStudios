import { CHUNK, type World } from '../world/World';
import { OBJECT_DEFS, OBJ_KINDS, type ObjKind, type SpriteCell, type WorldObject } from './defs';

/**
 * All placed objects. Keeps an occupancy grid (object id per ground cell, 0 = free) for picking and placement
 * checks, chunk buckets for fast view queries, cached sprites, and the world's `solid` mask (objects that block water).
 */
export class ObjectStore {
  readonly world: World;
  readonly objects = new Map<number, WorldObject>();
  readonly occ: Int32Array;
  private buckets = new Map<number, Set<number>>();
  private sprites = new Map<number, SpriteCell[]>();
  private nextId = 1;
  version = 0;
  /** Called after any change with the affected ground rectangle (the editor wakes the water there). */
  onChange: ((x0: number, y0: number, x1: number, y1: number) => void) | null = null;

  constructor(world: World) {
    this.world = world;
    this.occ = new Int32Array(world.n);
  }

  footprint(o: WorldObject): Array<[number, number]> {
    return OBJECT_DEFS[o.kind].footprint(o).map(([dx, dy]) => [o.x + dx, o.y + dy]);
  }

  /** Why an object can't go here (null = it can). Bridges may span water; others need free in-bounds ground. */
  canPlace(o: Omit<WorldObject, 'id'>, ignoreId = 0): string | null {
    if (!OBJECT_DEFS[o.kind]) return `unknown kind ${o.kind}`;
    const fp = OBJECT_DEFS[o.kind].footprint(o as WorldObject);
    for (const [dx, dy] of fp) {
      const x = o.x + dx, y = o.y + dy;
      if (!this.world.inBounds(x, y)) return 'outside the world';
      const occ = this.occ[y * this.world.w + x];
      if (occ && occ !== ignoreId) return 'occupied';
    }
    return null;
  }

  add(o: Omit<WorldObject, 'id'> & { id?: number }): number | null {
    if (this.canPlace(o)) return null;
    const id = o.id && !this.objects.has(o.id) ? o.id : this.nextId++;
    this.nextId = Math.max(this.nextId, id + 1);
    const obj: WorldObject = { id, kind: o.kind, x: o.x, y: o.y, variant: o.variant, props: { ...OBJECT_DEFS[o.kind].defaults, ...o.props } };
    this.objects.set(id, obj);
    this.stamp(obj, id);
    this.bucket(obj).add(id);
    this.version++;
    this.changed(obj);
    return id;
  }

  remove(id: number): WorldObject | null {
    const o = this.objects.get(id);
    if (!o) return null;
    this.stamp(o, 0);
    this.bucket(o).delete(id);
    this.objects.delete(id);
    this.sprites.delete(id);
    this.version++;
    this.changed(o);
    return o;
  }

  /** Change variant/props/position; returns false (and changes nothing) if the new footprint is blocked. */
  update(id: number, patch: Partial<Pick<WorldObject, 'x' | 'y' | 'variant' | 'props'>>): boolean {
    const o = this.objects.get(id);
    if (!o) return false;
    const next = { ...o, ...patch, props: { ...o.props, ...(patch.props ?? {}) } };
    this.stamp(o, 0);
    if (this.canPlace(next, id)) { this.stamp(o, id); return false; }
    this.bucket(o).delete(id);
    const before = { ...o };
    Object.assign(o, next);
    this.stamp(o, id);
    this.bucket(o).add(id);
    this.sprites.delete(id);
    this.version++;
    this.changed(before);
    this.changed(o);
    return true;
  }

  at(i: number): WorldObject | null {
    const id = this.occ[i];
    return id ? this.objects.get(id) ?? null : null;
  }

  sprite(o: WorldObject): SpriteCell[] {
    let s = this.sprites.get(o.id);
    if (!s) { s = OBJECT_DEFS[o.kind].sprite(o); this.sprites.set(o.id, s); }
    return s;
  }

  /** Objects whose anchor lies in the rectangle (inclusive), via chunk buckets. */
  inRect(x0: number, y0: number, x1: number, y1: number, out: WorldObject[] = []): WorldObject[] {
    out.length = 0;
    const cx0 = Math.max(0, Math.floor(x0 / CHUNK)), cy0 = Math.max(0, Math.floor(y0 / CHUNK));
    const cx1 = Math.min(this.world.chunksX - 1, Math.floor(x1 / CHUNK)), cy1 = Math.min(this.world.chunksY - 1, Math.floor(y1 / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const b = this.buckets.get(cy * this.world.chunksX + cx);
      if (!b) continue;
      for (const id of b) { const o = this.objects.get(id)!; if (o.x >= x0 && o.x <= x1 && o.y >= y0 && o.y <= y1) out.push(o); }
    }
    return out;
  }

  /**
   * Streaming: move every object by (-sx, -sy) cells, dropping those that leave the world, and rebuild the occupancy,
   * solid mask and buckets. Ids (and cached sprites) are kept. No change callbacks: the caller resets the water.
   */
  shift(sx: number, sy: number): void {
    const keep: WorldObject[] = [];
    for (const o of this.objects.values()) {
      const m = { ...o, x: o.x - sx, y: o.y - sy };
      if (this.footprint(m).every(([x, y]) => this.world.inBounds(x, y))) keep.push(m);
      else this.sprites.delete(o.id);
    }
    this.objects.clear(); this.buckets.clear(); this.occ.fill(0); this.world.solid.fill(0);
    for (const o of keep) { this.objects.set(o.id, o); this.stamp(o, o.id); this.bucket(o).add(o.id); }
    this.version++;
  }

  clear(): void {
    for (const id of [...this.objects.keys()]) this.remove(id);
    this.nextId = 1;
  }

  count(kind?: ObjKind): number {
    if (!kind) return this.objects.size;
    let n = 0;
    for (const o of this.objects.values()) if (o.kind === kind) n++;
    return n;
  }

  toJSON(): WorldObject[] {
    return [...this.objects.values()].map((o) => ({ ...o, props: { ...o.props } }));
  }

  /** Replace everything (load). Invalid entries are skipped and reported. */
  load(list: WorldObject[]): string[] {
    this.clear();
    const problems: string[] = [];
    for (const o of list) {
      if (!OBJ_KINDS.includes(o.kind)) { problems.push(`unknown object kind ${o.kind}`); continue; }
      if (this.add(o) === null) problems.push(`could not place ${o.kind} #${o.id} at ${o.x},${o.y}`);
    }
    return problems;
  }

  private stamp(o: WorldObject, id: number): void {
    const solid = OBJECT_DEFS[o.kind].solid;
    for (const [x, y] of this.footprint(o)) {
      if (!this.world.inBounds(x, y)) continue;
      const i = y * this.world.w + x;
      this.occ[i] = id;
      if (solid) this.world.solid[i] = id ? 1 : 0;
    }
  }

  private bucket(o: WorldObject): Set<number> {
    const c = Math.floor(o.y / CHUNK) * this.world.chunksX + Math.floor(o.x / CHUNK);
    let b = this.buckets.get(c);
    if (!b) { b = new Set(); this.buckets.set(c, b); }
    return b;
  }

  private changed(o: WorldObject): void {
    if (!this.onChange) return;
    const fp = this.footprint(o);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of fp) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    this.onChange(x0, y0, x1, y1);
  }
}
