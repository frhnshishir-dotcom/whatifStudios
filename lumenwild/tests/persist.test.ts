import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { bytesToB64, b64ToBytes, validateSave, SAVE_FORMAT, type SaveData } from '../src/persist/format';
import { SlotStore } from '../src/persist/storage';
import { Engine } from '../src/engine/Engine';
import { World } from '../src/engine/world/World';
import { WaterSystem } from '../src/engine/water/WaterSystem';

function makeEngine(seed: number): Engine {
  const e = new Engine(new World(256, 256));
  e.attachWater(new WaterSystem(e.world, { useWorker: false }));
  e.regenerate(seed);
  return e;
}

// Every test in this group generates one to three full 256 x 256 Valley worlds: about 1.15 s each here, 70 % of it the
// water warm-up, which is part of the protected Valley generation (it sets the ripples the golden images show), so it
// is not shortened for tests. Measured for "worlds keep their dragon" (three worlds): 3.6-4.2 s alone (10 runs),
// 3.7 s within the suite here, 5.4 s within the suite on the GitHub runner (CI run 2, over Vitest's 5 s default).
// 15 s is about three times the slowest measurement. The rest of the suite keeps the 5 s default.
describe('save format', { timeout: 15_000 }, () => {
  it('base64 round-trips every length and byte value', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 1000, 3001]) {
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = (i * 37 + 11) & 255;
      const s = bytesToB64(a);
      expect(s.length % 4).toBe(0);
      expect(b64ToBytes(s)).toEqual(a);
    }
    expect(b64ToBytes('abc')).toBeNull();
    expect(b64ToBytes('ab$=')).toBeNull();
  });

  it('a generated and edited world survives save -> JSON -> validate -> load exactly (seed preserved)', () => {
    const a = makeEngine(42);
    for (let k = 0; k < 120; k++) a.water!.step(1 / 60);
    // Edits: raise terrain, place a cottage and a spring, change the weather.
    const ed = a.editor;
    ed.begin('raise', 120 * 256 + 60); for (let k = 0; k < 20; k++) ed.tick(1 / 60); ed.end();
    ed.options.variants.rock = 'big';
    ed.begin('rock', 150 * 256 + 200); ed.end();
    ed.begin('source', 100 * 256 + 30); ed.end();
    a.env.set({ time: 21.5, rain: 0.6, fog: 0.2, wind: 0.8, windDir: -1, cycle: false });
    a.world.name = 'My vale';
    const json = JSON.stringify(a.snapshot());
    const v = validateSave(json, { w: 256, h: 256 });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    const b = makeEngine(7);
    expect(b.applyWorld(v.world!)).toEqual([]);
    expect(b.world.seed).toBe(42);
    expect(b.world.name).toBe('My vale');
    expect(b.world.elev).toEqual(a.world.elev);
    expect(b.world.mat).toEqual(a.world.mat);
    expect(b.world.cover).toEqual(a.world.cover);
    expect(b.world.solid).toEqual(a.world.solid);
    expect(b.objects.toJSON()).toEqual(a.objects.toJSON());
    expect([...b.editor.sources]).toEqual([...a.editor.sources]);
    expect(b.water!.view.depth).toEqual(a.water!.view.depth);
    expect(b.env.state()).toMatchObject({ rain: 0.6, fog: 0.2, wind: 0.8, windDir: -1, cycle: false });
    expect(b.env.time).toBeCloseTo(21.5, 5);
    expect(b.editor.history.canUndo).toBe(false);
    // The loaded world keeps simulating: its sources feed water.
    expect(b.water!.view.source[100 * 256 + 30]).toBeGreaterThan(0);
  });

  it('rejects files that are not worlds, and reports every problem', () => {
    expect(validateSave('{nope').errors[0]).toMatch(/Not valid JSON/);
    expect(validateSave({ hello: 1 }).errors[0]).toMatch(/not a Lumenwild world/);
    expect(validateSave([1, 2]).ok).toBe(false);
    expect(validateSave(null).ok).toBe(false);
    const good = makeEngine(3).snapshot();
    const mut = (f: (d: SaveData) => void) => { const d = JSON.parse(JSON.stringify(good)); f(d); return validateSave(d, { w: 256, h: 256 }); };
    expect(mut((d) => { d.version = 99; }).errors.join()).toMatch(/newer version/);
    expect(mut((d) => { d.w = 5000; }).errors.join()).toMatch(/Invalid world size/);
    expect(mut((d) => { d.w = 128; d.h = 128; }).errors.join()).toMatch(/Grid "elev"|does not match/);
    expect(mut((d) => { d.terrain.elev = d.terrain.elev.slice(0, 400); }).errors.join()).toMatch(/Grid "elev"/);
    expect(mut((d) => { delete (d as Partial<SaveData>).objects; }).errors.join()).toMatch(/objects/);
    // NaN elevations.
    const nan = mut((d) => {
      const f = new Float32Array(256 * 256); f.fill(NaN);
      d.terrain.elev = bytesToB64(new Uint8Array(f.buffer));
    });
    expect(nan.ok).toBe(false);
    expect(nan.errors.join()).toMatch(/invalid values/);
    // Bad objects, sources and env values are skipped/clamped with warnings, not fatal.
    const soft = mut((d) => {
      d.objects.push({ id: 99999, kind: 'dragon' as never, x: 1, y: 1, variant: 'x', props: {} }, { id: 99998, kind: 'tree', x: -4, y: 1, variant: 'oak', props: {} });
      d.objects.push({ id: 99997, kind: 'tree', x: 3, y: 3, variant: 'palm', props: { size: 2 } });
      d.sources.push([999999999, 4], [5, -1]);
      d.env.rain = 7; d.env.time = -3;
    });
    expect(soft.ok).toBe(true);
    expect(soft.warnings.join(' ')).toMatch(/invalid objects were skipped/);
    expect(soft.warnings.join(' ')).toMatch(/"palm" replaced/);
    expect(soft.warnings.join(' ')).toMatch(/invalid source/);
    expect(soft.world!.env.rain).toBe(1);
    expect(soft.world!.env.time).toBe(0);
    expect(soft.world!.objects.find((o) => o.id === 99997)!.variant).toBe('oak');
    expect(good.format).toBe(SAVE_FORMAT);
  });

  it('worlds keep their dragon; older saves without one still load and a new dragon hatches', async () => {
    const { Dragon } = await import('../src/engine/dragon/Dragon');
    const mk = (seed: number) => {
      const e = makeEngine(seed);
      const d = new Dragon(e.world, e.objects, e.water!.view, e.env, seed);
      e.attachDragon(d);
      d.spawn(seed, e.gen?.features ?? null, e.home);
      return e;
    };
    const a = mk(7);
    for (let k = 0; k < 600; k++) a.dragon!.step(1 / 20);
    const json = JSON.stringify(a.snapshot());
    const v = validateSave(json, { w: 256, h: 256 });
    expect(v.ok).toBe(true);
    const b = mk(42);
    expect(b.applyWorld(v.world!)).toEqual([]);
    expect(b.dragon!.e.name).toBe(a.dragon!.e.name);
    expect(b.dragon!.e.x).toBeCloseTo(a.dragon!.e.x, 4);
    expect(b.dragon!.e.memory.landmarks).toEqual(a.dragon!.e.memory.landmarks);
    // Version-1 file from before the dragon: no "dragon" field.
    const old = JSON.parse(json); delete old.dragon;
    const v2 = validateSave(old, { w: 256, h: 256 });
    expect(v2.ok).toBe(true);
    expect(v2.world!.dragon).toBeNull();
    const c = mk(9);
    expect(c.applyWorld(v2.world!)).toEqual([]);
    expect(c.dragon!.e.airborne).toBe(true);
    for (let k = 0; k < 200; k++) c.dragon!.step(1 / 20);
    expect(c.dragon!.recoveries).toBe(0);
    // A corrupt dragon is reported and replaced, the world still loads.
    const bad = JSON.parse(json); bad.dragon = 'garbage';
    const v3 = validateSave(bad, { w: 256, h: 256 });
    expect(v3.ok).toBe(true);
    expect(v3.warnings.join(' ')).toMatch(/Dragon data unreadable/);
  });

  it('a new world from a seed regenerates the same world as the generator', () => {
    const a = makeEngine(1234), b = makeEngine(1234);
    expect(a.world.elev).toEqual(b.world.elev);
    expect(a.objects.toJSON()).toEqual(b.objects.toJSON());
    expect(a.world.name).toBe('Vale 1234');
  });
});

describe('save slots (IndexedDB)', () => {
  it('saves, lists (autosave first, then newest), loads and deletes', async () => {
    const store = await SlotStore.open({ indexedDB: new IDBFactory() });
    expect(store.kind).toBe('indexeddb');
    const data = makeEngine(5).snapshot();
    const a = await store.save(null, { ...data, name: 'First', savedAt: '2026-01-01T10:00:00.000Z' });
    const b = await store.save(null, { ...data, name: 'Second', savedAt: '2026-01-02T10:00:00.000Z' }, 'data:image/png;base64,AAAA');
    await store.save('autosave', { ...data, name: 'Auto', savedAt: '2025-12-01T10:00:00.000Z' });
    const list = await store.list();
    expect(list.map((s) => s.name)).toEqual(['Auto', 'Second', 'First']);
    expect(list[1].thumb).toMatch(/^data:image\/png/);
    expect(list[1].size).toBeGreaterThan(100_000);
    const back = await store.load(a.id);
    expect(back!.name).toBe('First');
    expect(validateSave(back).ok).toBe(true);
    // Overwrite keeps the id.
    await store.save(b.id, { ...data, name: 'Second v2', savedAt: '2026-01-03T10:00:00.000Z' });
    expect((await store.list()).filter((s) => s.id === b.id)[0].name).toBe('Second v2');
    await store.remove(a.id);
    expect((await store.list()).map((s) => s.id)).not.toContain(a.id);
    expect(await store.load(a.id)).toBeNull();
  });

  it('falls back to memory storage without IndexedDB or localStorage', async () => {
    const store = await SlotStore.open({});
    expect(store.kind).toBe('memory');
    const m = await store.save(null, makeEngine(9).snapshot());
    expect((await store.load(m.id))!.seed).toBe(9);
  });
});
