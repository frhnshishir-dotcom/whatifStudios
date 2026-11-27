import { editFromJSON, type RegionEditJSON } from '../src/world/edits';
import type { ContinentTerrain } from '../src/world/terrain';

/**
 * Who may change which part of the world, checked by the server for every region edit a client sends.
 *
 * An edit is accepted only if all of these hold:
 *   1. Its key names a region ("rx,ry") and its content parses and stays in range (editFromJSON): cell indices
 *      inside the region, finite heights, known object kinds, water and sources inside the region. Lists are
 *      bounded.
 *   2. The region is within reach: the editing player's region or one of the eight around it (what a player sees
 *      and can edit in the browser).
 *   3. It touches no protected ground: village footprints (with a margin), landmarks and old places, and road
 *      bridges. A development server can allow these edits (`allowVillageEdits`).
 *   4. If the region has an owner, the editor is that owner. Ownership is kept and saved, ready for player housing;
 *      players cannot claim regions yet.
 * Every accepted edit records its author and time.
 */

export interface EditMeta { by: string; at: number }
const S = 256, CELLS = S * S;
const LIMITS = { removed: 4000, added: 2000, water: CELLS, sources: 64 };

export class RegionGuard {
  readonly owners = new Map<string, string>();
  readonly meta = new Map<string, EditMeta>();
  private masks = new Map<string, Uint8Array | null>();

  constructor(private terrain: ContinentTerrain, private allowVillageEdits = false) {}

  /** Cells of a region no player may change (null: none). */
  protectedMask(rx: number, ry: number): Uint8Array | null {
    const key = `${rx},${ry}`;
    if (this.masks.has(key)) return this.masks.get(key)!;
    const ox = rx * S, oy = ry * S;
    let mask: Uint8Array | null = null;
    const mark = (x0: number, y0: number, x1: number, y1: number) => {
      const a = Math.max(0, Math.floor(x0 - ox)), b = Math.min(S - 1, Math.ceil(x1 - ox)), c = Math.max(0, Math.floor(y0 - oy)), d = Math.min(S - 1, Math.ceil(y1 - oy));
      if (a > b || c > d) return;
      mask ??= new Uint8Array(CELLS);
      for (let y = c; y <= d; y++) mask.fill(1, y * S + a, y * S + b + 1);
    };
    for (const v of this.terrain.villagesNear(ox - 40, oy - 40, ox + S + 40, oy + S + 40)) { const [x0, y0, x1, y1] = v.bbox; mark(x0 - 8, y0 - 8, x1 + 8, y1 + 8); }
    for (const p of this.terrain.places()) mark(p.x - 16, p.y - 16, p.x + 16, p.y + 16);
    for (const b of this.terrain.bridges) { const r = b.length / 2 + 6; mark(b.x - r, b.y - r, b.x + r, b.y + r); }
    this.masks.set(key, mask);
    return mask;
  }

  claim(key: string, owner: string): void { this.owners.set(key, owner); }

  /** null when the edit may be applied; otherwise the reason it is refused. */
  check(key: unknown, edit: RegionEditJSON | null, by: string, at: { x: number; y: number }): string | null {
    if (typeof key !== 'string') return 'bad region key';
    const m = /^(-?\d{1,4}),(-?\d{1,4})$/.exec(key);
    if (!m) return 'bad region key';
    const rx = +m[1], ry = +m[2];
    const prx = Math.floor(at.x / S), pry = Math.floor(at.y / S);
    if (Math.abs(rx - prx) > 1 || Math.abs(ry - pry) > 1) return 'that region is out of your reach';
    const owner = this.owners.get(key);
    if (owner && owner !== by) return 'that region belongs to someone else';
    if (edit === null) return this.allowVillageEdits || !this.protectedMask(rx, ry) ? null : 'this region has protected ground; it cannot be reset';
    const parsed = editFromJSON(edit, CELLS);
    if (typeof parsed === 'string') return `unreadable edit (${parsed})`;
    if (parsed.removed.length > LIMITS.removed || parsed.added.length > LIMITS.added || parsed.sources.length + parsed.drains.length > LIMITS.sources) return 'edit too large';
    if ((edit.removed?.length ?? 0) !== parsed.removed.length || (edit.added?.length ?? 0) !== parsed.added.length) return 'edit lists objects it cannot contain';
    for (const v of parsed.mat) if (v > 63) return 'unknown material';
    for (const v of parsed.elev) if (Math.abs(v) > 3000) return 'height out of range';
    if (!this.allowVillageEdits) {
      const mask = this.protectedMask(rx, ry);
      if (mask) {
        for (const i of parsed.idx) if (mask[i]) return 'villages, landmarks and bridges are protected';
        for (const i of parsed.waterIdx) if (mask[i]) return 'villages, landmarks and bridges are protected';
        for (const a of parsed.added) if (mask[a.y * S + a.x]) return 'villages, landmarks and bridges are protected';
        for (const sig of parsed.removed) { // "kind:x,y:variant"
          const p = /^[a-z]+:(\d+),(\d+):/.exec(sig);
          if (!p) return 'edit lists objects it cannot contain';
          const i = +p[2] * S + +p[1];
          if (i < CELLS && mask[i]) return 'villages, landmarks and bridges are protected';
        }
      }
    }
    return null;
  }

  record(key: string, by: string, at: number): void { this.meta.set(key, { by, at }); }

  toJSON(): Record<string, unknown> { return { owners: Object.fromEntries(this.owners), meta: Object.fromEntries(this.meta) }; }
  load(j: unknown): void {
    if (!j || typeof j !== 'object') return;
    const o = j as { owners?: Record<string, unknown>; meta?: Record<string, unknown> };
    for (const [k, v] of Object.entries(o.owners ?? {})) if (typeof v === 'string') this.owners.set(k, v);
    for (const [k, v] of Object.entries(o.meta ?? {})) if (v && typeof v === 'object' && typeof (v as EditMeta).by === 'string') this.meta.set(k, v as EditMeta);
  }
}
