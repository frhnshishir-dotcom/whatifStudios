import { bytesToB64, b64ToBytes } from '../persist/format';
import { OBJECT_DEFS, type ObjKind, type WorldObject } from '../engine/objects/defs';
import type { RegionData, RegionObject } from './terrain';
import { WK_NONE } from './terrain';

/**
 * Persistent continent data: what the player changed, region by region, relative to the generated terrain.
 *
 * The continent is generated from the seed and the world files, so only differences are kept: the cells whose ground
 * differs from generation (height, material, cover, moisture, magic), generated objects that were removed, objects
 * that were added or changed, water standing on ground that is dry when generated (ponds the player made; rivers,
 * lakes and pools regenerate), and the player's sources and drains. A region's difference is taken when it leaves the
 * loaded window and put back when it returns; a save holds every region's difference.
 */

/** One region's changes. Cell indices are local (y * size + x); heights are absolute metres. */
export interface RegionEdit {
  idx: Uint32Array;
  elev: Float32Array;
  mat: Uint8Array;
  cover: Uint8Array;
  coverVar: Uint8Array;
  moisture: Uint8Array;
  magic: Uint8Array;
  /** Generated objects that are gone (signature: kind, local x, local y, variant). */
  removed: string[];
  /** Objects added or changed by the player (local coordinates). */
  added: Array<{ kind: ObjKind; x: number; y: number; variant: string; props: Record<string, number> }>;
  /** Water on ground that is dry when generated: local index and depth (m). */
  waterIdx: Uint32Array;
  waterDepth: Float32Array;
  /** Player sources and drains: local index and rate (m^3/s). */
  sources: Array<[number, number]>;
  drains: Array<[number, number]>;
}

/** The loaded window as the diff needs it (window cell arrays and the generated region in each slot). */
export interface EditView {
  S: number;
  W: number;
  datum: number;
  elev: Float32Array; mat: Uint8Array; cover: Uint8Array; coverVar: Uint8Array; moisture: Uint8Array; magic: Uint8Array;
  depth: Float32Array | null;
  objects: Iterable<WorldObject>;
  sources: Map<number, number>;
  drains: Map<number, number>;
}

/** Water thinner than this on dry ground is not kept (films and puddles drying out). */
const MIN_POND = 0.02;

export const objectSig = (kind: string, x: number, y: number, variant: string) => `${kind}:${x},${y}:${variant}`;

function defaultsOf(kind: ObjKind): Record<string, number> { return OBJECT_DEFS[kind]?.defaults ?? {}; }

/** A generated object's properties as placed in the window: a `z` (absolute height) becomes relative to the datum. */
export function windowProps(p: Record<string, number> | undefined, datum: number): Record<string, number> {
  if (!p) return {};
  return p.z === undefined ? { ...p } : { ...p, z: p.z - datum };
}
function sameProps(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** Compute the difference between the window slot (gx, gy) and its generated region. Null when nothing changed. */
export function diffRegion(v: EditView, gx: number, gy: number, gen: RegionData): RegionEdit | null {
  const { S, W, datum: d } = v;
  const idx: number[] = [], elev: number[] = [], mat: number[] = [], cover: number[] = [], cvar: number[] = [], moist: number[] = [], magic: number[] = [];
  const widx: number[] = [], wdep: number[] = [];
  for (let j = 0; j < S; j++) {
    const o = (gy * S + j) * W + gx * S, s = j * S;
    for (let i = 0; i < S; i++) {
      const a = o + i, b = s + i;
      // The window holds float32(height - datum), written from the same generated value, so unchanged cells match exactly.
      if (v.elev[a] !== Math.fround(gen.elev[b] - d) || v.mat[a] !== gen.mat[b] || v.cover[a] !== gen.cover[b] || v.coverVar[a] !== gen.coverVar[b] || v.moisture[a] !== gen.moisture[b] || v.magic[a] !== 0) {
        idx.push(b); elev.push(v.elev[a] + d); mat.push(v.mat[a]); cover.push(v.cover[a]); cvar.push(v.coverVar[a]); moist.push(v.moisture[a]); magic.push(v.magic[a]);
      }
      if (v.depth && gen.waterKind[b] === WK_NONE && v.depth[a] > MIN_POND) { widx.push(b); wdep.push(v.depth[a]); }
    }
  }
  // Objects: generated ones present unchanged are matched off; the rest of the generated list was removed, the rest
  // of what is there was added (or changed).
  const pending = new Map<string, Array<Record<string, number>>>();
  for (const o of gen.objects) {
    const k = objectSig(o.kind, o.x, o.y, o.variant), list = pending.get(k) ?? [];
    list.push({ ...defaultsOf(o.kind as ObjKind), ...windowProps(o.props, d) });
    pending.set(k, list);
  }
  const added: RegionEdit['added'] = [];
  const x0 = gx * S, y0 = gy * S;
  for (const o of v.objects) {
    if (o.x < x0 || o.y < y0 || o.x >= x0 + S || o.y >= y0 + S) continue;
    const lx = o.x - x0, ly = o.y - y0, k = objectSig(o.kind, lx, ly, o.variant), list = pending.get(k);
    const at = list ? list.findIndex((p) => sameProps(o.props, p)) : -1;
    if (list && at >= 0) { list.splice(at, 1); continue; }
    added.push({ kind: o.kind, x: lx, y: ly, variant: o.variant, props: { ...o.props, ...(o.props.z !== undefined ? { z: o.props.z + d } : {}) } });
  }
  const removed: string[] = [];
  for (const [k, list] of pending) for (let q = 0; q < list.length; q++) removed.push(k);
  const local = (m: Map<number, number>) => {
    const out: Array<[number, number]> = [];
    for (const [i, rate] of m) { const x = i % W, y = (i / W) | 0; if (x >= x0 && y >= y0 && x < x0 + S && y < y0 + S) out.push([(y - y0) * S + (x - x0), rate]); }
    return out;
  };
  const sources = local(v.sources), drains = local(v.drains);
  if (!idx.length && !widx.length && !added.length && !removed.length && !sources.length && !drains.length) return null;
  return {
    idx: Uint32Array.from(idx), elev: Float32Array.from(elev), mat: Uint8Array.from(mat), cover: Uint8Array.from(cover), coverVar: Uint8Array.from(cvar),
    moisture: Uint8Array.from(moist), magic: Uint8Array.from(magic), removed, added, waterIdx: Uint32Array.from(widx), waterDepth: Float32Array.from(wdep), sources, drains,
  };
}

/** Put a region's ground changes into the window slot (gx, gy). */
export function applyGround(v: Pick<EditView, 'S' | 'W' | 'datum' | 'elev' | 'mat' | 'cover' | 'coverVar' | 'moisture' | 'magic'>, gx: number, gy: number, e: RegionEdit): void {
  const { S, W, datum: d } = v;
  for (let k = 0; k < e.idx.length; k++) {
    const b = e.idx[k], a = (gy * S + Math.floor(b / S)) * W + gx * S + (b % S);
    v.elev[a] = e.elev[k] - d; v.mat[a] = e.mat[k]; v.cover[a] = e.cover[k]; v.coverVar[a] = e.coverVar[k]; v.moisture[a] = e.moisture[k]; v.magic[a] = e.magic[k];
  }
}

/**
 * The objects a region should hold: generated ones not removed, plus those added (window coordinates). Heights (`z`)
 * are kept absolute in edits and generation, relative to `datum` in the window.
 */
export function objectsFor(gen: RegionObject[], e: RegionEdit | undefined, gx: number, gy: number, S: number, datum: number): Array<Omit<WorldObject, 'id'>> {
  const out: Array<Omit<WorldObject, 'id'>> = [];
  const gone = new Map<string, number>();
  if (e) for (const k of e.removed) gone.set(k, (gone.get(k) ?? 0) + 1);
  for (const o of gen) {
    const k = objectSig(o.kind, o.x, o.y, o.variant), n = gone.get(k) ?? 0;
    if (n > 0) { gone.set(k, n - 1); continue; }
    out.push({ kind: o.kind, x: gx * S + o.x, y: gy * S + o.y, variant: o.variant, props: windowProps(o.props, datum) });
  }
  if (e) for (const o of e.added) out.push({ kind: o.kind, x: gx * S + o.x, y: gy * S + o.y, variant: o.variant, props: windowProps(o.props, datum) });
  return out;
}

/** Add a region's ponds to a window depth grid. */
export function applyWater(depth: Float32Array, gx: number, gy: number, S: number, W: number, e: RegionEdit): void {
  for (let k = 0; k < e.waterIdx.length; k++) {
    const b = e.waterIdx[k];
    depth[(gy * S + Math.floor(b / S)) * W + gx * S + (b % S)] = e.waterDepth[k];
  }
}

// ------------------------------------------------------------------ serialisation

export interface RegionEditJSON {
  idx: string; elev: string; mat: string; cover: string; coverVar: string; moisture: string; magic: string;
  removed: string[]; added: RegionEdit['added']; waterIdx: string; waterDepth: string; sources: Array<[number, number]>; drains: Array<[number, number]>;
}

const u8 = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const enc = (a: ArrayBufferView) => bytesToB64(u8(a));
function dec<T>(s: unknown, n: number, bytes: number, make: (b: ArrayBuffer) => T): T | null {
  if (typeof s !== 'string') return null;
  const b = b64ToBytes(s);
  if (!b || b.length !== n * bytes) return null;
  const copy = new Uint8Array(b.length);
  copy.set(b);
  return make(copy.buffer);
}

export function editToJSON(e: RegionEdit): RegionEditJSON {
  return {
    idx: enc(e.idx), elev: enc(e.elev), mat: enc(e.mat), cover: enc(e.cover), coverVar: enc(e.coverVar), moisture: enc(e.moisture), magic: enc(e.magic),
    removed: e.removed, added: e.added, waterIdx: enc(e.waterIdx), waterDepth: enc(e.waterDepth), sources: e.sources, drains: e.drains,
  };
}

/** Parse one region's edit; returns null (with a reason) when it is malformed. */
export function editFromJSON(j: unknown, cells: number): RegionEdit | string {
  if (!j || typeof j !== 'object') return 'not an object';
  const o = j as Partial<RegionEditJSON>;
  const idxB = typeof o.idx === 'string' ? b64ToBytes(o.idx) : null;
  if (!idxB || idxB.length % 4) return 'cell list unreadable';
  const n = idxB.length / 4;
  const idx = dec(o.idx, n, 4, (b) => new Uint32Array(b)), elev = dec(o.elev, n, 4, (b) => new Float32Array(b));
  const mat = dec(o.mat, n, 1, (b) => new Uint8Array(b)), cover = dec(o.cover, n, 1, (b) => new Uint8Array(b)), coverVar = dec(o.coverVar, n, 1, (b) => new Uint8Array(b));
  const moisture = dec(o.moisture, n, 1, (b) => new Uint8Array(b)), magic = dec(o.magic, n, 1, (b) => new Uint8Array(b));
  if (!idx || !elev || !mat || !cover || !coverVar || !moisture || !magic) return 'cell values unreadable';
  for (const i of idx) if (i >= cells) return 'cell index out of range';
  for (const v of elev) if (!Number.isFinite(v)) return 'height not finite';
  const wB = typeof o.waterIdx === 'string' ? b64ToBytes(o.waterIdx) : null;
  if (!wB || wB.length % 4) return 'water list unreadable';
  const wn = wB.length / 4;
  const waterIdx = dec(o.waterIdx, wn, 4, (b) => new Uint32Array(b)), waterDepth = dec(o.waterDepth, wn, 4, (b) => new Float32Array(b));
  if (!waterIdx || !waterDepth) return 'water values unreadable';
  for (const i of waterIdx) if (i >= cells) return 'water index out of range';
  const pairs = (p: unknown) => Array.isArray(p) && p.every((q) => Array.isArray(q) && q.length === 2 && Number.isInteger(q[0]) && q[0] >= 0 && q[0] < cells && Number.isFinite(q[1]) && q[1] >= 0);
  if (!pairs(o.sources ?? []) || !pairs(o.drains ?? [])) return 'sources or drains unreadable';
  const removed = Array.isArray(o.removed) ? o.removed.filter((s): s is string => typeof s === 'string') : [];
  const size = Math.round(Math.sqrt(cells));
  const added = Array.isArray(o.added) ? o.added.filter((a) => a && typeof a === 'object' && a.kind in OBJECT_DEFS && Number.isInteger(a.x) && Number.isInteger(a.y) && a.x >= 0 && a.y >= 0 && a.x < size && a.y < size && typeof a.variant === 'string') : [];
  return { idx, elev, mat, cover, coverVar, moisture, magic, removed, added, waterIdx, waterDepth, sources: (o.sources ?? []) as Array<[number, number]>, drains: (o.drains ?? []) as Array<[number, number]> };
}

/** All regions' edits, keyed "rx,ry". */
export class ContinentEdits {
  readonly regions = new Map<string, RegionEdit>();
  get size(): number { return this.regions.size; }
  get(rx: number, ry: number): RegionEdit | undefined { return this.regions.get(`${rx},${ry}`); }
  set(rx: number, ry: number, e: RegionEdit | null): void { if (e) this.regions.set(`${rx},${ry}`, e); else this.regions.delete(`${rx},${ry}`); }
  /** Changed cells across all regions (a measure of save size). */
  cellCount(): number { let n = 0; for (const e of this.regions.values()) n += e.idx.length; return n; }
  clone(): ContinentEdits { const c = new ContinentEdits(); for (const [k, v] of this.regions) c.regions.set(k, v); return c; }
  toJSON(): Record<string, RegionEditJSON> { const o: Record<string, RegionEditJSON> = {}; for (const [k, v] of this.regions) o[k] = editToJSON(v); return o; }
  static fromJSON(j: unknown, cells: number, problems: string[] = []): ContinentEdits {
    const c = new ContinentEdits();
    if (!j || typeof j !== 'object') return c;
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (!/^-?\d+,-?\d+$/.test(k)) { problems.push(`Region "${k}" has a bad key and was skipped.`); continue; }
      const e = editFromJSON(v, cells);
      if (typeof e === 'string') problems.push(`Region ${k}: ${e}; its changes were skipped.`);
      else c.regions.set(k, e);
    }
    return c;
  }
}
