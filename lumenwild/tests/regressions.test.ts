import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain } from '../src/world/terrain';
import { LifeSim } from '../src/world/life/LifeSim';
import type { TerrainQuery } from '../src/world/life/core';
import type { Creature } from '../src/world/life/wildlife';
import { DragonPoses, CLASSIC, Mode, Part } from '../src/engine/dragon/DragonPoses';
import { DRAGON_STYLES } from '../src/world/life/dragonStyles';
import { CREATURE_COMBAT } from '../src/world/rpg/content';
import { makeItem } from '../src/world/rpg/items';
import { nextUid } from '../src/world/rpg/hero';
import { createContinentEngine } from '../src/boot';

/**
 * Regression guards for protected systems that had no direct test (PROTECTED_SYSTEMS.md, section F): the five
 * continent dragons' identities, dragons never teleporting and keeping their homes, deterministic wildlife,
 * region transitions without duplicated or lost entities, and a bear fight to the end.
 */
let bp: Blueprint, ct: ContinentTerrain;
beforeAll(() => { bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp); }, 60_000);
const meadow: TerrainQuery = { height: () => 100, water: () => false, walkable: () => true, biome: () => 'heartlands', detailed: () => true };
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); };

describe('the five continent dragons keep their identities', () => {
  const ids = ['dragon-aurath', 'dragon-emberfang', 'dragon-rimeclaw', 'dragon-mossheart', 'dragon-ashmaw'];
  const pose = (style = CLASSIC, mode = Mode.Flight, frame = 4, bank = 0) => new DragonPoses(style).get(5, mode, frame, 0, bank);
  const sig = (cells: ReturnType<typeof pose>) => fnv(cells.map((c) => `${c.dx},${c.dy},${c.g},${c.fg},${c.bg},${c.part}`).join(';'));

  it('each has its own palette, size and refined wing; poses match their golden hashes', () => {
    expect(Object.keys(DRAGON_STYLES).sort()).toEqual([...ids].sort());
    const membranes = new Set(ids.map((id) => DRAGON_STYLES[id].pal.membrane.join(',')));
    expect(membranes.size).toBe(5); // five different wings
    const size = (id: string) => pose(DRAGON_STYLES[id]).length;
    expect(size('dragon-aurath')).toBeGreaterThan(size('dragon-emberfang')); // the elder storm dragon is the largest
    expect(size('dragon-mossheart')).toBeLessThan(size('dragon-emberfang')); // the forest drake is the smallest
    for (const id of ids) {
      const s = DRAGON_STYLES[id];
      expect(s.fingers3 && s.bank && s.rim).toBe(true);
      // The third finger: more bone cells than the classic wing at the same scale.
      const bones = (st: typeof s) => pose({ ...st, scale: 1, span: 1, body: 1 }).filter((c) => c.part === Part.Bone).length;
      expect(bones(s)).toBeGreaterThan(bones({ ...CLASSIC }));
      // Banking changes the silhouette.
      expect(sig(pose(s, Mode.Flight, 4, 2))).not.toBe(sig(pose(s)));
    }
    // Golden signatures: any change to a dragon's look must update these on purpose (and PROTECTED_SYSTEMS.md).
    const golden = Object.fromEntries(ids.map((id) => [id, [sig(pose(DRAGON_STYLES[id])), sig(pose(DRAGON_STYLES[id], Mode.Standing, 0)), sig(pose(DRAGON_STYLES[id], Mode.Glide, 0, -2))]]));
    expect(golden).toMatchSnapshot();
    // The Valley dragon (classic) is unchanged by the continent styles.
    expect(sig(pose())).toMatchSnapshot();
  });
});

describe('dragons and wildlife (living world)', { timeout: 120_000 }, () => {
  it('dragons never teleport and keep their homes over 20 simulated minutes; state survives a save', () => {
    const s = new LifeSim(bp, ct, meadow);
    s.addPlayer('p', 'Watcher', 56000, 56000);
    s.start({ x: 56000, y: 56000 });
    (s as unknown as { lastPopulate: number }).lastPopulate = 1e12;
    const homes = s.dragons.dragons.map((d) => d.home);
    let prev = s.dragons.dragons.map((d) => [d.x, d.y]);
    let worst = 0;
    const states = new Set<string>();
    for (let t = 0; t < 1200; t += 0.1) {
      s.clock.hour = (10 + t / 60) % 24;
      s.update(0.1, { hour: s.clock.hour, rain: 0 });
      s.dragons.dragons.forEach((d, k) => { worst = Math.max(worst, Math.hypot(d.x - prev[k][0], d.y - prev[k][1])); states.add(d.st); });
      prev = s.dragons.dragons.map((d) => [d.x, d.y]);
    }
    expect(worst).toBeLessThanOrEqual(48 * 0.1 * 1.25); // the fastest dive is 48 m/s
    expect(s.dragons.dragons.map((d) => d.home)).toEqual(homes);
    expect(states.size).toBeGreaterThan(2); // they do more than one thing
    const j = JSON.parse(JSON.stringify(s.toJSON()));
    const s2 = new LifeSim(bp, ct, meadow); s2.addPlayer('p', 'Watcher', 0, 0); s2.start(null); s2.load(j);
    // A manoeuvre in progress (landing, diving, taking off) resumes as patrol: its target is not part of the save.
    const settled = (st: string) => (st === 'land' || st === 'dive' || st === 'takeoff' ? 'patrol' : st);
    expect(s2.dragons.dragons.map((d) => [d.id, Math.round(d.x), Math.round(d.y), d.st, d.home])).toEqual(s.dragons.dragons.map((d) => [d.id, Math.round(d.x), Math.round(d.y), settled(d.st), d.home]));
  });

  it('wildlife spawns deterministically: the same cells give the same animals', () => {
    const a = new LifeSim(bp, ct, meadow), b = new LifeSim(bp, ct, meadow);
    for (const s of [a, b]) { s.addPlayer('p', 'x', 52000, 54000); s.update(0.1, { hour: 10, rain: 0 }); }
    const sig = (s: LifeSim) => [...s.wildlife.creatures.values()].map((c) => `${c.id}:${c.sp}:${c.x.toFixed(2)}:${c.y.toFixed(2)}`).sort();
    expect(a.wildlife.creatures.size).toBeGreaterThan(50);
    expect(sig(a)).toEqual(sig(b));
  });

  it('a bear fights to the end and drops its loot', () => {
    const s = new LifeSim(bp, ct, meadow), p = s.addPlayer('p', 'Hunter', 6000, 6000);
    (s as unknown as { lastPopulate: number }).lastPopulate = 1e12;
    p.hero.equip.weapon = makeItem('iron-axe', 1, nextUid(p.hero), null, 2);
    const bear: Creature = { id: 'bear-r', kind: 'creature', sp: 'bear', tag: 'bear', x: 6001.5, y: 6000, alt: 0, alive: true, h: 0, st: 'idle', stT: 0, next: 0, tx: 6001.5, ty: 6000, target: null, hunger: 0.1, thirst: 0.1, energy: 1, stamina: 1, homeX: 6001.5, homeY: 6000, group: 'bear-r', leader: true, male: true, look: 0.4, alert: 0, diedAt: -1, tier: 0, water: null, hp: CREATURE_COMBAT.bear.hp, foe: null, atkT: 0 };
    s.wildlife.creatures.set(bear.id, bear);
    let bitten = 0;
    for (let k = 0; k < 200 && bear.alive; k++) {
      p.x = bear.x - 1.3; p.y = bear.y; p.hero.hp = Math.max(p.hero.hp, 60);
      s.rpg.command('p', { t: 'attack', h: 0 });
      for (let j = 0; j < 9; j++) s.update(0.1, { hour: 12, rain: 0 });
      bitten += s.rpg.drain().filter((e) => e.e === 'hurt').length;
    }
    expect(bear.alive).toBe(false);
    expect(bitten).toBeGreaterThan(0); // it fought back
    expect(p.hero.stats.kills.bear).toBe(1);
    const bag = [...s.rpg.loot.values()].find((g) => g.owner === 'p')!;
    expect(bag.items.map((i) => i.id)).toContain('bear-meat');
  });
});

describe('region transitions', { timeout: 300_000 }, () => {
  it('walking across region edges and back loses and duplicates nothing', () => {
    const { engine: e, session: s, life } = createContinentEngine({ worker: false });
    const lw = life!, p = lw.player;
    e.cam.setViewport(1280, 800);
    let f = 0;
    const frames = (n: number) => { for (let k = 0; k < n; k++) e.frame(f++ * 1000 / 60); };
    frames(10);
    const S = s.win.S;
    const objectKeys = () => { const [ox, oy] = s.win.origin; return [...e.objects.objects.values()].map((o) => `${o.kind}:${o.variant}:${o.x + ox * S},${o.y + oy * S}`); };
    const startOrigin = [...s.win.origin], before = objectKeys().sort(), creaturesBefore = new Set(lw.sim.wildlife.creatures.keys()), villagers = lw.sim.villages.people.size;
    expect(new Set(before).size).toBe(before.length); // no duplicate objects to begin with
    const x0 = p.x, y0 = p.y;
    // East across two region edges, then back (the camera follows; the window moves with it).
    for (let k = 0; k < 30; k++) { p.x += 20; frames(2); }
    expect(s.stats.shifts).toBeGreaterThanOrEqual(2);
    const away = objectKeys();
    expect(new Set(away).size).toBe(away.length);
    for (let k = 0; k < 30; k++) { p.x -= 20; frames(2); }
    p.x = x0; p.y = y0; frames(4);
    expect([...s.win.origin]).toEqual(startOrigin);
    const after = objectKeys().sort();
    expect(after).toEqual(before); // the same objects, once each
    for (const id of creaturesBefore) expect(lw.sim.wildlife.creatures.has(id)).toBe(true); // nobody lost
    expect(lw.sim.villages.people.size).toBe(villagers); // villagers not populated twice
    const ids = [...lw.sim.wildlife.creatures.keys()];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
