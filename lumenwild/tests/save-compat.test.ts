import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSave } from '../src/persist/format';
import { validateContinentSave } from '../src/world/continentSave';
import { WORLD } from '../src/world/data';
import { createEngine, createContinentEngine } from '../src/boot';
import { WorldServer } from '../server/WorldServer';
import { count } from '../src/world/rpg/hero';

/**
 * Old saves keep loading, with nothing lost. Each fixture in tests/fixtures/saves/ was written by the commit named
 * in its file name, using that commit's own code (Valley v1 before and after the dragon; continent saves with edits
 * only, with villages, with the first living world (a pack of counts), with characters; the server file v1 and v2).
 * They are loaded here the way the app and the server load them.
 */
const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(join(__dirname, 'fixtures/saves', name))).toString('utf8'));

describe('old saves load without losing data', { timeout: 300_000 }, () => {
  it.each([['valley-v1-before-dragon-609ca20.json.gz', false], ['valley-v1-dragon-df6bf74.json.gz', true]])('Valley save %s', (name, dragon) => {
    const data = fixture(name);
    const e = createEngine(7, 'world', { worker: false });
    const v = validateSave(data, { w: e.world.w, h: e.world.h });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    e.applyWorld(v.world!);
    expect(e.world.name).toBe('Fixture Valley');
    expect(e.objects.objects.size).toBe(data.objects.length);
    if (dragon) expect(data.dragon).toBeTruthy();
    else expect(data.dragon ?? null).toBeNull(); // the older file has no dragon; one hatches (see format.ts)
  });

  function loadContinent(name: string) {
    const data = fixture(name);
    const { engine: e, session: s, life } = createContinentEngine({ worker: false });
    e.cam.setViewport(1280, 800);
    const v = validateContinentSave(data, WORLD, s.win.S);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    s.loadAt(e, v.save!.at, v.edits!);
    const warnings = life && v.save!.life ? life.sim.load(v.save!.life) : [];
    return { data, e, s, life: life!, v, warnings };
  }

  it.each(['continent-v1-edits-fd09d48.json.gz', 'continent-v1-villages-1ccdf01.json.gz'])('continent save from before the living world: %s (edits come back)', (name) => {
    const { data, e, s } = loadContinent(name);
    expect(Object.keys(data.edits ?? {}).length).toBeGreaterThan(0);
    // The painted cells (material 4) are back where they were saved.
    const edited = s.collectEdits(e);
    expect(edited.regions.size).toBeGreaterThan(0);
    let painted = 0;
    for (let i = 0; i < e.world.mat.length; i++) if (e.world.mat[i] === 4) painted++;
    expect(painted).toBeGreaterThanOrEqual(6);
  });

  it('continent save with the first living world (a pack of counts): becomes a character, nothing lost', () => {
    const { life, warnings } = loadContinent('continent-v1-life-pack-d55b216.json.gz');
    const h = life.player.hero;
    expect(h.coins).toBe(20 + 37); // a new character's 20 plus the saved 37
    expect(count(h, 'herbs')).toBe(2);
    expect(count(h, 'ore')).toBe(1);
    expect(count(h, 'relic')).toBe(1);
    expect(life.player.walked).toBe(321);
    expect(life.sim.wildlife.creatures.size).toBeGreaterThan(0);
    expect(warnings.filter((w) => /unreadable|start fresh|starts over/i.test(w))).toEqual([]);
  });

  it('continent save with a character (level, equipment, pack, quest, skills): restored exactly', () => {
    const { data, life } = loadContinent('continent-v1-life-rpg-df6bf74.json.gz');
    const saved = data.life.players[0].hero, h = life.player.hero;
    expect(h.coins).toBe(123);
    expect(h.level).toBe(saved.level);
    expect(h.level).toBeGreaterThan(1);
    expect(h.attrs).toEqual(saved.attrs);
    expect(h.equip.weapon?.id).toBe('iron-sword');
    expect(h.equip.weapon?.r).toBe(2);
    expect(count(h, 'wolf-pelt')).toBe(3);
    expect(h.quests.map((q) => q.title)).toEqual(['Bring 4 herbs']);
    expect(h.skills.melee).toBe(120);
    expect(h.stats.kills.wolf).toBe(4);
    expect(h.found).toContain('lumenfall');
    expect(life.player.walked).toBe(321);
  });

  it.each([['server-v1-d55b216.json.gz', 1], ['server-v2-df6bf74.json.gz', 2]])('server file %s: sessions, characters, edits and finds survive', async (name, version) => {
    const file = join(mkdtempSync(join(tmpdir(), 'lw-compat-')), 'world.json');
    writeFileSync(file, JSON.stringify(fixture(name)));
    const server = new WorldServer({ port: 0, dataFile: file });
    expect(server.sessions.size).toBe(2);
    const ada = [...server.sessions.values()].find((s) => s.name === 'Ada')!;
    expect(ada).toBeDefined();
    const h = ada.player.hero;
    if (version === 1) { expect(h.coins).toBe(20 + 25); expect(count(h, 'herbs')).toBe(1); }
    else { expect(h.coins).toBe(77); expect(count(h, 'fang')).toBe(2); expect(h.level).toBeGreaterThan(1); }
    expect(ada.player.walked).toBe(12);
    expect(server.taken.has('chest:50010,51020')).toBe(true);
    expect(server.edits.has('195,199')).toBe(true);
    await server.stop();
  });
});
