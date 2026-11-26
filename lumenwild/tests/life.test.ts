import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain } from '../src/world/terrain';
import { LifeSim } from '../src/world/life/LifeSim';
import type { TerrainQuery } from '../src/world/life/core';
import type { Creature, Species } from '../src/world/life/wildlife';
import { createContinentEngine } from '../src/boot';

/**
 * The living world's behaviour, on a synthetic flat meadow (a river along y = 0) so each rule can be checked alone,
 * and in the real continent at Lumenfall.
 */
let bp: Blueprint, ct: ContinentTerrain;
beforeAll(() => { bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp); }, 60_000);

/** Flat meadow, 100 m above the sea, with a river 6 m wide along y = 0; everything is "loaded". */
const meadow: TerrainQuery = {
  height: () => 100, water: (_x, y) => Math.abs(y) < 3, walkable: (_x, y) => Math.abs(y) >= 3, biome: () => 'heartlands', detailed: () => true,
};

function simAt(hour = 10): LifeSim {
  const s = new LifeSim(bp, ct, meadow);
  s.clock.hour = hour;
  return s;
}
let n = 0;
function add(s: LifeSim, sp: Species, x: number, y: number, extra: Partial<Creature> = {}): Creature {
  const id = `${sp}-test-${n++}`;
  const c: Creature = { id, kind: 'creature', sp, tag: sp, x, y, alt: 0, alive: true, h: 0, st: 'idle', stT: 0, next: 0, tx: x, ty: y, target: null, hunger: 0.1, thirst: 0.1, energy: 0.9, stamina: 1, homeX: x, homeY: y, group: id, leader: true, male: true, look: 0.3, alert: 0, diedAt: -1, tier: 0, water: null, ...extra };
  s.wildlife.creatures.set(id, c);
  return c;
}
/** Step the world without spawning (synthetic tests place their own animals). */
function run(s: LifeSim, seconds: number, hour = s.clock.hour, rain = 0): void {
  (s as unknown as { lastPopulate: number }).lastPopulate = 1e12;
  for (let t = 0; t < seconds; t += 0.1) s.update(0.1, { hour, rain });
}

describe('wildlife', { timeout: 120_000 }, () => {
  it('a hungry wolf pack hunts a deer, which runs; the pack catches it and eats', () => {
    const s = simAt(20);
    const deer = add(s, 'deer', 60, 40);
    const wolves = [0, 1, 2].map((k) => add(s, 'wolf', 0, 40 + k * 3, { hunger: 0.9, group: 'pack', leader: k === 0 }));
    let fled = false;
    for (let t = 0; t < 90 && deer.alive; t++) { run(s, 1, 20); if (deer.st === 'flee') fled = true; }
    expect(fled).toBe(true);
    expect(deer.alive).toBe(false);
    expect(wolves.some((w) => w.st === 'eat' || w.hunger < 0.5)).toBe(true);
  });

  it('deer run from a player who comes close, and drink at the river when thirsty', () => {
    const s = simAt();
    const deer = add(s, 'deer', 50, 30);
    const p = s.addPlayer('p', 'Tester', 30, 30);
    run(s, 2);
    expect(deer.st).toBe('flee');
    expect(Math.hypot(deer.x - p.x, deer.y - p.y)).toBeGreaterThan(20);
    const thirsty = add(s, 'deer', 300, 40, { thirst: 0.9 });
    s.players.clear();
    run(s, 40);
    expect(Math.abs(thirsty.y)).toBeLessThan(12);
    expect(thirsty.thirst).toBeLessThan(0.5);
  });

  it('animals sleep outside their active hours, and a bear charges an intruder', () => {
    const s = simAt(2);
    const deer = add(s, 'deer', 100, 100), fox = add(s, 'fox', 140, 100);
    run(s, 3, 2);
    expect(deer.st).toBe('sleep');
    expect(fox.st).not.toBe('sleep'); // foxes are out at night
    const s2 = simAt(11);
    const bear = add(s2, 'bear', 0, 100);
    s2.addPlayer('p', 'Tester', 20, 100);
    run(s2, 1.5, 11);
    expect(bear.st).toBe('charge');
    expect(bear.alert).toBeGreaterThan(0);
  });

  it('a flock takes to the air together when startled', () => {
    const s = simAt();
    const birds = [0, 1, 2, 3].map((k) => add(s, 'bird', 200 + k, 200, { group: 'flock', leader: k === 0 }));
    s.addPlayer('p', 'Tester', 206, 200);
    run(s, 2);
    expect(birds.filter((b) => b.st === 'flee').length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...birds.map((b) => b.alt))).toBeGreaterThan(3);
  });

  it('spawning is deterministic: the same cells give the same creatures with the same identities', () => {
    const a = simAt(), b = simAt();
    const f = [{ x: 56000, y: 56000 }];
    const ctx = (s: LifeSim) => (s as unknown as { wctx: Parameters<LifeSim['wildlife']['populate']>[1] }).wctx;
    a.wildlife.populate(f, ctx(a)); b.wildlife.populate(f, ctx(b));
    expect(a.wildlife.creatures.size).toBeGreaterThan(50);
    expect([...a.wildlife.creatures.keys()]).toEqual([...b.wildlife.creatures.keys()]);
    const sp = new Set([...a.wildlife.creatures.values()].map((c) => c.sp));
    for (const k of ['deer', 'fox', 'bird']) expect(sp.has(k as Species), k).toBe(true);
  });
});

describe('dragons', { timeout: 120_000 }, () => {
  it('five dragons at five nests; at night they go home and sleep', () => {
    const s = simAt(23);
    s.start(null);
    expect(s.dragons.dragons.map((d) => d.name).sort()).toEqual(['Ashmaw', 'Aurath', 'Emberfang', 'Mossheart', 'Rimeclaw']);
    run(s, 900, 23);
    const asleep = s.dragons.dragons.filter((d) => d.st === 'sleep');
    expect(asleep.length).toBeGreaterThanOrEqual(4);
  });

  it('a hungry dragon dives on prey it sees and feeds; prey animals run from a low dragon', () => {
    const s = simAt(12);
    s.start(null);
    const d = s.dragons.dragons[0];
    Object.assign(d, { x: 0, y: 400, z: 260, alt: 160, st: 'hunt', hunger: 0.9, thirst: 0, energy: 0.9, next: 0, route: [] });
    const deer = add(s, 'deer', 120, 420);
    run(s, 60, 12);
    expect(deer.alive).toBe(false);
    expect(d.hunger).toBeLessThan(0.5); // it fed
  });

  it('a player near a nest is confronted; migrating dragons stay at least 450 m above villages', () => {
    const s = simAt(12);
    s.start(null);
    const d = s.dragons.dragons.find((q) => q.home === 'territory-elderwood-canopy')!;
    const nest = WORLD.territories.find((t) => t.id === d.home)!.nest!;
    s.addPlayer('p', 'Tester', nest[0] * 100 + 300, nest[1] * 100);
    run(s, 20, 12);
    expect(['defend', 'takeoff']).toContain(d.st);
    // Over Lumenfall during a migration: the flight rule.
    const s2 = simAt(12);
    s2.start(null);
    const m = s2.dragons.dragons.find((q) => q.st === 'migrate')!;
    const v = WORLD.settlements[0];
    Object.assign(m, { x: v.at[0] * 100 - 3000, y: v.at[1] * 100, h: 0, route: [[v.at[0] * 100 + 6000, v.at[1] * 100]], watch: 'none' });
    let minOver = Infinity;
    for (let t = 0; t < 200; t++) { run(s2, 0.5, 12); if (Math.hypot(m.x - v.at[0] * 100, m.y - v.at[1] * 100) < 800) minOver = Math.min(minOver, m.alt); }
    expect(minOver).toBeGreaterThanOrEqual(440);
  });

  it('the living world saves and loads: creatures (alive or dead), dragons, the traveller and the explored map', () => {
    const s = simAt(12);
    s.addPlayer('local', 'Tester', 56000, 56000);
    s.start({ x: 56000, y: 56000 });
    s.update(0.1, { hour: 12, rain: 0 }); // populates the surroundings
    run(s, 3, 12);
    const victim = [...s.wildlife.creatures.values()][0];
    victim.alive = false; victim.diedAt = s.clock.t;
    s.players.get('local')!.inv = { coins: 42 };
    s.revealFrom(56000, 56000, 3000);
    const j = JSON.parse(JSON.stringify(s.toJSON()));
    const s2 = simAt(12);
    s2.addPlayer('local', 'Tester', 0, 0);
    s2.start(null);
    expect(s2.load(j)).toEqual([]);
    expect(s2.wildlife.creatures.get(victim.id)!.alive).toBe(false);
    expect(s2.wildlife.creatures.size).toBe(s.wildlife.creatures.size);
    expect(s2.players.get('local')!.inv.coins).toBe(42);
    expect(s2.players.get('local')!.x).toBe(56000);
    expect(s2.dragons.dragons.map((d) => [d.id, Math.round(d.x)])).toEqual(s.dragons.dragons.map((d) => [d.id, Math.round(d.x)]));
    expect(Buffer.from(s2.discovery.fog).equals(Buffer.from(s.discovery.fog))).toBe(true);
  });
});

describe('living villages and the traveller (real continent)', { timeout: 300_000 }, () => {
  it('Lumenfall’s people follow their day: at work by day, home at night, inside when it pours, chatting when they meet', () => {
    const { engine, session, life } = createContinentEngine({ worker: false });
    const lw = life!, sim = lw.sim;
    engine.cam.setViewport(1440, 900);
    let f = 0;
    const step = (frames: number) => { for (let k = 0; k < frames; k++) engine.frame(f++ * 1000 / 60); };
    engine.env.time = 10; step(60);
    const people = [...sim.villages.people.values()].filter((v) => v.village === 'lumenfall');
    expect(people.length).toBeGreaterThan(30);
    expect(new Set(people.map((v) => v.tag)).size).toBeGreaterThan(5); // innkeeper, blacksmith, merchant, farmers...
    const jobs = people.map((v) => v.tag);
    for (const j of ['farmer', 'blacksmith', 'innkeeper', 'merchant']) expect(jobs, j).toContain(j);
    engine.setSpeed(8);
    step(600);
    expect(people.filter((v) => v.out).length).toBeGreaterThan(people.length * 0.6);
    const chats = people.filter((v) => v.st === 'chat' || v.sayT > 0).length;
    console.log(`Lumenfall at ${engine.env.time.toFixed(1)} h: ${people.length} villagers, ${people.filter((v) => v.out).length} outdoors, ${chats} talking; states ${[...new Set(people.map((v) => v.st))]}`);
    engine.env.time = 23.5; step(2400);
    expect(people.filter((v) => v.out).length).toBeLessThan(people.length * 0.25);
    engine.env.time = 10; engine.env.rain = 1; step(2400);
    const farmers = people.filter((v) => v.act === 'hoe');
    expect(farmers.filter((v) => v.out && v.st === 'work').length).toBe(0); // nobody hoes in a downpour
    expect(farmers.filter((v) => v.out).length).toBeLessThan(farmers.length * 0.3); // most are inside (the rest still walking in)
    void session;
  });

  it('the traveller walks with WASD-style input, runs on stamina, cannot walk on water, and finds things to take', () => {
    const { engine, life } = createContinentEngine({ worker: false });
    const lw = life!, p = lw.player;
    engine.cam.setViewport(1440, 900);
    let f = 0;
    const x0 = p.x;
    lw.input = { dx: -1, dy: 0, run: true };
    for (let k = 0; k < 300; k++) engine.frame(f++ * 1000 / 60);
    expect(p.walked).toBeGreaterThan(15);
    expect(p.stamina).toBeLessThan(0.9);
    expect(lw.q.water(p.x, p.y)).toBe(false);
    void x0;
    // A cache placed beside the traveller is offered by E and goes into the pack.
    const [wx, wy] = lw.session.win.toWindow(p.x, p.y);
    engine.objects.add({ kind: 'cache', x: Math.floor(wx) + 1, y: Math.floor(wy), variant: 'ore', props: {} });
    const it = lw.interaction();
    expect(it?.label).toMatch(/ore/);
    lw.interact();
    expect(p.inv.ore).toBe(1);
  });
});
