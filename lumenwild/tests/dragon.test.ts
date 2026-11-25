import { describe, it, expect } from 'vitest';
import { World } from '../src/engine/world/World';
import { ObjectStore } from '../src/engine/objects/ObjectStore';
import { generateWorld, prefillWater, type GenInfo } from '../src/engine/gen/world';
import { Dragon } from '../src/engine/dragon/Dragon';
import { DRAGON } from '../src/engine/dragon/DragonConfig';
import { chooseDestination } from '../src/engine/dragon/DragonNavigation';
import { flightStep } from '../src/engine/dragon/DragonFlight';
import { validateDragon, STATES } from '../src/engine/dragon/DragonEntity';
import { Mat } from '../src/engine/world/materials';

interface Env { night: number; daylight: number; rain: number; gust: number; windDir: number }
const day = (): Env => ({ night: 0, daylight: 1, rain: 0, gust: 0.2, windDir: 1 });

const worlds = new Map<number, { world: World; objects: ObjectStore; info: GenInfo; depth: Float32Array; fall: Float32Array }>();
function vale(seed = 7) {
  if (!worlds.has(seed)) {
    const world = new World(256, 256), objects = new ObjectStore(world);
    const info = generateWorld(world, objects, seed);
    const depth = new Float32Array(world.n); prefillWater(world, depth, info);
    worlds.set(seed, { world, objects, info, depth, fall: new Float32Array(world.n) });
  }
  return worlds.get(seed)!;
}

function dragonIn(seed = 7, env: Env = day()) {
  const v = vale(seed);
  const d = new Dragon(v.world, v.objects, { depth: v.depth, fall: v.fall }, env, seed);
  const ripples: Array<[number, number]> = [];
  d.attach({ view: { depth: v.depth, fall: v.fall }, disturb: (x: number, y: number) => { ripples.push([x, y]); } } as never, null);
  d.spawn(seed, v.info.features, [128, 128]);
  return { d, env, ripples, ...v };
}

function run(d: Dragon, seconds: number, dt = 1 / 20, each?: (k: number) => void) {
  for (let k = 0; k < seconds / dt; k++) { d.step(dt); each?.(k); }
}

describe('dragon: autonomous behaviour', () => {
  it('lives a varied day without invalid transitions, repairs or teleports, and keeps its states for their minimum time', () => {
    const { d, env } = dragonIn(7);
    let maxStep = 0, px = d.e.x, py = d.e.y, deficit = 0;
    const seen = new Set<string>();
    run(d, 900, 1 / 20, (k) => {
      if (k === 600 * 20) { env.night = 1; env.daylight = 0; }
      maxStep = Math.max(maxStep, Math.hypot(d.e.x - px, d.e.y - py)); px = d.e.x; py = d.e.y;
      seen.add(d.e.state);
      if (d.e.airborne && !['TAKING_OFF', 'LANDING', 'DESCENDING'].includes(d.e.state)) deficit = Math.max(deficit, d.senses.obstacleTop(d.e.x, d.e.y) - d.e.z);
      expect(d.e.z).toBeGreaterThanOrEqual(d.senses.ground(d.e.x, d.e.y) - 0.01);
    });
    expect(d.fsm.refused).toBe(0);
    expect(d.recoveries).toBe(0);
    for (const h of d.fsm.history) expect(d.fsm.allowed(h.from, h.to) || h.reason === 'reset', `${h.from}->${h.to}`).toBe(true);
    // No teleporting: never more than top speed (plus wind) in one step.
    expect(maxStep).toBeLessThan((DRAGON.maxSpeed + 2) / 20 + 0.01);
    // Flies over obstacles with clearance (the obstacle grid is conservative: a short dip within 6 m is tolerated).
    expect(deficit).toBeLessThan(6);
    // A rich repertoire in one session.
    for (const s of ['FLYING', 'EXPLORING', 'CIRCLING', 'DESCENDING', 'LANDING', 'TAKING_OFF', 'RESTING', 'DRINKING', 'SLEEPING', 'GLIDING']) expect(seen, s).toContain(s);
    // Ground states chosen by the AI last at least their minimum time.
    const hist = d.fsm.history;
    for (let k = 0; k + 1 < hist.length; k++) {
      const s = hist[k].to, dur = hist[k + 1].t - hist[k].t;
      if (['RESTING', 'SLEEPING', 'DRINKING', 'CIRCLING'].includes(s)) expect(dur, s).toBeGreaterThanOrEqual(DRAGON.minState[s] - 0.06);
    }
    expect(d.e.memory.landmarks.length).toBeGreaterThanOrEqual(3);
  });

  it('different dragons (seeds) have different personalities and behave differently', () => {
    const a = dragonIn(7).d, b = dragonIn(42).d;
    expect(a.e.personality).not.toEqual(b.e.personality);
    run(a, 120); run(b, 120);
    expect(a.fsm.history.map((h) => h.to).join()).not.toBe(b.fsm.history.map((h) => h.to).join());
  });

  it('destination choice is weighted and avoids places it has just visited', () => {
    const { d } = dragonIn(7);
    const pois = d.senses.pois;
    expect(pois.length).toBeGreaterThan(8);
    const count = (n: number) => { const c = new Map<string, number>(); for (let k = 0; k < n; k++) { const p = chooseDestination(d.e, d.senses, d.rand)!; c.set(`${p.x},${p.y}`, (c.get(`${p.x},${p.y}`) ?? 0) + 1); } return c; };
    const before = count(600);
    expect(before.size).toBeGreaterThan(5); // spread over many places
    const [top] = [...before.entries()].sort((a, b) => b[1] - a[1])[0];
    const [tx, ty] = top.split(',').map(Number);
    d.e.memory.noteVisit(tx, ty, d.e.time, 'test');
    const after = count(600);
    expect(after.get(top) ?? 0).toBeLessThan((before.get(top) ?? 0) * 0.3);
    for (let k = 0; k < 100; k++) { const p = chooseDestination(d.e, d.senses, d.rand, { x: tx, y: ty })!; expect(Math.hypot(p.x - tx, p.y - ty)).toBeGreaterThanOrEqual(10); }
  });
});

describe('dragon: flight', () => {
  it('accelerates smoothly, turns at a limited rate and changes altitude within climb/sink limits', () => {
    const { d } = dragonIn(7);
    const e = d.e, s = d.senses;
    e.speed = 0; e.state = 'FLYING'; e.heading = 0; e.angVel = 0; e.x = 128; e.y = 128;
    e.z = s.obstacleTop(128, 128) + 20;
    let prevSpeed = 0, prevHeading = 0, prevZ = e.z, prevAng = 0, maxDv = 0, maxTurn = 0, maxAngAcc = 0, maxClimb = 0, maxSink = 0, reached = -1;
    for (let k = 0; k < 240; k++) {
      // Drive the flight model directly: full speed, a half turn, climb 15 m then sink 15 m.
      e.desiredSpeed = 8; e.desiredHeading = Math.PI; e.zTarget = k < 120 ? prevZ + 15 : prevZ - 15;
      flightStep(e, 1 / 20, s, { x: 0, y: 0 }, 0);
      maxDv = Math.max(maxDv, e.speed - prevSpeed);
      maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(e.heading - prevHeading), Math.cos(e.heading - prevHeading))));
      maxAngAcc = Math.max(maxAngAcc, Math.abs(e.angVel - prevAng));
      maxClimb = Math.max(maxClimb, (e.z - prevZ) * 20); maxSink = Math.max(maxSink, (prevZ - e.z) * 20);
      if (reached < 0 && e.speed > 7) reached = k / 20;
      prevSpeed = e.speed; prevHeading = e.heading; prevZ = e.z; prevAng = e.angVel;
    }
    expect(maxDv).toBeLessThanOrEqual(DRAGON.accel / 20 + 1e-6);
    expect(maxTurn).toBeLessThanOrEqual(DRAGON.maxTurn / 20 + 1e-6);
    expect(maxAngAcc).toBeLessThanOrEqual(DRAGON.turnAccel / 20 + 1e-6);
    expect(reached).toBeGreaterThan(1.5); // not instant
    expect(reached).toBeLessThan(4);
    expect(Math.cos(e.heading)).toBeLessThan(-0.95); // completed the half turn
    expect(maxClimb).toBeLessThanOrEqual(DRAGON.climbRate + 0.01);
    expect(maxClimb).toBeGreaterThan(DRAGON.climbRate * 0.8);
    expect(maxSink).toBeLessThanOrEqual(DRAGON.sinkRate + 0.01);
  });

  it('climbs over or detours around a tall ridge in its way, never entering the ground', () => {
    const world = new World(160, 160), objects = new ObjectStore(world);
    for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) { const i = y * 160 + x; world.elev[i] = x >= 78 && x <= 84 && y > 20 && y < 140 ? 32 : 2; world.mat[i] = Mat.Grass; }
    const env = day();
    const d = new Dragon(world, objects, null, env, 3);
    d.spawn(3, null, [40, 80]);
    const e = d.e;
    e.x = 40; e.y = 80; e.z = 18; e.heading = 0; e.speed = 8; e.state = 'EXPLORING'; e.stateTime = 10;
    e.target = { x: 130, y: 80, kind: 'test', label: 'beyond the ridge', land: false };
    let crossed = -1, minGap = Infinity;
    for (let k = 0; k < 60 * 20; k++) {
      d.step(1 / 20);
      minGap = Math.min(minGap, e.z - world.elevAt(Math.floor(e.x), Math.floor(e.y)));
      if (crossed < 0 && e.x > 90) crossed = k / 20;
      if (crossed > 0) break;
    }
    expect(crossed).toBeGreaterThan(0);
    expect(minGap).toBeGreaterThan(0.5);
  });
});

describe('dragon: needs and the environment', () => {
  it('thirsty: flies to water, lands on dry level ground at the shore, drinks and makes real ripples', () => {
    const { d, ripples, world, depth } = dragonIn(7);
    d.e.needs.thirst = 1;
    const landings: Array<[number, number]> = [];
    let drank = false, minThirst = 1;
    run(d, 240, 1 / 20, () => {
      minThirst = Math.min(minThirst, d.e.needs.thirst);
      const h = d.fsm.history[d.fsm.history.length - 1];
      if (h && h.from === 'LANDING' && h.t === d.e.time - d.e.stateTime && !landings.some(([x, y]) => x === d.e.x && y === d.e.y)) landings.push([d.e.x, d.e.y]);
      if (d.e.state === 'DRINKING') drank = true;
    });
    expect(drank).toBe(true);
    expect(minThirst).toBeLessThan(0.1);
    expect(ripples.length).toBeGreaterThan(2);
    // Ripples land on water.
    expect(ripples.some(([x, y]) => depth[y * world.w + x] > 0.03)).toBe(true);
    for (const [x, y] of landings) {
      expect(d.senses.slope(Math.round(x), Math.round(y))).toBeLessThan(1.6);
      expect(depth[Math.round(y) * world.w + Math.round(x)]).toBeLessThan(0.1);
    }
  });

  it('tired: lands and rests until its energy recovers', () => {
    const { d } = dragonIn(42);
    d.e.needs.energy = 0.08; d.e.needs.thirst = 0;
    let rested = false, peak = 0;
    run(d, 300, 1 / 20, () => { if (d.e.state === 'RESTING') { rested = true; peak = Math.max(peak, d.e.needs.energy); } });
    expect(rested).toBe(true);
    expect(peak).toBeGreaterThan(0.85);
  });

  it('sleeps at night and wakes in the morning', () => {
    const { d, env } = dragonIn(7, { night: 1, daylight: 0, rain: 0, gust: 0.1, windDir: 1 });
    d.e.needs.thirst = 0;
    let slept = false;
    run(d, 200, 1 / 20, () => { if (d.e.state === 'SLEEPING') slept = true; });
    expect(slept).toBe(true);
    env.night = 0; env.daylight = 1;
    run(d, 120);
    expect(d.e.state).not.toBe('SLEEPING');
  });

  it('at night it flies up the mountain and sleeps in its cave, facing the mouth', () => {
    const { d } = dragonIn(7, { night: 1, daylight: 0, rain: 0, gust: 0.1, windDir: 1 });
    d.e.needs.thirst = 0;
    const lair = d.e.lair!;
    expect(lair).not.toBeNull();
    expect(d.senses.isLandable(lair.x, lair.y)).toBe(true);
    let slept: [number, number, number] | null = null, minGap = Infinity;
    run(d, 240, 1 / 20, () => {
      if (d.e.state === 'SLEEPING' && !slept) slept = [d.e.x, d.e.y, d.e.heading];
      if (d.e.airborne && d.e.state !== 'LANDING') minGap = Math.min(minGap, d.e.z - d.senses.ground(d.e.x, d.e.y));
    });
    expect(slept).not.toBeNull();
    const [sx, sy, sh] = slept!;
    expect(Math.hypot(sx - lair.x, sy - lair.y)).toBeLessThan(3);
    expect(d.senses.terrain(sx, sy)).toBeGreaterThan(55); // up on the summit
    expect(Math.sin(sh)).toBeLessThan(-0.8); // facing north, into the cave
    expect(minGap).toBeGreaterThan(0);
  });

  it('rain makes a sensitive dragon seek shelter; wind pushes it', () => {
    const { d, env } = dragonIn(99, { night: 0, daylight: 1, rain: 1, gust: 0.9, windDir: 1 });
    d.e.personality.sensitivity = 1; d.e.needs.thirst = 0; d.e.needs.energy = 0.9;
    let sheltered = false, drift = 0;
    run(d, 240, 1 / 20, () => {
      if (d.e.goal === 'shelter') sheltered = true;
      if (d.e.airborne) drift = Math.max(drift, d.e.vx - Math.cos(d.e.heading) * d.e.speed);
    });
    expect(sheltered).toBe(true);
    expect(drift).toBeGreaterThan(0.1);
    void env;
  });

  it('a disturbance nearby draws it to investigate (and it circles there)', () => {
    const { d } = dragonIn(7);
    run(d, 30);
    d.investigate(Math.round(d.e.x + 40), Math.round(d.e.y));
    let circled = false;
    run(d, 90, 1 / 20, () => { if (d.e.state === 'CIRCLING' && Math.hypot(d.e.circle.x - (d.e.disturbance?.x ?? d.e.circle.x), 0) < 1) circled = true; });
    expect(d.fsm.history.some((h) => h.to === 'INVESTIGATING' || (h.to === 'TAKING_OFF' && h.reason.includes('investigate')))).toBe(true);
    expect(d.fsm.history.some((h) => h.to === 'CIRCLING' && h.reason.includes('something it noticed'))).toBe(true);
    void circled;
  });
});

describe('dragon: persistence and recovery', () => {
  it('save -> JSON -> load restores position, state, needs, personality and memory', () => {
    const { d } = dragonIn(7);
    run(d, 300);
    const json = JSON.parse(JSON.stringify(d.toJSON()));
    const { d: d2 } = dragonIn(42);
    expect(d2.load(json)).toEqual([]);
    const a = d.e, b = d2.e;
    expect([b.x, b.y, b.heading, b.name]).toEqual([a.x, a.y, a.heading, a.name]);
    expect(b.needs).toEqual(a.needs);
    expect(b.personality).toEqual(a.personality);
    expect(b.memory.landmarks.length).toBe(a.memory.landmarks.length);
    expect(b.memory.visited).toEqual(a.memory.visited);
    expect(b.memory.water).toEqual(a.memory.water);
    expect(b.state === a.state || (a.state === 'TAKING_OFF' && b.state === 'FLYING') || (a.state === 'LANDING' && b.state === 'DESCENDING')).toBe(true);
    run(d2, 60);
    expect(d2.recoveries).toBe(0);
  });

  it('recovers from invalid state and rejects or repairs bad save data', () => {
    const { d } = dragonIn(7);
    d.e.x = NaN; d.e.z = -500; (d.e as { state: string }).state = 'BOGUS'; d.e.needs.energy = 7; d.e.tailX[3] = Infinity;
    d.step(1 / 20);
    expect(d.recoveries).toBe(1);
    expect(Number.isFinite(d.e.x) && Number.isFinite(d.e.z)).toBe(true);
    expect(d.e.z).toBeGreaterThanOrEqual(d.senses.ground(d.e.x, d.e.y) - 0.01);
    expect(STATES).toContain(d.e.state);
    expect(d.e.needs.energy).toBeLessThanOrEqual(1);
    run(d, 30);
    expect(validateDragon(null, 256, 256).save).toBeNull();
    expect(validateDragon('nope', 256, 256).save).toBeNull();
    const bad = validateDragon({ x: 'a', y: 99999, z: NaN, state: 'FLAMING', needs: { energy: -4 } }, 256, 256);
    expect(bad.save).not.toBeNull();
    expect(bad.save!.state).toBe('FLYING');
    expect(bad.save!.y).toBe(254);
    expect(bad.save!.needs.energy).toBe(0);
    expect(bad.warnings.length).toBeGreaterThan(2);
  });
});
