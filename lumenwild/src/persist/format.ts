import { OBJ_KINDS, OBJECT_DEFS, type WorldObject } from '../engine/objects/defs';
import type { EnvState } from '../engine/env/Environment';

/**
 * Lumenwild save format (JSON). Grids are little-endian typed arrays in base64; everything else is plain JSON.
 * The seed is kept, so a world can be regenerated from it, but a save restores the edited state exactly.
 */
export const SAVE_FORMAT = 'lumenwild-world';
export const SAVE_VERSION = 1;

export interface SaveData {
  format: typeof SAVE_FORMAT;
  version: number;
  name: string;
  seed: number;
  w: number;
  h: number;
  savedAt: string;
  terrain: { elev: string; mat: string; cover: string; coverVar: string; moisture: string; magic: string };
  water: { depth: string };
  objects: WorldObject[];
  sources: Array<[number, number]>;
  drains: Array<[number, number]>;
  env: EnvState;
  camera: { x: number; y: number; zoom: number };
  home: [number, number] | null;
}

/** Decoded save, ready to apply. */
export interface LoadedWorld {
  name: string;
  seed: number;
  w: number;
  h: number;
  elev: Float32Array;
  mat: Uint8Array;
  cover: Uint8Array;
  coverVar: Uint8Array;
  moisture: Uint8Array;
  magic: Uint8Array;
  depth: Float32Array;
  objects: WorldObject[];
  sources: Array<[number, number]>;
  drains: Array<[number, number]>;
  env: EnvState;
  camera: { x: number; y: number; zoom: number };
  home: [number, number] | null;
}

// ------------------------------------------------------------------ base64 <-> typed arrays (no Buffer: browser + node)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REV = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) REV[B64.charCodeAt(i)] = i;

export function bytesToB64(u8: Uint8Array): string {
  let out = '';
  const parts: string[] = [];
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i], b = i + 1 < u8.length ? u8[i + 1] : 0, c = i + 2 < u8.length ? u8[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u8.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < u8.length ? B64[n & 63] : '=');
    if (out.length > 8192) { parts.push(out); out = ''; }
  }
  parts.push(out);
  return parts.join('');
}

export function b64ToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c0 = REV[s.charCodeAt(i)] ?? -1, c1 = REV[s.charCodeAt(i + 1)] ?? -1;
    const c2 = s[i + 2] === '=' ? 0 : REV[s.charCodeAt(i + 2)] ?? -1, c3 = s[i + 3] === '=' ? 0 : REV[s.charCodeAt(i + 3)] ?? -1;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

const f32ToB64 = (a: Float32Array) => bytesToB64(new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)));
function b64ToF32(s: string, n: number): Float32Array | null {
  const b = b64ToBytes(s);
  if (!b || b.length !== n * 4) return null;
  return new Float32Array(b.buffer, b.byteOffset, n).slice();
}
function b64ToU8(s: string, n: number): Uint8Array | null {
  const b = b64ToBytes(s);
  return b && b.length === n ? b : null;
}

// ------------------------------------------------------------------ build
export interface SaveSource {
  name: string; seed: number; w: number; h: number;
  elev: Float32Array; mat: Uint8Array; cover: Uint8Array; coverVar: Uint8Array; moisture: Uint8Array; magic: Uint8Array;
  depth: Float32Array;
  objects: WorldObject[];
  sources: Map<number, number>; drains: Map<number, number>;
  env: EnvState;
  camera: { x: number; y: number; zoom: number };
  home: [number, number] | null;
}

export function buildSave(s: SaveSource): SaveData {
  return {
    format: SAVE_FORMAT, version: SAVE_VERSION, name: s.name, seed: s.seed, w: s.w, h: s.h, savedAt: new Date().toISOString(),
    terrain: {
      elev: f32ToB64(Float32Array.from(s.elev)), mat: bytesToB64(Uint8Array.from(s.mat)), cover: bytesToB64(Uint8Array.from(s.cover)),
      coverVar: bytesToB64(Uint8Array.from(s.coverVar)), moisture: bytesToB64(Uint8Array.from(s.moisture)), magic: bytesToB64(Uint8Array.from(s.magic)),
    },
    water: { depth: f32ToB64(Float32Array.from(s.depth)) },
    objects: s.objects.map((o) => ({ ...o, props: { ...o.props } })),
    sources: [...s.sources], drains: [...s.drains],
    env: { ...s.env }, camera: { ...s.camera }, home: s.home,
  };
}

// ------------------------------------------------------------------ validate + decode
export interface Validation { ok: boolean; errors: string[]; warnings: string[]; world?: LoadedWorld }

const MAX_SIDE = 1024;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Check and decode a save (parsed JSON or a JSON string). Never throws; reports every problem it finds. */
export function validateSave(input: unknown, expect?: { w: number; h: number }): Validation {
  const errors: string[] = [], warnings: string[] = [];
  let d: Record<string, unknown>;
  if (typeof input === 'string') {
    try { d = JSON.parse(input); } catch (e) { return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings }; }
  } else d = input as Record<string, unknown>;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['The file does not contain a world object.'], warnings };
  if (d.format !== SAVE_FORMAT) return { ok: false, errors: ['This is not a Lumenwild world file (missing or wrong "format").'], warnings };
  if (!isNum(d.version) || d.version < 1) errors.push('Missing or invalid "version".');
  else if (d.version > SAVE_VERSION) errors.push(`Saved by a newer version (${d.version}); this app reads version ${SAVE_VERSION}.`);
  const w = d.w, h = d.h;
  if (!isNum(w) || !isNum(h) || !Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > MAX_SIDE || h > MAX_SIDE) {
    errors.push(`Invalid world size ${String(w)} x ${String(h)} (16..${MAX_SIDE}).`);
    return { ok: false, errors, warnings };
  }
  if (expect && (w !== expect.w || h !== expect.h)) errors.push(`World size ${w} x ${h} does not match this app's ${expect.w} x ${expect.h}.`);
  if (!isNum(d.seed)) errors.push('Missing or invalid "seed".');
  const n = w * h;
  const t = (d.terrain ?? {}) as Record<string, string>;
  const elev = b64ToF32(t.elev, n), mat = b64ToU8(t.mat, n), cover = b64ToU8(t.cover, n), coverVar = b64ToU8(t.coverVar, n);
  const moisture = b64ToU8(t.moisture, n), magic = b64ToU8(t.magic, n);
  const depth = b64ToF32(((d.water ?? {}) as Record<string, string>).depth, n);
  for (const [k, v] of Object.entries({ elev, mat, cover, coverVar, moisture, magic, depth })) if (!v) errors.push(`Grid "${k}" is missing or has the wrong size.`);
  if (elev) {
    let bad = 0;
    for (let i = 0; i < n; i++) if (!Number.isFinite(elev[i]) || elev[i] < -100 || elev[i] > 300) bad++;
    if (bad) errors.push(`Elevation has ${bad} invalid values.`);
  }
  if (mat) { let bad = 0; for (let i = 0; i < n; i++) if (mat[i] > 10) bad++; if (bad) errors.push(`Material grid has ${bad} unknown materials.`); }
  if (cover) { let bad = 0; for (let i = 0; i < n; i++) if (cover[i] > 8) bad++; if (bad) errors.push(`Cover grid has ${bad} unknown values.`); }
  if (depth) {
    let bad = 0;
    for (let i = 0; i < n; i++) if (!Number.isFinite(depth[i]) || depth[i] < 0 || depth[i] > 100) { bad++; depth[i] = 0; }
    if (bad) warnings.push(`${bad} invalid water depths were reset to 0.`);
  }
  // Objects: validate shape here; placement conflicts are reported by the object store when loading.
  const objects: WorldObject[] = [];
  if (!Array.isArray(d.objects)) errors.push('Missing "objects" list.');
  else {
    let skipped = 0;
    for (const o of d.objects as Array<Record<string, unknown>>) {
      const ok = o && typeof o === 'object' && (OBJ_KINDS as readonly string[]).includes(o.kind as string) && isNum(o.id) && isNum(o.x) && isNum(o.y)
        && Number.isInteger(o.x) && Number.isInteger(o.y) && o.x >= 0 && o.y >= 0 && o.x < w && o.y < h && typeof o.variant === 'string'
        && o.props && typeof o.props === 'object' && Object.values(o.props as object).every(isNum);
      if (!ok) { skipped++; continue; }
      const def = OBJECT_DEFS[o.kind as WorldObject['kind']];
      const variant = def.variants.includes(o.variant as string) ? (o.variant as string) : def.variants[0];
      if (variant !== o.variant) warnings.push(`Unknown ${o.kind} type "${String(o.variant)}" replaced by "${variant}".`);
      objects.push({ id: o.id as number, kind: o.kind as WorldObject['kind'], x: o.x as number, y: o.y as number, variant, props: { ...(o.props as Record<string, number>) } });
    }
    if (skipped) warnings.push(`${skipped} invalid objects were skipped.`);
  }
  const pairs = (v: unknown, label: string): Array<[number, number]> => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { errors.push(`"${label}" must be a list.`); return []; }
    const out: Array<[number, number]> = [];
    for (const p of v) {
      if (Array.isArray(p) && isNum(p[0]) && isNum(p[1]) && Number.isInteger(p[0]) && p[0] >= 0 && p[0] < n && p[1] > 0 && p[1] <= 100) out.push([p[0], p[1]]);
      else warnings.push(`An invalid ${label.slice(0, -1)} was skipped.`);
    }
    return out;
  };
  const sources = pairs(d.sources, 'sources'), drains = pairs(d.drains, 'drains');
  const e = (d.env ?? {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, def: number) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const env: EnvState = {
    time: num(e.time, 0, 23.999, 10.5), cycle: e.cycle !== false, dayLength: num(e.dayLength, 10, 7200, 480),
    rain: num(e.rain, 0, 1, 0), fog: num(e.fog, 0, 1, 0), wind: num(e.wind, 0, 1, 0.35), windDir: e.windDir === -1 ? -1 : 1,
  };
  const c = (d.camera ?? {}) as Record<string, unknown>;
  const camera = { x: num(c.x, -64, w + 64, w / 2), y: num(c.y, -128, h + 64, h / 2), zoom: Math.round(num(c.zoom, 0, 13, 4)) };
  const home = Array.isArray(d.home) && isNum(d.home[0]) && isNum(d.home[1]) ? [d.home[0], d.home[1]] as [number, number] : null;
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 60) : 'Imported world';
  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true, errors, warnings,
    world: { name, seed: d.seed as number, w, h, elev: elev!, mat: mat!, cover: cover!, coverVar: coverVar!, moisture: moisture!, magic: magic!, depth: depth!, objects, sources, drains, env, camera, home },
  };
}
