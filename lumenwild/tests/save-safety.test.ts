import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../server/WorldServer';
import { SaveLoadError, listBackups, decodeSave, SERVER_SAVE_VERSION } from '../server/saveFile';
import { migrateHero, migrateLife, checkLife, HERO_VERSION, LIFE_VERSION } from '../src/world/migrations';
import { validateContinentSave } from '../src/world/continentSave';
import { WORLD } from '../src/world/data';
import { heroToJSON, newHero } from '../src/world/rpg/hero';

/**
 * Saves cannot be lost: atomic writes with a checksum, rolling backups, and an unreadable save that is never
 * replaced by a new world (the server refuses to start and says how to restore). Versions of the character and
 * living-world payloads migrate forward; newer ones are refused, never half-loaded.
 */
const dir = () => mkdtempSync(join(tmpdir(), 'lw-safety-'));
const conn = () => ({ open: true, send() { return true; }, close() {}, onmessage: null, onclose: null, heartbeat() {} });
/** A server with two players and something to lose. */
function populated(file: string, opts = {}) {
  const s = new WorldServer({ port: 0, dataFile: file, ...opts });
  const a = s['hello'](conn() as never, 'Ada'), b = s['hello'](conn() as never, 'Bram');
  s.sim.players.get(a.id)!.hero.coins = 999;
  void b;
  return s;
}

describe('server saves: atomic, checksummed, backed up, never overwritten when unreadable', { timeout: 120_000 }, () => {
  it('writes a version-3 envelope with a checksum, atomically; reads it back', () => {
    const file = join(dir(), 'world.json');
    const s = populated(file);
    s.save();
    const j = JSON.parse(readFileSync(file, 'utf8'));
    expect(j.format).toBe('lumenwild-server');
    expect(j.version).toBe(SERVER_SAVE_VERSION);
    expect(j.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const s2 = new WorldServer({ port: 0, dataFile: file });
    expect(s2.sessions.size).toBe(2);
    expect([...s2.sessions.values()].find((q) => q.name === 'Ada')!.player.hero.coins).toBe(999);
  });

  it.each([
    ['truncated', (t: string) => t.slice(0, Math.floor(t.length / 2))],
    ['edited by hand (checksum)', (t: string) => t.replace('"coins":999', '"coins":1000000')],
    ['empty', () => ''],
    ['not a save', () => '{"hello":"world"}'],
  ])('an unreadable save (%s) is left untouched, copied aside, and the server refuses to start', (_name, damage) => {
    const file = join(dir(), 'world.json');
    const s = populated(file);
    s.save(); s.save(); // the second save backs up the first
    const bad = damage(readFileSync(file, 'utf8'));
    writeFileSync(file, bad);
    let err: unknown;
    try { new WorldServer({ port: 0, dataFile: file }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SaveLoadError);
    expect((err as SaveLoadError).message).toMatch(/NOT been changed/);
    expect(readFileSync(file, 'utf8')).toBe(bad); // byte for byte as it was
    expect((err as SaveLoadError).corruptCopy && readFileSync((err as SaveLoadError).corruptCopy!, 'utf8')).toBe(bad);
    expect((err as SaveLoadError).backups.length).toBeGreaterThan(0); // and says where the backups are
  });

  it('keeps rolling and daily backups (pruned), and restores the latest one on request', () => {
    const d = dir(), file = join(d, 'world.json');
    const s = populated(file, { backups: { backupEverySec: 0, keepRolling: 3, keepDaily: 2 } });
    for (let k = 0; k < 6; k++) { s.sim.players.get([...s.sessions.keys()][0])!.hero.coins = 1000 + k; s.save(); }
    const backups = listBackups(file);
    expect(backups.filter((b) => b.includes('.rolling-')).length).toBeLessThanOrEqual(3);
    expect(backups.filter((b) => b.includes('.daily-')).length).toBe(1);
    // Corrupt the save; restore from the newest backup (the previous save).
    writeFileSync(file, '{ broken');
    expect(() => new WorldServer({ port: 0, dataFile: file })).toThrow(SaveLoadError);
    const r = new WorldServer({ port: 0, dataFile: file, restore: 'latest' });
    expect(r.sessions.size).toBe(2);
    const coins = [...r.sessions.values()].find((q) => q.name === 'Ada')!.player.hero.coins;
    expect(coins).toBeGreaterThanOrEqual(1000);
    expect(readdirSync(d).some((f) => f.startsWith('world.json.replaced-'))).toBe(true); // the broken file is kept
  });

  it('a leftover temporary file from a crash mid-write does not matter', () => {
    const file = join(dir(), 'world.json');
    populated(file).save();
    writeFileSync(`${file}.tmp`, '{"half":');
    expect(new WorldServer({ port: 0, dataFile: file }).sessions.size).toBe(2);
  });

  it('background saves never overlap with the final save on shutdown', async () => {
    const file = join(dir(), 'world.json');
    const s = populated(file);
    const p = s.saveInBackground();
    await s.stop();
    await p;
    expect('data' in decodeSave(readFileSync(file, 'utf8'))).toBe(true);
  });

  it('a save holding a character from a newer build is refused, not half-loaded', () => {
    const file = join(dir(), 'world.json');
    populated(file).save();
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.data.players[0].hero.v = HERO_VERSION + 1;
    // Re-sign it so only the version is wrong.
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    j.checksum = createHash('sha256').update(JSON.stringify(j.data)).digest('hex');
    writeFileSync(file, JSON.stringify(j));
    expect(() => new WorldServer({ port: 0, dataFile: file })).toThrow(/newer version/);
  });
});

describe('character and living-world versions', () => {
  it('migrate older payloads forward and refuse newer or unreadable ones', () => {
    const h = heroToJSON(newHero([0, 0], 'Home'));
    expect(h.v).toBe(HERO_VERSION);
    const { v: _v, ...old } = h; void _v;
    const m = migrateHero(old);
    expect(m.ok && m.from === 0 && m.to === HERO_VERSION && m.data.v === HERO_VERSION).toBe(true);
    expect(migrateHero({ ...h, v: HERO_VERSION + 3 }).ok).toBe(false);
    expect(migrateHero({ ...h, v: 'x' }).ok).toBe(false);
    expect(migrateLife({ players: [] })).toMatchObject({ ok: true, from: 0, to: LIFE_VERSION });
    expect(checkLife({ v: LIFE_VERSION + 1 })[0]).toMatch(/newer/);
    expect(checkLife({ v: LIFE_VERSION, players: [{ hero: { ...h, v: 99 } }] })[0]).toMatch(/newer/);
  });

  it('a continent save whose living world is from a newer build is refused with a clear message', () => {
    const save = { format: 'lumenwild-continent', version: 1, at: [500, 510], edits: {}, life: { v: LIFE_VERSION + 1, players: [] } };
    const v = validateContinentSave(save, WORLD, 256);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/newer version/);
  });
});
