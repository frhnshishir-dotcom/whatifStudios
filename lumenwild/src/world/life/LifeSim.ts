import type { Blueprint } from '../blueprint';
import type { ContinentTerrain } from '../terrain';
import { regionAt } from '../blueprint';
import { createDiscovery, observe, reveal, serializeDiscovery, deserializeDiscovery, type DiscoveryState } from '../discovery';
import { type Agent, type LifeClock, type TerrainQuery, SpatialHash, walkToward } from './core';
import { Wildlife, type WildlifeContext, type Creature } from './wildlife';
import { Villages, type Villager } from './villagers';
import { Dragons, DRAGON_META, type DragonContext, type Territory } from './dragons';

/**
 * The living world: wildlife, villagers, dragons and players on the continent, stepped together. Everything is in
 * continent metres and reads the ground through a TerrainQuery (the loaded window in the browser; generated regions
 * on a server). Simulation follows the players: full detail in the loaded area, coarse nearby, dormant far away.
 */

export interface Player extends Agent {
  kind: 'player';
  name: string;
  h: number;
  /** Current speed (m/s), stamina 0..1 and whether running. */
  v: number; stamina: number; running: boolean;
  inv: Record<string, number>;
  /** Distance walked (m), for the journal. */
  walked: number;
}

export interface PlayerInput { dx: number; dy: number; run: boolean }

export const WALK = 4, RUN = 8;

export class LifeSim {
  readonly bp: Blueprint;
  readonly terrain: ContinentTerrain;
  readonly clock: LifeClock = { hour: 10, rain: 0, t: 0 };
  readonly hash = new SpatialHash(32);
  readonly wildlife: Wildlife;
  readonly villages = new Villages();
  readonly dragons = new Dragons();
  readonly players = new Map<string, Player>();
  discovery: DiscoveryState;
  /** Recent happenings (newest last), for the journal. */
  readonly log: Array<{ t: number; text: string }> = [];
  readonly stats = { tickMs: 0, wildlifeMs: 0, villagerMs: 0, dragonMs: 0, ticks: 0 };
  private wctx: WildlifeContext;
  private dctx: DragonContext;
  private acc = 0;
  private lastPopulate = -1e9;
  private lastObserve = -1e9;
  readonly villageInfo: Array<{ id: string; x: number; y: number; r: number }>;

  constructor(bp: Blueprint, terrain: ContinentTerrain, private q: TerrainQuery, seed = bp.data.world.seed) {
    this.bp = bp; this.terrain = terrain;
    const mpu = bp.coords.metresPerUnit, data = bp.data;
    this.wildlife = new Wildlife(seed);
    this.discovery = createDiscovery(data);
    this.villageInfo = data.settlements.map((s) => ({ id: s.id, x: s.at[0] * mpu, y: s.at[1] * mpu, r: s.footprintRadius * mpu }));
    this.wctx = {
      q, clock: this.clock, hash: this.hash,
      regionAt: (x, y) => regionAt(bp, x / mpu, y / mpu) ?? 'sea',
      habitats: data.habitats.map((h) => ({ x: h.at[0] * mpu, y: h.at[1] * mpu, r: h.radius * mpu, species: h.species })),
      villages: this.villageInfo,
      onKill: (prey, by) => this.note(`A ${by.split('-')[0]} brought down a ${prey.sp}.`, prey.x, prey.y),
    };
    const territories: Territory[] = [];
    let corridor: DragonContext['corridor'] = null;
    for (const t of data.territories) {
      if (t.kind === 'corridor') { corridor = { x: t.centre[0] * mpu, y: t.centre[1] * mpu, r: t.radius * mpu, alt: t.preferredAltitude }; continue; }
      if (!t.dragon || !t.nest) continue;
      DRAGON_META[t.id] = { id: t.dragon.id, name: t.dragon.name, species: t.dragon.species, size: t.dragon.size };
      const hunting = t.huntingGrounds.map((id) => data.habitats.find((h) => h.id === id)).filter(Boolean).map((h) => [h!.at[0] * mpu, h!.at[1] * mpu] as [number, number]);
      territories.push({ id: t.id, name: t.name, x: t.centre[0] * mpu, y: t.centre[1] * mpu, r: t.radius * mpu, nestX: t.nest[0] * mpu, nestY: t.nest[1] * mpu, alt: t.preferredAltitude, awareness: t.awarenessRadius * mpu, hunting });
    }
    const site = terrain.siteQuery();
    this.dctx = {
      q, clock: this.clock, hash: this.hash, territories, corridor, migrationRoutes: data.flight.migrationRoutes,
      villages: this.villageInfo, clearance: data.flight.clearance, settlementMinAGL: data.flight.settlementMinAGL, noLowFlightRadius: data.flight.noLowFlightRadius * mpu,
      ground: (x, y) => (q.detailed(x, y) ? q.height(x, y) : site.z(x, y)),
      creatures: this.wildlife.creatures, players: [],
      kill: (prey, d) => this.note(`${d.name} caught a ${prey.sp}.`, prey.x, prey.y),
    };
  }

  /** Swap the terrain query (the browser rebinds it when the window changes). */
  setQuery(q: TerrainQuery): void { this.q = q; this.wctx.q = q; this.dctx.q = q; }

  /** Start the world: dragons placed, the first player's surroundings populated. */
  start(first: { x: number; y: number } | null): void {
    this.dragons.init(this.dctx, this.bp.data.world.seed, first);
    for (const l of this.dragons.log.splice(0)) this.note(l);
  }

  addPlayer(id: string, name: string, x: number, y: number): Player {
    const p: Player = { id, kind: 'player', tag: 'player', name, x, y, alt: 0, alive: true, h: 0, v: 0, stamina: 1, running: false, inv: {}, walked: 0 };
    this.players.set(id, p);
    return p;
  }

  note(text: string, x?: number, y?: number): void {
    // Only what happens near a player (or world events without a place) goes in the journal.
    if (x !== undefined && y !== undefined && ![...this.players.values()].some((p) => Math.hypot(p.x - x, p.y - y) < 900)) return;
    this.log.push({ t: this.clock.t, text });
    if (this.log.length > 60) this.log.shift();
  }

  /** Move a player by input for dt seconds (walk, run with stamina, wade slowly, blocked by deep water and walls). */
  movePlayer(p: Player, inp: PlayerInput, dt: number): void {
    const want = Math.hypot(inp.dx, inp.dy) > 0.01;
    p.running = want && inp.run && p.stamina > 0.05;
    p.stamina = Math.max(0, Math.min(1, p.stamina + (p.running ? -dt / 22 : dt / 30)));
    if (!want) { p.v = 0; return; }
    const speed = p.running ? RUN : WALK, h = Math.atan2(inp.dy, inp.dx);
    const tx = p.x + Math.cos(h) * speed * dt * 4, ty = p.y + Math.sin(h) * speed * dt * 4;
    const moved = walkToward(p, tx, ty, speed, dt, this.q);
    p.h = h; p.v = moved / Math.max(1e-6, dt); p.walked += moved;
  }

  /**
   * Advance the world by dt simulated seconds. Wildlife and villagers tick at 10 Hz (budgeted); dragons every call.
   */
  update(dt: number, env: { hour: number; rain: number }): void {
    const t0 = performance.now();
    this.clock.hour = env.hour; this.clock.rain = env.rain;
    this.clock.t += dt;
    const focus = [...this.players.values()];
    this.dctx.players = focus;
    if (this.clock.t - this.lastPopulate > 2) {
      this.lastPopulate = this.clock.t;
      this.wildlife.populate(focus, this.wctx);
      for (const v of this.villageInfo) if (focus.some((p) => Math.hypot(p.x - v.x, p.y - v.y) < 2500)) this.villages.populate(this.terrain.village(v.id)!, this.q, this.clock);
    }
    this.acc += dt;
    const TICK = 0.1;
    let steps = 0;
    while (this.acc >= TICK && steps < 4) {
      this.acc -= TICK; steps++;
      this.rebuildHash(focus);
      const tw = performance.now();
      this.wildlife.update(TICK, focus, this.wctx);
      this.stats.wildlifeMs = performance.now() - tw;
      const tv = performance.now();
      const active = new Set(this.villageInfo.filter((v) => focus.some((p) => Math.hypot(p.x - v.x, p.y - v.y) < 1500)).map((v) => v.id));
      this.villages.update(TICK, active, { q: this.q, clock: this.clock, hash: this.hash });
      this.stats.villagerMs = performance.now() - tv;
      this.stats.ticks++;
    }
    if (steps === 4) this.acc = 0;
    const td = performance.now();
    this.dragons.update(dt, this.dctx);
    this.stats.dragonMs = performance.now() - td;
    for (const l of this.dragons.log.splice(0)) this.note(l);
    // Discovery: what players see around them (once a second).
    if (this.clock.t - this.lastObserve > 1) {
      this.lastObserve = this.clock.t;
      const mpu = this.bp.coords.metresPerUnit;
      for (const p of focus) for (const id of observe(this.bp.data, this.discovery, [p.x / mpu, p.y / mpu])) {
        const l = this.bp.data.landmarks.find((q) => q.id === id) ?? this.bp.data.settlements.find((q) => q.id === id);
        if (l) this.note(`Discovered: ${l.name}.`);
      }
    }
    this.stats.tickMs = performance.now() - t0;
  }

  private rebuildHash(focus: Player[]): void {
    const h = this.hash;
    h.clear();
    for (const p of focus) h.add(p);
    for (const c of this.wildlife.creatures.values()) if (c.alive && c.tier < 2) h.add(c);
    for (const v of this.villages.people.values()) if (v.out) h.add(v);
    for (const d of this.dragons.dragons) h.add(d);
  }

  /** Creatures, villagers and dragons within r of a point. */
  around(x: number, y: number, r: number): Agent[] { return this.hash.near(x, y, r, []); }

  /** Reveal around a high place (watchtowers). */
  revealFrom(x: number, y: number, radiusM: number): number {
    const mpu = this.bp.coords.metresPerUnit;
    return reveal(this.bp.data, this.discovery, [x / mpu, y / mpu], radiusM / mpu);
  }

  // ------------------------------------------------------------------ persistence
  toJSON(): Record<string, unknown> {
    return {
      t: this.clock.t,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, stamina: p.stamina, inv: p.inv, walked: p.walked })),
      discovery: serializeDiscovery(this.discovery),
      wildlife: this.wildlife.toJSON(),
      dragons: this.dragons.toJSON(),
      log: this.log.slice(-20),
    };
  }

  load(j: unknown): string[] {
    const warn: string[] = [];
    if (!j || typeof j !== 'object') return warn;
    const s = j as Record<string, unknown>;
    if (typeof s.t === 'number' && Number.isFinite(s.t)) this.clock.t = s.t;
    try { if (s.discovery) this.discovery = deserializeDiscovery(s.discovery as never); } catch { warn.push('The explored map could not be read; exploration starts over.'); }
    if (Array.isArray(s.players)) for (const pj of s.players as Array<Record<string, unknown>>) {
      const p = this.players.get(String(pj.id)) ?? [...this.players.values()][0];
      if (!p) continue;
      if (typeof pj.x === 'number' && typeof pj.y === 'number') { p.x = pj.x; p.y = pj.y; }
      if (typeof pj.stamina === 'number') p.stamina = pj.stamina;
      if (pj.inv && typeof pj.inv === 'object') p.inv = Object.fromEntries(Object.entries(pj.inv as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
      if (typeof pj.walked === 'number') p.walked = pj.walked;
    }
    warn.push(...this.wildlife.load(s.wildlife, this.wctx));
    warn.push(...this.dragons.load(s.dragons));
    if (Array.isArray(s.log)) for (const l of s.log as Array<{ t: number; text: string }>) if (l && typeof l.text === 'string') this.log.push({ t: +l.t || 0, text: l.text });
    return warn;
  }
}

export type { Creature, Villager };
