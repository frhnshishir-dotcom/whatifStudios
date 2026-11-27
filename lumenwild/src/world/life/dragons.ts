import { type Agent, type LifeClock, type TerrainQuery, SpatialHash, rngOf, inHours, wrapAngle } from './core';
import type { Creature } from './wildlife';

/**
 * The five dragons of the continent, each with a nest and territory (world/dragons/territories.json), hunting
 * grounds (habitats), and the flight-route rules (world/dragons/flight-routes.json): corridors between territories,
 * clearance above the ground, and at least 450 m above the ground within 2.5 km of a village.
 *
 * Each dragon decides for itself from its needs (hunger, thirst, energy), the time of day and what it senses:
 * sleep at the nest at night; take off; patrol the territory; fly to the hunting grounds, find prey, dive and feed;
 * drink at the nearest water; rest at landing sites; sometimes migrate along a migration route through the Southern
 * Sky Corridor and back; defend the nest against a player who comes close; look over travellers it notices.
 * Flight is steered in 3D (turn rate, climb and dive rates, terrain clearance), not scripted paths.
 */

export type DState = 'sleep' | 'rest' | 'takeoff' | 'patrol' | 'hunt' | 'dive' | 'feed' | 'drink' | 'migrate' | 'land' | 'defend' | 'inspect';

export interface Territory { id: string; name: string; x: number; y: number; r: number; nestX: number; nestY: number; alt: [number, number]; awareness: number; hunting: Array<[number, number]> }

export interface DragonAgent extends Agent {
  kind: 'dragon';
  name: string;
  species: string;
  size: string;
  home: string;
  /** Absolute height (m); alt (Agent) is height above the ground. */
  z: number;
  h: number; v: number; vz: number; turn: number;
  st: DState; stT: number; next: number;
  tx: number; ty: number; tz: number;
  /** Waypoints for travel (migration), next first. */
  route: Array<[number, number]>;
  /** Where the current migration ends before heading home. */
  away: string | null;
  hunger: number; thirst: number; energy: number;
  /** Who it is watching (player id) and how long it has. */
  watch: string | null;
  prey: string | null;
  boldness: number; wanderlust: number;
}

export interface DragonContext {
  q: TerrainQuery;
  clock: LifeClock;
  hash: SpatialHash;
  territories: Territory[];
  corridor: { x: number; y: number; r: number; alt: [number, number] } | null;
  migrationRoutes: string[][];
  villages: Array<{ x: number; y: number }>;
  /** Flight rules. */
  clearance: number; settlementMinAGL: number; noLowFlightRadius: number;
  /** Ground height anywhere (smooth outside the loaded area). */
  ground(x: number, y: number): number;
  /** A creature caught (wildlife removes it). */
  kill?(c: Creature, by: DragonAgent): void;
  creatures?: Map<string, Creature>;
  /** Creatures within r of a point (the wildlife's region index); without it, the whole map is scanned. */
  creaturesNear?(x: number, y: number, r: number): Creature[];
  players: Agent[];
}

const SPEED: Record<string, number> = { patrol: 22, hunt: 26, migrate: 42, inspect: 24, defend: 26, dive: 48, takeoff: 12, land: 10 };

export class Dragons {
  readonly dragons: DragonAgent[] = [];
  readonly log: string[] = [];
  readonly stats = { flying: 0, ms: 0, kills: 0 };

  /** Five dragons at their nests, needs and personalities from the seed; one already on its way somewhere. */
  init(ctx: DragonContext, seed: number, startNear: { x: number; y: number } | null): void {
    this.dragons.length = 0;
    for (const t of ctx.territories) {
      const r = rngOf('dragon', seed, t.id), meta = DRAGON_META[t.id];
      if (!meta) continue;
      const gz = ctx.ground(t.nestX, t.nestY);
      this.dragons.push({
        id: meta.id, kind: 'dragon', tag: 'dragon', name: meta.name, species: meta.species, size: meta.size, home: t.id,
        x: t.nestX, y: t.nestY, z: gz, alt: 0, alive: true, h: r() * 6.28, v: 0, vz: 0, turn: 0,
        st: 'rest', stT: 0, next: 0, tx: t.x, ty: t.y, tz: gz, route: [], away: null,
        hunger: 0.2 + r() * 0.4, thirst: 0.1 + r() * 0.4, energy: 0.6 + r() * 0.3, watch: null, prey: null, boldness: 0.3 + r() * 0.6, wanderlust: 0.3 + r() * 0.6,
      });
    }
    // One dragon is already travelling the corridor (initial conditions, not a script: it decides everything after).
    const traveller = this.dragons.find((d) => d.home === 'territory-ember-nest') ?? this.dragons[0];
    if (traveller && ctx.corridor) {
      const via = startNear && Math.hypot(startNear.x - ctx.corridor.x, startNear.y - ctx.corridor.y) < ctx.corridor.r * 1.6 ? startNear : ctx.corridor;
      const home = ctx.territories.find((t) => t.id === traveller.home)!;
      const dx = via.x - home.nestX, dy = via.y - home.nestY, L = Math.hypot(dx, dy) || 1;
      traveller.x = via.x - (dx / L) * 6500; traveller.y = via.y - (dy / L) * 6500;
      traveller.z = ctx.ground(traveller.x, traveller.y) + 500; traveller.h = Math.atan2(dy, dx); traveller.v = SPEED.migrate;
      const dest = ctx.territories.find((t) => t.id === 'territory-frozen-crown') ?? home;
      traveller.route = [[via.x, via.y], [dest.x, dest.y]]; traveller.away = dest.id; traveller.st = 'migrate';
      this.log.push(`${traveller.name} is crossing the Southern Sky Corridor.`);
    }
  }

  update(dt: number, ctx: DragonContext): void {
    const t0 = performance.now();
    let flying = 0;
    for (const d of this.dragons) {
      this.needs(d, dt);
      d.stT += dt;
      if (ctx.clock.t >= d.next) this.decide(d, ctx);
      this.fly(d, dt, ctx);
      if (d.alt > 1) flying++;
    }
    this.stats.flying = flying; this.stats.ms = performance.now() - t0;
  }

  private needs(d: DragonAgent, dt: number): void {
    const air = d.alt > 1;
    d.hunger = Math.min(1, d.hunger + dt / 1100);
    d.thirst = Math.min(1, d.thirst + dt / 900);
    d.energy = Math.max(0, Math.min(1, d.energy + (d.st === 'sleep' ? dt / 200 : d.st === 'rest' ? dt / 400 : air ? -dt / 1800 : 0)));
    if (d.st === 'feed') d.hunger = Math.max(0, d.hunger - dt / 30);
    if (d.st === 'drink') d.thirst = Math.max(0, d.thirst - dt / 15);
  }

  private territory(d: DragonAgent, ctx: DragonContext): Territory { return ctx.territories.find((t) => t.id === d.home)!; }

  private set(d: DragonAgent, st: DState, ctx: DragonContext, why = ''): void {
    if (d.st !== st) { d.st = st; d.stT = 0; if (why) { this.log.push(`${d.name}: ${why}`); if (this.log.length > 40) this.log.shift(); } }
    d.next = ctx.clock.t + 1.5 + rngOf(d.id, Math.floor(ctx.clock.t))() * 1.5;
  }

  /** Minimum height above the ground here (flight rules). */
  private floor(x: number, y: number, ctx: DragonContext): number {
    for (const v of ctx.villages) if (Math.hypot(v.x - x, v.y - y) < ctx.noLowFlightRadius) return ctx.settlementMinAGL;
    return 30;
  }

  private decide(d: DragonAgent, ctx: DragonContext): void {
    const T = this.territory(d, ctx), h = ctx.clock.hour, r = rngOf(d.id, Math.floor(ctx.clock.t / 2));
    const onGround = d.alt <= 1, night = inHours(h, 21, 5);
    const atNest = Math.hypot(d.x - T.nestX, d.y - T.nestY) < 40;
    // Nest defence: a player near the nest.
    const intruder = ctx.players.find((p) => Math.hypot(p.x - T.nestX, p.y - T.nestY) < T.awareness * 0.5);
    if (intruder && d.st !== 'migrate') { d.watch = intruder.id; if (onGround) this.takeoff(d, ctx, 'leaves the nest to drive off an intruder'); else this.set(d, 'defend', ctx, 'defends its nest'); return; }
    // Travellers below on a migration: circle over a player for a while, then carry on.
    if (d.st === 'migrate' && !d.watch) {
      const p = ctx.players.find((q) => Math.hypot(q.x - d.x, q.y - d.y) < 700);
      if (p && d.boldness > 0.35) { d.watch = p.id; this.set(d, 'inspect', ctx, 'circles over a traveller'); return; }
    }
    if (d.st === 'inspect' && d.stT < 45) return;
    if (d.st === 'inspect') { this.set(d, 'migrate', ctx, 'flies on'); return; }
    if (d.st === 'defend') { if (!intruder || d.stT > 90) { d.watch = null; this.set(d, 'patrol', ctx); } return; }
    if (d.st === 'dive' || d.st === 'land' || d.st === 'takeoff' || d.st === 'feed' && d.stT < 30 || d.st === 'drink' && d.stT < 15) return;
    if (d.st === 'migrate' && d.route.length) return;
    if (d.st === 'migrate' && !d.route.length) {
      // Arrived: rest at the destination, or home.
      this.land(d, d.x + 40, d.y, ctx, d.away ? `rests at ${ctx.territories.find((t) => t.id === d.away)?.name ?? 'a far place'}` : 'is home');
      return;
    }
    // Night: home to sleep.
    if (night || d.energy < 0.15) {
      if (onGround && atNest) { this.set(d, 'sleep', ctx, d.st !== 'sleep' ? 'sleeps at the nest' : ''); return; }
      if (onGround) { this.takeoff(d, ctx, 'heads home for the night'); return; }
      if (Math.hypot(d.x - T.nestX, d.y - T.nestY) < 60) { this.land(d, T.nestX, T.nestY, ctx, 'lands at the nest'); return; }
      d.tx = T.nestX; d.ty = T.nestY; d.tz = ctx.ground(T.nestX, T.nestY) + T.alt[0]; this.set(d, 'patrol', ctx); return;
    }
    if (d.st === 'sleep' && d.energy < 0.7) return;
    if (d.st === 'rest' && d.stT < 60 + r() * 120 && d.energy < 0.9) return;
    // Thirst: the nearest water near the territory.
    if (d.thirst > 0.7) {
      const w = this.findWater(d, ctx);
      if (w) { if (onGround && Math.hypot(w[0] - d.x, w[1] - d.y) < 30) { this.set(d, 'drink', ctx, 'drinks'); return; } this.land(d, w[0], w[1], ctx, 'goes to drink', 'drink'); if (onGround) this.takeoff(d, ctx); return; }
    }
    // Hunger: the hunting grounds; dive on prey it sees.
    if (d.hunger > 0.55) {
      if (onGround) { this.takeoff(d, ctx, 'takes off to hunt'); return; }
      const prey = this.spotPrey(d, ctx);
      if (prey) { d.prey = prey.id; this.set(d, 'dive', ctx, `dives on a ${prey.sp}`); return; }
      const g = T.hunting[Math.floor(r() * T.hunting.length)] ?? [T.x, T.y];
      if (d.st !== 'hunt' || Math.hypot(d.tx - d.x, d.ty - d.y) < 150) { d.tx = g[0] + (r() - 0.5) * 2000; d.ty = g[1] + (r() - 0.5) * 2000; d.tz = ctx.ground(d.tx, d.ty) + 140; }
      // Prey that is not simulated near anyone: a successful hunt now and then.
      if (d.st === 'hunt' && d.stT > 90 && r() < 0.3) { this.land(d, d.x, d.y, ctx, 'catches a mountain goat', 'feed'); return; }
      this.set(d, 'hunt', ctx, d.st !== 'hunt' ? 'hunts' : '');
      return;
    }
    // Wanderlust: migrate through the corridor.
    if (!onGround && d.energy > 0.6 && d.st === 'patrol' && d.stT > 240 && r() < d.wanderlust * 0.15) {
      const route = ctx.migrationRoutes.find((rt) => rt[0] === d.home) ?? ctx.migrationRoutes.find((rt) => rt.includes(d.home));
      if (route) {
        const pts = route.filter((id) => id !== d.home).map((id) => ctx.territories.find((t) => t.id === id) ?? (id.includes('corridor') && ctx.corridor ? { x: ctx.corridor.x, y: ctx.corridor.y } : null)).filter(Boolean) as Array<{ x: number; y: number }>;
        d.route = pts.map((p) => [p.x, p.y]); d.away = route[route.length - 1] === d.home ? route[0] : route[route.length - 1];
        this.set(d, 'migrate', ctx, 'sets off on a migration'); return;
      }
    }
    // Otherwise patrol the territory (landing at a rest spot now and then).
    if (onGround) { if (r() < 0.5) this.takeoff(d, ctx, 'takes off'); else this.set(d, 'rest', ctx); return; }
    if (d.st === 'patrol' && d.stT > 200 && r() < 0.25) { const a = r() * 6.28; this.land(d, T.x + Math.cos(a) * T.r * 0.4, T.y + Math.sin(a) * T.r * 0.4, ctx, 'lands to rest'); return; }
    if (d.st !== 'patrol' || Math.hypot(d.tx - d.x, d.ty - d.y) < 200) {
      const a = r() * 6.28, rr = T.r * (0.3 + r() * 0.6);
      d.tx = T.x + Math.cos(a) * rr; d.ty = T.y + Math.sin(a) * rr; d.tz = ctx.ground(d.tx, d.ty) + T.alt[0] + r() * (T.alt[1] - T.alt[0]) * 0.5;
    }
    this.set(d, 'patrol', ctx, d.st !== 'patrol' ? 'patrols its territory' : '');
  }

  private takeoff(d: DragonAgent, ctx: DragonContext, why = ''): void { d.vz = 6; this.set(d, 'takeoff', ctx, why); }

  /** Head for a spot and land there (then rest, drink or feed). */
  private land(d: DragonAgent, x: number, y: number, ctx: DragonContext, why = '', then: DState = 'rest'): void {
    d.tx = x; d.ty = y; d.tz = ctx.ground(x, y); d.route = [];
    (d as DragonAgent & { then?: DState }).then = then;
    this.set(d, 'land', ctx, why);
  }

  private spotPrey(d: DragonAgent, ctx: DragonContext): Creature | null {
    if (!ctx.creatures) return null;
    let best: Creature | null = null, bd = 260;
    for (const c of ctx.creaturesNear ? ctx.creaturesNear(d.x, d.y, 260) : ctx.creatures.values()) {
      if (!c.alive || c.tier !== 0 || (c.sp !== 'deer' && c.sp !== 'bear' && c.sp !== 'wolf')) continue;
      const dd = Math.hypot(c.x - d.x, c.y - d.y);
      if (dd < bd) { bd = dd; best = c; }
    }
    return best;
  }

  private findWater(d: DragonAgent, ctx: DragonContext): [number, number] | null {
    const T = this.territory(d, ctx);
    for (let r = 100; r <= T.r * 1.5; r += 150) for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 6.28, x = T.x + Math.cos(a) * r, y = T.y + Math.sin(a) * r;
      if (ctx.q.water(x, y)) for (let b = 4; b < 60; b += 4) { const sx = x - Math.cos(a) * b, sy = y - Math.sin(a) * b; if (!ctx.q.water(sx, sy)) return [sx, sy]; }
    }
    return null;
  }

  /** 3D steering toward the current target, with terrain clearance and the flight rules. */
  private fly(d: DragonAgent, dt: number, ctx: DragonContext): void {
    const gz = ctx.ground(d.x, d.y);
    const watch = d.watch ? ctx.players.find((p) => p.id === d.watch) : null;
    let tx = d.tx, ty = d.ty, tz = d.tz, speed = SPEED[d.st] ?? 0;
    switch (d.st) {
      case 'sleep': case 'rest': case 'feed': case 'drink':
        d.v = 0; d.vz = 0; d.z = gz; d.alt = 0;
        return;
      case 'takeoff':
        d.vz = 8; d.z += d.vz * dt; d.v = Math.min(18, d.v + dt * 6);
        d.x += Math.cos(d.h) * d.v * dt; d.y += Math.sin(d.h) * d.v * dt;
        d.alt = d.z - gz;
        if (d.alt > 45) this.set(d, 'patrol', ctx);
        return;
      case 'migrate': {
        const wp = d.route[0];
        if (wp) { tx = wp[0]; ty = wp[1]; if (Math.hypot(tx - d.x, ty - d.y) < 400) d.route.shift(); }
        tz = gz + Math.max(ctx.clearance, ctx.corridor?.alt[0] ?? 450);
        break;
      }
      case 'inspect': case 'defend':
        if (watch) { const a = ctx.clock.t * 0.35 + d.x * 0; tx = watch.x + Math.cos(a) * 90; ty = watch.y + Math.sin(a) * 90; tz = gz + (d.st === 'defend' ? 60 : 160); }
        break;
      case 'dive': {
        const prey = d.prey ? ctx.creatures?.get(d.prey) : null;
        if (!prey || !prey.alive) { this.set(d, 'hunt', ctx); return; }
        tx = prey.x; ty = prey.y; tz = ctx.ground(prey.x, prey.y) + 1;
        if (Math.hypot(prey.x - d.x, prey.y - d.y) < 6 && d.z - tz < 6) {
          prey.alive = false; prey.st = 'dead'; prey.diedAt = ctx.clock.t; this.stats.kills++;
          ctx.kill?.(prey, d);
          d.z = ctx.ground(d.x, d.y); d.alt = 0; d.v = 0; this.set(d, 'feed', ctx, `catches a ${prey.sp}`);
          return;
        }
        break;
      }
      case 'land': {
        const dist = Math.hypot(d.tx - d.x, d.ty - d.y);
        speed = Math.max(6, Math.min(30, dist * 0.25));
        tz = dist > 300 ? ctx.ground(d.tx, d.ty) + 120 : ctx.ground(d.tx, d.ty) + Math.max(0, dist * 0.3);
        if (dist < 8 && d.z - ctx.ground(d.tx, d.ty) < 4) {
          d.z = ctx.ground(d.x, d.y); d.alt = 0; d.v = 0;
          const then = (d as DragonAgent & { then?: DState }).then ?? 'rest';
          this.set(d, then, ctx);
          return;
        }
        break;
      }
      default: break;
    }
    // Steering: turn toward the target at a limited rate; climb or descend toward the target height.
    const want = Math.atan2(ty - d.y, tx - d.x), diff = wrapAngle(want - d.h);
    const maxTurn = 0.7 * dt;
    d.turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
    d.h = wrapAngle(d.h + d.turn);
    d.v += (speed - d.v) * Math.min(1, dt * 0.8);
    d.x += Math.cos(d.h) * d.v * dt; d.y += Math.sin(d.h) * d.v * dt;
    const floor = d.st === 'dive' || d.st === 'land' ? 0 : this.floor(d.x, d.y, ctx);
    const target = Math.max(tz, ctx.ground(d.x, d.y) + floor);
    const climb = d.st === 'dive' ? 30 : 10;
    d.vz = Math.max(-climb, Math.min(climb, (target - d.z) * 0.6));
    d.z += d.vz * dt;
    const g2 = ctx.ground(d.x, d.y);
    if (d.z < g2 + 1 && d.st !== 'land' && d.st !== 'dive') d.z = g2 + 1;
    d.alt = Math.max(0, d.z - g2);
  }

  toJSON(): Array<Record<string, unknown>> {
    return this.dragons.map((d) => ({ id: d.id, x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z), h: +d.h.toFixed(3), st: d.st, route: d.route, away: d.away, hunger: +d.hunger.toFixed(3), thirst: +d.thirst.toFixed(3), energy: +d.energy.toFixed(3) }));
  }

  load(j: unknown): string[] {
    if (!Array.isArray(j)) return [];
    let n = 0;
    for (const s of j as Array<Record<string, unknown>>) {
      const d = this.dragons.find((q) => q.id === s.id);
      if (!d) continue;
      const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
      d.x = num(s.x, d.x); d.y = num(s.y, d.y); d.z = num(s.z, d.z); d.h = num(s.h, d.h);
      d.hunger = num(s.hunger, d.hunger); d.thirst = num(s.thirst, d.thirst); d.energy = num(s.energy, d.energy);
      const st = String(s.st) as DState;
      d.st = ['sleep', 'rest', 'feed', 'drink'].includes(st) ? st : st === 'land' || st === 'dive' || st === 'takeoff' ? 'patrol' : (['patrol', 'hunt', 'migrate', 'defend', 'inspect'].includes(st) ? st : 'patrol');
      d.route = Array.isArray(s.route) ? (s.route as Array<[number, number]>).filter((p) => Array.isArray(p) && p.length === 2) : [];
      d.away = typeof s.away === 'string' ? s.away : null; d.stT = 0; d.next = 0; d.watch = null;
      n++;
    }
    return n === this.dragons.length ? [] : ['Some saved dragons were not found; they start at their nests.'];
  }
}

/** The resident dragon of each nest territory (names and species from world/dragons/territories.json). */
export const DRAGON_META: Record<string, { id: string; name: string; species: string; size: string }> = {};
