import type { EnvState } from '../engine/env/Environment';
import type { MapPt, WorldData } from './schema';
import { ContinentEdits, type RegionEditJSON } from './edits';

/**
 * Continent saves: where the player is, the camera zoom, the weather and time, and every region's changes (see
 * edits.ts). Kept apart from Valley saves (their own storage and format), so neither can load the other by mistake.
 */
export const CONTINENT_FORMAT = 'lumenwild-continent';
export const CONTINENT_SAVE_VERSION = 1;
/** Bumped whenever generation changes what a region contains (stored changes are measured against it). */
export const GENERATOR_VERSION = 'terrain-2c+villages-1+edits-1';

export interface ContinentSave {
  format: typeof CONTINENT_FORMAT;
  version: number;
  name: string;
  /** World seed (for the slot list). */
  seed: number;
  savedAt: string;
  /** World files and generator this save was made with (a mismatch is reported when loading). */
  fingerprint: string;
  /** Map point at the centre of the view. */
  at: MapPt;
  camera: { zoom: number };
  env: EnvState;
  edits: Record<string, RegionEditJSON>;
  /** For the slot list and checks. */
  stats: { regions: number; cells: number; objects: number };
}

/** FNV-1a hash (hex) of the world files and the generator version. */
export function worldFingerprint(data: WorldData): string {
  const text = JSON.stringify(data) + '|' + GENERATOR_VERSION;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export function buildContinentSave(p: { name: string; seed: number; data: WorldData; at: MapPt; zoom: number; env: EnvState; edits: ContinentEdits }): ContinentSave {
  let objects = 0;
  for (const e of p.edits.regions.values()) objects += e.added.length + e.removed.length;
  return {
    format: CONTINENT_FORMAT, version: CONTINENT_SAVE_VERSION, name: p.name, seed: p.seed, savedAt: new Date().toISOString(),
    fingerprint: worldFingerprint(p.data), at: [p.at[0], p.at[1]], camera: { zoom: p.zoom }, env: { ...p.env },
    edits: p.edits.toJSON(), stats: { regions: p.edits.size, cells: p.edits.cellCount(), objects },
  };
}

export interface ContinentValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  save?: ContinentSave;
  edits?: ContinentEdits;
}

/** Check a continent save (object or JSON text) against this world; edits are parsed and checked region by region. */
export function validateContinentSave(input: unknown, data: WorldData, regionCells: number): ContinentValidation {
  const errors: string[] = [], warnings: string[] = [];
  let d: unknown = input;
  if (typeof input === 'string') { try { d = JSON.parse(input); } catch { return { ok: false, errors: ['Not valid JSON.'], warnings }; } }
  if (!d || typeof d !== 'object') return { ok: false, errors: ['Not a save file.'], warnings };
  const s = d as Partial<ContinentSave> & Record<string, unknown>;
  if (s.format !== CONTINENT_FORMAT) {
    errors.push(s.format === 'lumenwild' || 'terrain' in s ? 'This is a Valley save; open it in the Valley.' : 'Not a continent save.');
    return { ok: false, errors, warnings };
  }
  if (typeof s.version !== 'number' || s.version < 1) errors.push('Missing or invalid "version".');
  else if (s.version > CONTINENT_SAVE_VERSION) errors.push(`Saved by a newer version (${s.version}); this app reads version ${CONTINENT_SAVE_VERSION}.`);
  const max = data.coordinates.map.max;
  const at = Array.isArray(s.at) && s.at.length === 2 && s.at.every((v) => typeof v === 'number' && Number.isFinite(v)) ? ([Math.min(max - 1, Math.max(0, s.at[0])), Math.min(max - 1, Math.max(0, s.at[1]))] as MapPt) : null;
  if (!at) errors.push('Missing or invalid position ("at").');
  if (errors.length) return { ok: false, errors, warnings };
  if (s.fingerprint !== worldFingerprint(data)) warnings.push('This save was made with a different version of the world or its generator. Your changes are applied where they were made; things that were generated differently may not line up.');
  const edits = ContinentEdits.fromJSON(s.edits, regionCells * regionCells, warnings);
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const e = (s.env ?? {}) as unknown as Record<string, unknown>;
  const env: EnvState = {
    time: num(e.time, 0, 23.999, 10.5), cycle: e.cycle !== false, dayLength: num(e.dayLength, 10, 7200, 480),
    rain: num(e.rain, 0, 1, 0), fog: num(e.fog, 0, 1, 0), wind: num(e.wind, 0, 1, 0.35), windDir: e.windDir === -1 ? -1 : 1,
  };
  const save: ContinentSave = {
    format: CONTINENT_FORMAT, version: CONTINENT_SAVE_VERSION, name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 60) : 'Continent',
    seed: typeof s.seed === 'number' ? s.seed : data.world.seed, savedAt: typeof s.savedAt === 'string' ? s.savedAt : new Date(0).toISOString(),
    fingerprint: String(s.fingerprint ?? ''), at: at!, camera: { zoom: Math.round(num((s.camera as { zoom?: unknown } | undefined)?.zoom, 0, 13, 4)) }, env,
    edits: (s.edits ?? {}) as Record<string, RegionEditJSON>, stats: { regions: edits.size, cells: edits.cellCount(), objects: 0 },
  };
  return { ok: true, errors, warnings, save, edits };
}
