import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { open as openAsync, rename as renameAsync, readFile as readAsync } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { checkLife } from '../src/world/migrations';

/**
 * The world server's save file, made safe:
 * - **Envelope (version 3):** `{format, version, savedAt, checksum, data}`. The checksum is SHA-256 of
 *   `JSON.stringify(data)`. Version 1 and 2 files (no envelope) are still read; `data` is that file.
 * - **Atomic writes:**
 *   1. write a temporary file;
 *   2. flush it to disk;
 *   3. read it back and verify it;
 *   4. only then rename it over the save.
 *   A crash at any point leaves either the old save or the new one, never a torn file.
 * - **Rolling backups:**
 *   - before a save replaces the file, the previous file is copied to `backups/` (at most every `backupEverySec`);
 *   - plus the first save of each day;
 *   - the newest `keepRolling` and `keepDaily` are kept.
 * - **Fail-safe loading:** a file that cannot be read, fails its checksum or does not validate is **never**
 *   replaced by a fresh world. Loading throws a SaveLoadError that leaves the file untouched, copies it beside
 *   itself as `.corrupt-<time>` for diagnosis, and lists the backups to restore from (`--restore-latest` or
 *   `--restore <file>`).
 */

export const SERVER_FORMAT = 'lumenwild-server';
export const SERVER_SAVE_VERSION = 3;

export interface BackupOptions { keepRolling?: number; keepDaily?: number; backupEverySec?: number }
type Data = Record<string, unknown>;

export class SaveLoadError extends Error {
  constructor(message: string, readonly file: string, readonly reason: string, readonly backups: string[], readonly corruptCopy: string | null) { super(message); this.name = 'SaveLoadError'; }
}

const checksum = (body: string) => createHash('sha256').update(body).digest('hex');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export function encodeSave(data: Data, savedAt = new Date()): string {
  const body = JSON.stringify(data);
  return `{"format":"${SERVER_FORMAT}","version":${SERVER_SAVE_VERSION},"savedAt":"${savedAt.toISOString()}","checksum":"${checksum(body)}","data":${body}}`;
}

/** Validate the content of a save (any version), returning the data part or the reason it cannot be used. */
export function decodeSave(text: string): { data: Data; version: number } | { error: string } {
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { return { error: `not valid JSON (${(e as Error).message})` }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'not an object' };
  const o = j as Data;
  let data: Data, version: number;
  if (o.format !== undefined) {
    if (o.format !== SERVER_FORMAT) return { error: `not a Lumenwild server save (format ${JSON.stringify(o.format)})` };
    version = Number(o.version);
    if (!Number.isInteger(version) || version < 3) return { error: `bad version ${JSON.stringify(o.version)}` };
    if (version > SERVER_SAVE_VERSION) return { error: `saved by a newer server (version ${version}; this one reads up to ${SERVER_SAVE_VERSION})` };
    if (!o.data || typeof o.data !== 'object') return { error: 'no data' };
    if (typeof o.checksum !== 'string' || checksum(JSON.stringify(o.data)) !== o.checksum) return { error: 'checksum mismatch (the file was changed or damaged)' };
    data = o.data as Data;
  } else {
    version = Number(o.version);
    if (version !== 1 && version !== 2) return { error: `unknown version ${JSON.stringify(o.version)}` };
    data = o;
  }
  // Shape: sessions and players are lists, ids and tokens are strings, ids unique; edits an object; life readable.
  if (!Array.isArray(data.sessions)) return { error: 'sessions missing' };
  const ids = new Set<string>();
  for (const s of data.sessions as Data[]) {
    if (!s || typeof s.id !== 'string' || typeof s.token !== 'string' || typeof s.name !== 'string') return { error: 'a session is unreadable' };
    if (ids.has(s.id)) return { error: `duplicate session ${s.id}` };
    ids.add(s.id);
  }
  if (data.players !== undefined && !Array.isArray(data.players)) return { error: 'players unreadable' };
  for (const p of (data.players ?? []) as Data[]) if (!p || typeof p.id !== 'string' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return { error: 'a player is unreadable' };
  if (data.edits !== undefined && (typeof data.edits !== 'object' || Array.isArray(data.edits))) return { error: 'edits unreadable' };
  const lifeProblems = checkLife(data.life);
  for (const p of (data.players ?? []) as Data[]) if (p.hero) lifeProblems.push(...checkLife({ players: [{ hero: p.hero }] }));
  if (lifeProblems.length) return { error: lifeProblems.join('; ') };
  return { data, version };
}

/** Backups of a save file, newest first. */
export function listBackups(file: string): string[] {
  const dir = join(dirname(file), 'backups'), base = basename(file);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && f.endsWith('.json')).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || (a < b ? 1 : -1));
}

/** Read a save. Returns null when there is none yet (a new world); throws SaveLoadError when it cannot be used. */
export function readSave(file: string): { data: Data; version: number } | null {
  if (!existsSync(file)) return null;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return fail(file, `cannot be read (${(e as Error).message})`); }
  const r = decodeSave(text);
  if ('error' in r) return fail(file, r.error);
  return r;
}

function fail(file: string, reason: string): never {
  let copy: string | null = `${file}.corrupt-${stamp()}`;
  try { copyFileSync(file, copy); } catch { copy = null; }
  const backups = listBackups(file);
  const how = backups.length ? `Restore a backup with --restore-latest (newest: ${basename(backups[0])}) or --restore <file>.` : 'There are no backups; fix or move the file by hand.';
  throw new SaveLoadError(`The world save ${file} ${reason}. It has NOT been changed and the server will not start a new world over it.${copy ? ` A copy is at ${copy}.` : ''} ${how}`, file, reason, backups, copy);
}

/** Read a backup to restore (validated the same way). */
export function readBackup(path: string): { data: Data; version: number } {
  const r = decodeSave(readFileSync(path, 'utf8'));
  if ('error' in r) throw new SaveLoadError(`The backup ${path} cannot be used: ${r.error}.`, path, r.error, [], null);
  return r;
}

/** Copy the current save into backups/ if it is time (and once per day); prune old ones. */
function rotate(file: string, opts: BackupOptions, now: Date): void {
  if (!existsSync(file)) return;
  const dir = join(dirname(file), 'backups'), base = basename(file);
  mkdirSync(dir, { recursive: true });
  const all = listBackups(file), rolling = all.filter((f) => f.includes('.rolling-')), daily = all.filter((f) => f.includes('.daily-'));
  const every = (opts.backupEverySec ?? 300) * 1000;
  if (!rolling.length || now.getTime() - statSync(rolling[0]).mtimeMs >= every) copyFileSync(file, join(dir, `${base}.rolling-${stamp(now)}.json`));
  const day = stamp(now).slice(0, 8);
  if (!daily.some((f) => f.includes(`.daily-${day}`))) copyFileSync(file, join(dir, `${base}.daily-${day}.json`));
  const prune = (list: string[], keep: number) => { for (const f of list.slice(keep)) try { unlinkSync(f); } catch { /* already gone */ } };
  prune(listBackups(file).filter((f) => f.includes('.rolling-')), opts.keepRolling ?? 10);
  prune(listBackups(file).filter((f) => f.includes('.daily-')), opts.keepDaily ?? 7);
}

/** Write a save atomically (synchronous: shutdown and tests). */
export function writeSave(file: string, data: Data, opts: BackupOptions = {}): { bytes: number } {
  mkdirSync(dirname(file), { recursive: true });
  const text = encodeSave(data), tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  const check = decodeSave(readFileSync(tmp, 'utf8'));
  if ('error' in check) throw new Error(`The save just written does not verify (${check.error}); the previous save is kept.`);
  rotate(file, opts, new Date());
  renameSync(tmp, file);
  return { bytes: text.length };
}

/** Write a save atomically without blocking the server loop (the serialised text is prepared by the caller). */
export async function writeSaveAsync(file: string, data: Data, opts: BackupOptions = {}): Promise<{ bytes: number }> {
  mkdirSync(dirname(file), { recursive: true });
  const text = encodeSave(data), tmp = `${file}.tmp`;
  const fh = await openAsync(tmp, 'w');
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  const check = decodeSave(await readAsync(tmp, 'utf8'));
  if ('error' in check) throw new Error(`The save just written does not verify (${check.error}); the previous save is kept.`);
  rotate(file, opts, new Date());
  await renameAsync(tmp, file);
  return { bytes: text.length };
}
