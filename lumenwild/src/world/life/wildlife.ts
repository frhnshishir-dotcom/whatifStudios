import { type Agent, type LifeClock, type TerrainQuery, SpatialHash, rngOf, hashOf, inHours, walkToward } from './core';
import { CREATURE_COMBAT } from '../rpg/content';

/**
 * Autonomous wildlife: deer, wolves, bears, foxes and birds. Each creature has a persistent identity (spawned
 * deterministically per 512 m cell the first time a player comes near), needs (hunger, thirst, energy), a home range,
 * a group (herd, pack, flock) and a behaviour state chosen from what it sees: threats, prey, water, the time of day.
 *
 * Simulation by distance from the nearest player: full behaviour within the detailed (loaded) area, a cheap 1 Hz
 * update within a few kilometres, nothing beyond (state kept; it catches up when someone returns).
 */

export type Species = 'deer' | 'wolf' | 'bear' | 'fox' | 'bird';
export type CState = 'idle' | 'wander' | 'graze' | 'drink' | 'rest' | 'sleep' | 'flee' | 'hunt' | 'eat' | 'charge' | 'follow' | 'fly' | 'fight' | 'dead';

interface SpeciesDef {
  walk: number; run: number;
  /** How far it notices things, and how close a threat may come before it runs. */
  sight: number; flee: number;
  /** Active hours [from, to). */
  active: [number, number];
  group: [number, number];
  /** What it runs from (agent tags / species). */
  fears: string[];
  prey: Species[];
  /** Home range radius (m). Territorial animals defend `territory` m around themselves (bears) or their den (wolves). */
  range: number; territory: number;
  stamina: number;
}

export const SPECIES: Record<Species, SpeciesDef> = {
  deer: { walk: 1.4, run: 11, sight: 70, flee: 38, active: [4.5, 21.5], group: [2, 5], fears: ['wolf', 'bear', 'player', 'dragon', 'villager'], prey: [], range: 320, territory: 0, stamina: 14 },
  wolf: { walk: 1.7, run: 12, sight: 110, flee: 30, active: [16, 10], group: [3, 5], fears: ['bear', 'dragon'], prey: ['deer'], range: 650, territory: 45, stamina: 40 },
  bear: { walk: 1.2, run: 9, sight: 55, flee: 45, active: [6, 21], group: [1, 1], fears: ['dragon'], prey: [], range: 420, territory: 28, stamina: 20 },
  fox: { walk: 1.6, run: 9.5, sight: 45, flee: 26, active: [17, 8], group: [1, 2], fears: ['wolf', 'bear', 'player', 'dragon', 'villager'], prey: ['bird'], range: 260, territory: 0, stamina: 18 },
  bird: { walk: 0.7, run: 9, sight: 35, flee: 16, active: [5.5, 20.5], group: [3, 7], fears: ['wolf', 'bear', 'fox', 'player', 'dragon', 'villager'], prey: [], range: 420, territory: 0, stamina: 60 },
};

export interface Creature extends Agent {
  kind: 'creature';
  sp: Species;
  tag: Species;
  h: number;
  st: CState;
  /** Seconds in the current state; when the next decision is due (clock t). */
  stT: number; next: number;
  tx: number; ty: number;
  target: string | null;
  hunger: number; thirst: number; energy: number; stamina: number;
  homeX: number; homeY: number;
  group: string; leader: boolean;
  male: boolean;
  /** Bird plumage / fur variant 0..1. */
  look: number;
  /** Shown above it while > 0 (alarm, growl). */
  alert: number;
  diedAt: number;
  /** Simulation tier last tick: 0 detailed, 1 nearby, 2 dormant. */
  tier: number;
  /** Remembered drinking spot. */
  water: [number, number] | null;
  /** Health, the player it is fighting, and when it may bite again (clock t). */
  hp: number; foe: string | null; atkT: number;
}

/** Expected groups per 512 m cell, by region. */
const DENSITY: Record<string, Partial<Record<Species, number>>> = {
  heartlands: { deer: 0.6, wolf: 0.03, bear: 0.02, fox: 0.3, bird: 0.7 },
  'golden-plains': { deer: 0.4, wolf: 0.04, fox: 0.25, bird: 0.7 },
  elderwood: { deer: 0.4, wolf: 0.09, bear: 0.08, fox: 0.25, bird: 0.6 },
  'dragon-peaks': { deer: 0.15, wolf: 0.06, bear: 0.05, fox: 0.08, bird: 0.4 },
  'whispering-marshes': { deer: 0.05, fox: 0.2, bird: 0.9 },
  'hollow-lands': { wolf: 0.03, bird: 0.2 },
};
/** Habitat species names (world/creatures/habitats.json) that boost a species near the habitat. */
const HABITAT_NAMES: Record<string, Species> = {
  deer: 'deer', wolf: 'wolf', 'snow wolf': 'wolf', bear: 'bear', fox: 'fox', owl: 'bird', 'giant eagle': 'bird', pheasant: 'bird', heron: 'bird', 'marsh birds': 'bird', birds: 'bird',
};

export const SPAWN_CELL = 512;
/** Distances (m) from the nearest player: populate cells within, simulate coarsely within. */
export const POPULATE_R = 2300, NEARBY_R = 2600;

export interface WildlifeContext {
  q: TerrainQuery;
  clock: LifeClock;
  hash: SpatialHash;
  /** Region id at a point (blueprint; works anywhere). */
  regionAt(x: number, y: number): string;
  /** Habitats (metres): species names within radius. */
  habitats: Array<{ x: number; y: number; r: number; species: string[] }>;
  /** Village centres and radii (wildlife keeps away). */
  villages: Array<{ x: number; y: number; r: number }>;
  /** Something died (for logs, dragons, tests). */
  onKill?(prey: Creature, by: string): void;
  /** Players by id (fights) and a bite landing on one. */
  players?: Map<string, Agent>;
  onBite?(c: Creature, playerId: string): void;
}

export class Wildlife {
  readonly creatures = new Map<string, Creature>();
  readonly spawned = new Set<string>();
  readonly stats = { detailed: 0, nearby: 0, dormant: 0, kills: 0, spawnedCells: 0, ms: 0 };
  private scratch: Agent[] = [];
  private tick = 0;
  /** Region id at a point (set by the host). */
  regionOf: ((x: number, y: number) => string) | null = null;
  constructor(private seed: number) {}

  /** Hurt by a player: the timid run; wolves and bears turn on the attacker (the pack joins in). */
  provoke(c: Creature, by: Agent, clock: LifeClock): void {
    const cc = CREATURE_COMBAT[c.sp];
    c.alert = 2;
    if (cc.dmg > 0 && c.hp > cc.hp * cc.fleeAt) {
      this.engage(c, by.id, clock);
      if (c.sp === 'wolf') for (const m of this.creatures.values()) if (m.group === c.group && m.alive && m !== c && Math.hypot(m.x - c.x, m.y - c.y) < 60) this.engage(m, by.id, clock);
    } else { c.st = 'flee'; c.stT = 0; c.tx = by.x; c.ty = by.y; c.next = clock.t + 3; c.foe = null; }
  }

  private engage(c: Creature, foe: string, clock: LifeClock): void {
    if (c.st !== 'fight') { c.st = 'fight'; c.stT = 0; c.atkT = Math.max(c.atkT, clock.t + 0.4); }
    c.foe = foe; c.alert = 2; c.next = clock.t + 1;
  }

  /** Raise (or bring back) a guardian at an old place, already angry at the player who disturbed it. */
  raiseGuardian(id: string, sp: Species, x: number, y: number, foe: Agent, clock: LifeClock): void {
    let c = this.creatures.get(id);
    if (!c) {
      c = { id, kind: 'creature', sp, tag: sp, x, y, alt: 0, alive: true, h: 0, st: 'idle', stT: 0, next: 0, tx: x, ty: y, target: null, hunger: 0.3, thirst: 0.2, energy: 1, stamina: 1,
        homeX: x, homeY: y, group: id.replace(/-\d+$/, ''), leader: id.endsWith('-0'), male: true, look: 0.5, alert: 0, diedAt: -1, tier: 0, water: null, hp: CREATURE_COMBAT[sp].hp, foe: null, atkT: 0 };
      this.creatures.set(id, c);
    } else if (!c.alive) this.revive(c);
    this.engage(c, foe.id, clock);
  }

  /** Back to life at home, full health. */
  revive(c: Creature): void {
    c.alive = true; c.st = 'idle'; c.diedAt = -1; c.hp = CREATURE_COMBAT[c.sp].hp; c.foe = null; c.x = c.homeX; c.y = c.homeY; c.tx = c.x; c.ty = c.y; c.alert = 0; c.hunger = 0.3;
  }

  /** Make sure the cells around each focus point have their creatures. */
  populate(focus: Array<{ x: number; y: number }>, ctx: WildlifeContext): void {
    for (const f of focus) {
      const c0x = Math.floor((f.x - POPULATE_R) / SPAWN_CELL), c1x = Math.floor((f.x + POPULATE_R) / SPAWN_CELL);
      const c0y = Math.floor((f.y - POPULATE_R) / SPAWN_CELL), c1y = Math.floor((f.y + POPULATE_R) / SPAWN_CELL);
      for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
        const k = `${cx},${cy}`;
        if (this.spawned.has(k) || Math.hypot((cx + 0.5) * SPAWN_CELL - f.x, (cy + 0.5) * SPAWN_CELL - f.y) > POPULATE_R) continue;
        this.spawned.add(k);
        this.spawnCell(cx, cy, ctx);
      }
    }
    this.stats.spawnedCells = this.spawned.size;
  }

  private spawnCell(cx: number, cy: number, ctx: WildlifeContext): void {
    const r = rngOf('wild', this.seed, cx, cy), mx = (cx + 0.5) * SPAWN_CELL, my = (cy + 0.5) * SPAWN_CELL;
    const region = ctx.regionAt(mx, my), dens = DENSITY[region];
    if (!dens) return;
    for (const sp of Object.keys(SPECIES) as Species[]) {
      let d = dens[sp] ?? 0;
      for (const h of ctx.habitats) if (Math.hypot(h.x - mx, h.y - my) < h.r && h.species.some((s) => HABITAT_NAMES[s] === sp)) d = d * 3 + 0.3;
      const groups = Math.floor(d) + (r() < d - Math.floor(d) ? 1 : 0);
      for (let g = 0; g < groups; g++) {
        // A dry spot away from villages for the group's home.
        let hx = 0, hy = 0, ok = false;
        for (let t = 0; t < 10 && !ok; t++) {
          hx = cx * SPAWN_CELL + r() * SPAWN_CELL; hy = cy * SPAWN_CELL + r() * SPAWN_CELL;
          ok = !ctx.q.water(hx, hy) && ctx.villages.every((v) => Math.hypot(v.x - hx, v.y - hy) > v.r + 80) && ctx.regionAt(hx, hy) === region;
        }
        if (!ok) continue;
        const def = SPECIES[sp], n = def.group[0] + Math.floor(r() * (def.group[1] - def.group[0] + 1)), group = `${sp}-${cx}-${cy}-${g}`;
        for (let k = 0; k < n; k++) {
          const id = `${group}-${k}`, a = r() * Math.PI * 2, rr = 2 + r() * 10;
          let x = hx + Math.cos(a) * rr, y = hy + Math.sin(a) * rr;
          if (ctx.q.water(x, y)) { x = hx; y = hy; }
          this.creatures.set(id, {
            id, kind: 'creature', sp, tag: sp, x, y, alt: 0, alive: true, h: r() * Math.PI * 2, st: 'idle', stT: 0, next: 0, tx: x, ty: y, target: null,
            hunger: 0.2 + r() * 0.4, thirst: 0.1 + r() * 0.4, energy: 0.6 + r() * 0.4, stamina: 1, homeX: hx, homeY: hy, group, leader: k === 0,
            male: r() < 0.5, look: r(), alert: 0, diedAt: -1, tier: 2, water: null, hp: CREATURE_COMBAT[sp].hp, foe: null, atkT: 0,
          });
        }
      }
    }
  }

  /** One simulation step for every creature, by tier. `focus`: player positions. */
  update(dt: number, focus: Array<{ x: number; y: number }>, ctx: WildlifeContext): void {
    const t0 = performance.now();
    let det = 0, near = 0, dorm = 0;
    for (const c of this.creatures.values()) {
      if (!c.alive) { if (c.diedAt >= 0 && ctx.clock.t - c.diedAt > 240) c.st = 'dead'; continue; }
      let dmin = Infinity;
      for (const f of focus) dmin = Math.min(dmin, Math.hypot(f.x - c.x, f.y - c.y));
      const tier = ctx.q.detailed(c.x, c.y) ? 0 : dmin < NEARBY_R ? 1 : 2;
      if (tier === 0) { det++; this.detailedStep(c, dt, ctx); }
      else if (tier === 1) {
        // Nearby but not loaded: about once a second, staggered across creatures.
        near++;
        if (((this.tick + (c.look * 997 | 0)) % 10) === 0) this.coarseStep(c, dt * 10, ctx);
      }
      else dorm++;
      c.tier = tier;
    }
    this.stats.detailed = det; this.stats.nearby = near; this.stats.dormant = dorm;
    this.tick++;
    this.stats.ms = performance.now() - t0;
  }

  private needs(c: Creature, dt: number): void {
    const resting = c.st === 'sleep' || c.st === 'rest';
    c.hunger = Math.min(1, c.hunger + dt / (c.sp === 'bird' ? 300 : 700));
    c.thirst = Math.min(1, c.thirst + dt / 500);
    c.energy = Math.max(0, Math.min(1, c.energy + (resting ? dt / 240 : -dt / 1500)));
    const running = c.st === 'flee' || c.st === 'hunt' || c.st === 'charge';
    c.stamina = Math.max(0, Math.min(1, c.stamina + (running ? -dt / SPECIES[c.sp].stamina : dt / 25)));
    if (c.alert > 0) c.alert -= dt;
  }

  private set(c: Creature, st: CState, ctx: WildlifeContext): void {
    if (c.st !== st) { c.st = st; c.stT = 0; }
    c.next = ctx.clock.t + 0.6 + hashOf(c.id, Math.floor(ctx.clock.t)) * 1.2;
  }

  /** Full behaviour (inside the loaded area). */
  private detailedStep(c: Creature, dt: number, ctx: WildlifeContext): void {
    const def = SPECIES[c.sp], q = ctx.q, t = ctx.clock.t;
    this.needs(c, dt);
    c.stT += dt;
    if (t >= c.next || c.st === 'idle') this.decide(c, ctx);
    // Tired animals slow down; so do wounded ones (a hunter can run down a badly hurt deer or wolf).
    const run = def.run * (c.stamina > 0.15 ? 1 : 0.45) * (0.5 + 0.5 * Math.min(1, c.hp / CREATURE_COMBAT[c.sp].hp));
    switch (c.st) {
      case 'flee': {
        const away = Math.atan2(c.y - c.ty, c.x - c.tx);
        if (c.sp === 'bird') { c.alt = Math.min(22, c.alt + dt * 8); c.x += Math.cos(away) * run * dt; c.y += Math.sin(away) * run * dt; c.h = away; }
        else walkToward(c, c.x + Math.cos(away) * 10, c.y + Math.sin(away) * 10, run, dt, q);
        break;
      }
      case 'hunt': {
        const prey = c.target ? this.creatures.get(c.target) : null;
        if (!prey || !prey.alive) { this.set(c, 'wander', ctx); break; }
        if (prey.sp === 'bird' && prey.alt > 1) { this.set(c, 'wander', ctx); break; }
        walkToward(c, prey.x, prey.y, run, dt, q);
        if (Math.hypot(prey.x - c.x, prey.y - c.y) < 1.6) {
          prey.alive = false; prey.diedAt = t; prey.st = 'dead'; this.stats.kills++;
          ctx.onKill?.(prey, c.id);
          // The pack shares the kill.
          for (const m of this.creatures.values()) if (m.group === c.group && m.alive && Math.hypot(m.x - c.x, m.y - c.y) < 80) { m.st = 'eat'; m.stT = 0; m.tx = prey.x; m.ty = prey.y; m.target = prey.id; }
        }
        break;
      }
      case 'eat': {
        if (Math.hypot(c.tx - c.x, c.ty - c.y) > 1.5) walkToward(c, c.tx, c.ty, def.walk * 2, dt, q);
        else c.hunger = Math.max(0, c.hunger - dt / 25);
        if (c.stT > 35 || c.hunger <= 0) this.set(c, 'rest', ctx);
        break;
      }
      case 'fight': {
        const cc = CREATURE_COMBAT[c.sp], foe = c.foe ? ctx.players?.get(c.foe) : null;
        if (!foe || !foe.alive || Math.hypot(foe.x - c.x, foe.y - c.y) > 50) { c.foe = null; this.set(c, 'wander', ctx); c.tx = c.homeX; c.ty = c.homeY; break; }
        if (c.hp < cc.hp * cc.fleeAt) { c.foe = null; c.tx = foe.x; c.ty = foe.y; this.set(c, 'flee', ctx); break; }
        const d = Math.hypot(foe.x - c.x, foe.y - c.y);
        if (d > cc.reach * 0.8) walkToward(c, foe.x, foe.y, run * 0.85, dt, q);
        c.h = Math.atan2(foe.y - c.y, foe.x - c.x);
        if (d <= cc.reach + 0.5 && t >= c.atkT) { c.atkT = t + cc.cd * (0.9 + hashOf(c.id, Math.floor(t)) * 0.2); ctx.onBite?.(c, foe.id); }
        break;
      }
      case 'charge': {
        walkToward(c, c.tx, c.ty, run, dt, q);
        if (Math.hypot(c.tx - c.x, c.ty - c.y) < 3 || c.stT > 6) { c.alert = 2; this.set(c, 'wander', ctx); c.tx = c.homeX; c.ty = c.homeY; }
        break;
      }
      case 'drink': {
        if (!c.water) { this.set(c, 'wander', ctx); break; }
        if (Math.hypot(c.water[0] - c.x, c.water[1] - c.y) > 1.5) { if (!walkToward(c, c.water[0], c.water[1], def.walk * 1.5, dt, q) && c.stT > 20) this.set(c, 'wander', ctx); }
        else { c.thirst = Math.max(0, c.thirst - dt / 6); if (c.thirst <= 0.02) this.set(c, 'graze', ctx); }
        break;
      }
      case 'graze': case 'wander': case 'follow': {
        if (c.sp === 'bird' && c.st !== 'graze') { this.flyToward(c, c.tx, c.ty, def.run * 0.6, dt); break; }
        const sp = c.st === 'graze' ? def.walk * 0.4 : def.walk;
        if (Math.hypot(c.tx - c.x, c.ty - c.y) > 1) walkToward(c, c.tx, c.ty, sp, dt, q);
        if (c.sp === 'bird') c.alt = Math.max(0, c.alt - dt * 6);
        if (c.st === 'graze') c.hunger = Math.max(0, c.hunger - dt / 90);
        break;
      }
      case 'sleep': case 'rest':
        if (c.sp === 'bird') c.alt = Math.max(0, c.alt - dt * 6);
        break;
      default: break;
    }
    if (c.sp !== 'bird' && q.water(c.x, c.y)) { // swept into water: back to the nearest bank direction (home)
      walkToward(c, c.homeX, c.homeY, def.walk, dt, q, true);
    }
  }

  private flyToward(c: Creature, tx: number, ty: number, speed: number, dt: number): void {
    const d = Math.hypot(tx - c.x, ty - c.y);
    c.alt += ((d > 6 ? 14 : 0) - c.alt) * Math.min(1, dt * 1.5);
    if (d < 0.5) return;
    const s = Math.min(d, speed * dt);
    c.h = Math.atan2(ty - c.y, tx - c.x); c.x += Math.cos(c.h) * s; c.y += Math.sin(c.h) * s;
  }

  /** Choose what to do now. */
  private decide(c: Creature, ctx: WildlifeContext): void {
    const def = SPECIES[c.sp], h = ctx.clock.hour, near = ctx.hash.near(c.x, c.y, def.sight, this.scratch);
    const r = rngOf(c.id, Math.floor(ctx.clock.t * 4));
    const asleep = c.st === 'sleep';
    // 1. Threats (sleeping animals notice only close ones).
    let threat: Agent | null = null, td = Infinity;
    for (const a of near) {
      if (!a.alive || a.id === c.id) continue;
      const fearTag = a.kind === 'creature' ? a.tag : a.kind;
      if (!def.fears.includes(fearTag)) continue;
      if (a.kind === 'dragon' && a.alt > 70) continue; // a dragon high overhead is not a threat yet
      const d = Math.hypot(a.x - c.x, a.y - c.y), lim = (a.kind === 'dragon' ? def.flee * 2.5 : def.flee) * (asleep ? 0.5 : 1);
      if (d < lim && d < td) { threat = a; td = d; }
    }
    if (threat && c.st !== 'fight') {
      // Territorial animals stand their ground against intruders they do not fear enough.
      c.tx = threat.x; c.ty = threat.y; c.alert = 1.5;
      this.set(c, 'flee', ctx);
      if (c.sp === 'bird') for (const m of this.creatures.values()) if (m.group === c.group && m.alive && m.st !== 'flee') { m.st = 'flee'; m.stT = 0; m.tx = threat.x; m.ty = threat.y; m.alert = 1; }
      return;
    }
    if (c.st === 'flee' && c.stT < 3) return;
    if (c.st === 'fight' && c.foe) return;
    // Wolves on the prowl at night, or hungry, go for a lone traveller who comes close (the pack with them).
    if (c.sp === 'wolf' && (!inHours(h, 5.5, 19.5) || c.hunger > 0.75)) {
      for (const a of near) if (a.kind === 'player' && a.alive && Math.hypot(a.x - c.x, a.y - c.y) < 18) {
        this.engage(c, a.id, ctx.clock);
        for (const m of this.creatures.values()) if (m.group === c.group && m.alive && m !== c && Math.hypot(m.x - c.x, m.y - c.y) < 60) this.engage(m, a.id, ctx.clock);
        return;
      }
    }
    if (c.st === 'eat' || (c.st === 'charge' && c.stT < 6) || (c.st === 'drink' && c.water)) return;
    if (c.st === 'hunt' && c.target && c.stT < 40) return;
    // 2. Territory: bears charge intruders near them; wolves confront intruders near the den.
    if (def.territory > 0) {
      const centreX = c.sp === 'wolf' ? c.homeX : c.x, centreY = c.sp === 'wolf' ? c.homeY : c.y;
      for (const a of near) {
        if (!a.alive || a.kind === 'dragon') continue;
        const intruder = a.kind === 'player' || a.kind === 'villager' || (a.kind === 'creature' && (a.tag === 'wolf' || a.tag === 'bear') && a.tag !== c.sp);
        if (intruder && Math.hypot(a.x - centreX, a.y - centreY) < def.territory) {
          if (a.kind === 'player') { this.engage(c, a.id, ctx.clock); return; } // players get a real fight
          c.tx = a.x; c.ty = a.y; c.alert = 2.5; this.set(c, 'charge', ctx); return;
        }
      }
    }
    // 3. Sleep outside active hours or when exhausted (birds roost, others bed down).
    if (!inHours(h, def.active[0], def.active[1]) || c.energy < 0.12) { this.set(c, 'sleep', ctx); return; }
    if (asleep && c.energy < 0.5 && r() < 0.6) return;
    // 4. Thirst.
    if (c.thirst > 0.65 && c.sp !== 'bird') {
      if (!c.water || Math.hypot(c.water[0] - c.x, c.water[1] - c.y) > 400) c.water = this.findWater(c, ctx.q);
      if (c.water) { this.set(c, 'drink', ctx); return; }
    }
    // 5. Hunger: predators hunt, grazers graze.
    if (c.hunger > 0.55 && def.prey.length) {
      let best: Creature | null = null, bd = Infinity;
      for (const a of near) {
        if (a.kind !== 'creature' || !a.alive || !def.prey.includes(a.tag as Species)) continue;
        const p = a as Creature;
        if (p.sp === 'bird' && p.alt > 1) continue;
        const d = Math.hypot(a.x - c.x, a.y - c.y);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) { c.target = best.id; c.alert = 1; this.set(c, 'hunt', ctx); for (const m of this.creatures.values()) if (m.group === c.group && m !== c && m.alive && m.st !== 'eat') { m.st = 'hunt'; m.stT = 0; m.target = best.id; } return; }
    }
    // 6. Herds, packs and flocks stay together: followers drift toward the leader.
    if (!c.leader) {
      let lead: Creature | undefined;
      for (const m of this.creatures.values()) if (m.group === c.group && m.leader && m.alive) { lead = m; break; }
      if (lead && Math.hypot(lead.x - c.x, lead.y - c.y) > 14) { c.tx = lead.x + (r() - 0.5) * 8; c.ty = lead.y + (r() - 0.5) * 8; this.set(c, c.sp === 'bird' ? 'wander' : 'follow', ctx); return; }
    }
    // 7. Graze, wander (within the home range), or idle.
    const far = Math.hypot(c.homeX - c.x, c.homeY - c.y) > SPECIES[c.sp].range;
    const roll = r();
    if (far || roll < 0.35) {
      const a = r() * Math.PI * 2, d = 10 + r() * 40, bx = far ? c.homeX : c.x, by = far ? c.homeY : c.y;
      c.tx = bx + Math.cos(a) * d; c.ty = by + Math.sin(a) * d;
      this.set(c, 'wander', ctx);
    } else if (roll < 0.8 && c.sp !== 'wolf' && c.sp !== 'bear') { c.tx = c.x + (r() - 0.5) * 6; c.ty = c.y + (r() - 0.5) * 6; this.set(c, 'graze', ctx); }
    else this.set(c, c.energy < 0.4 ? 'rest' : 'graze', ctx);
  }

  /** Nearest water in rings out to 300 m (a dry standing spot beside it). */
  private findWater(c: Creature, q: TerrainQuery): [number, number] | null {
    for (let r = 8; r <= 300; r += 8) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r;
        if (!q.water(x, y)) continue;
        // Step back toward the creature until dry.
        for (let b = 1; b <= 6; b++) { const sx = x - Math.cos(a) * b, sy = y - Math.sin(a) * b; if (q.walkable(sx, sy)) return [sx, sy]; }
      }
    }
    return null;
  }

  /** Cheap update for creatures near a player but outside the loaded area. */
  private coarseStep(c: Creature, dt: number, ctx: WildlifeContext): void {
    this.needs(c, dt);
    c.stT += dt;
    const def = SPECIES[c.sp];
    if (!inHours(ctx.clock.hour, def.active[0], def.active[1])) { c.st = 'sleep'; c.alt = 0; c.energy = Math.min(1, c.energy + dt / 240); return; }
    if (c.hunger > 0.6) c.hunger = Math.max(0.2, c.hunger - dt / 60); // foraging off-screen
    if (c.thirst > 0.7) c.thirst = 0.1;
    if (ctx.clock.t >= c.next) {
      const r = rngOf(c.id, Math.floor(ctx.clock.t));
      const a = r() * Math.PI * 2, d = r() * def.range * 0.6;
      c.tx = c.homeX + Math.cos(a) * d; c.ty = c.homeY + Math.sin(a) * d; c.st = 'wander';
      c.next = ctx.clock.t + 20 + r() * 40;
    }
    const d = Math.hypot(c.tx - c.x, c.ty - c.y);
    if (d > 1) { const s = Math.min(d, def.walk * dt); c.h = Math.atan2(c.ty - c.y, c.tx - c.x); const nx = c.x + Math.cos(c.h) * s, ny = c.y + Math.sin(c.h) * s; if (!ctx.q.water(nx, ny)) { c.x = nx; c.y = ny; } }
    c.alt = 0;
  }

  // ------------------------------------------------------------------ persistence
  toJSON(): { spawned: string[]; creatures: Array<[string, number, number, number, number, number, number, number]> } {
    const out: Array<[string, number, number, number, number, number, number, number]> = [];
    for (const c of this.creatures.values()) out.push([c.id, Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10, c.alive ? 1 : 0, Math.round(c.hunger * 100) / 100, Math.round(c.thirst * 100) / 100, Math.round(c.energy * 100) / 100, Math.round(c.diedAt)]);
    return { spawned: [...this.spawned], creatures: out };
  }

  /** Restore after the same cells have been spawned again: identities match, state comes from the save. */
  load(j: unknown, ctx: WildlifeContext): string[] {
    const warn: string[] = [];
    if (!j || typeof j !== 'object') return warn;
    const s = j as ReturnType<Wildlife['toJSON']>;
    if (!Array.isArray(s.spawned) || !Array.isArray(s.creatures)) return ['Wildlife data unreadable; creatures start fresh.'];
    this.creatures.clear(); this.spawned.clear();
    for (const k of s.spawned) {
      const m = /^(-?\d+),(-?\d+)$/.exec(String(k));
      if (!m) continue;
      this.spawned.add(k);
      this.spawnCell(+m[1], +m[2], ctx);
    }
    let missing = 0;
    for (const row of s.creatures) {
      if (!Array.isArray(row) || row.length < 8) continue;
      const c = this.creatures.get(String(row[0]));
      if (!c) { missing++; continue; }
      const [, x, y, alive, hu, th, en, died] = row as number[];
      if ([x, y, hu, th, en].some((v) => !Number.isFinite(v))) continue;
      c.x = x; c.y = y; c.alive = alive === 1; c.hunger = hu; c.thirst = th; c.energy = en; c.diedAt = Number.isFinite(died) ? died : -1;
      c.st = c.alive ? 'idle' : 'dead'; c.tx = x; c.ty = y; c.hp = CREATURE_COMBAT[c.sp].hp; c.foe = null;
    }
    if (missing) warn.push(`${missing} saved creatures no longer exist in this world version.`);
    return warn;
  }
}
