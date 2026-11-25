import { AIRBORNE, TRAVEL, type DragonEntity, type DragonState, type Goal, type Target } from './DragonEntity';
import type { DragonSenses } from './DragonEnvironmentAwareness';
import type { DragonStateMachine } from './DragonStateMachine';
import { DRAGON } from './DragonConfig';
import { chooseDestination, requiredAlt, probe } from './DragonNavigation';
import { arrive, circle, cruise, guard, seek, wander } from './DragonMovement';

export interface EnvLike { night: number; daylight: number; rain: number; gust: number; windDir: number }

/**
 * Utility AI on top of the state machine. A few times a second it scores every goal from the dragon's needs,
 * personality, the time of day and the weather (with a bonus for the current goal, cooldowns for goals just
 * finished and a little noise), and plans the winner: a destination, a landing spot, a state. Every step it runs
 * the current state's steering and the physical transitions (take-off done, start descent, touch down).
 */
export class DragonAI {
  readonly e: DragonEntity;
  readonly fsm: DragonStateMachine;
  readonly senses: DragonSenses;
  readonly rand: () => number;
  /** Last scores (for the info panel and tests). */
  utilities: Record<Goal, number> = { explore: 0, roam: 0, drink: 0, rest: 0, sleep: 0, shelter: 0, investigate: 0, idle: 0 };
  walkTo: { x: number; y: number } | null = null;
  private acc = 0;
  private pendingTravel: DragonState | null = null;
  private resume: DragonState = 'FLYING';
  /** Hook for interaction effects (landing, splashes...). */
  onEvent: ((name: string) => void) | null = null;

  constructor(e: DragonEntity, fsm: DragonStateMachine, senses: DragonSenses, rand: () => number) {
    this.e = e; this.fsm = fsm; this.senses = senses; this.rand = rand;
  }

  update(dt: number, env: EnvLike): void {
    this.acc += dt;
    if (this.acc >= 1 / DRAGON.aiHz) {
      this.acc = 0;
      if (this.e.autonomous) this.think(env); else this.hold();
    }
    this.behave(dt, env);
  }

  // ------------------------------------------------------------------ decisions
  score(env: EnvLike): Record<Goal, number> {
    const e = this.e, n = e.needs, p = e.personality, onGround = !e.airborne;
    const u: Record<Goal, number> = {
      rest: Math.pow(1 - n.energy, 1.5) * (0.6 + 0.7 * p.restfulness) + (n.energy < 0.22 ? 0.6 : 0),
      sleep: env.night > 0.55 ? env.night * (0.65 + 0.5 * (1 - n.energy)) : 0,
      drink: Math.pow(n.thirst, 1.6) * 1.35 + (n.thirst > 0.75 ? 0.4 : 0),
      shelter: env.rain > 0.2 ? env.rain * (0.3 + 0.8 * p.sensitivity) * (1.2 - n.comfort) : 0,
      explore: 0.12 + p.curiosity * 0.55 * Math.min(1, n.energy + 0.2) * (1 - env.night * 0.7),
      roam: 0.08 + p.wanderlust * 0.35 * n.energy * (1 - env.night * 0.6),
      investigate: e.disturbance && e.time - e.disturbance.t < 40 ? n.alertness * (0.6 + 0.6 * p.curiosity) : 0,
      idle: onGround ? 0.18 + p.restfulness * 0.15 : 0.02,
    };
    for (const g of Object.keys(u) as Goal[]) {
      if ((e.cooldowns[g] ?? 0) > e.time) u[g] *= 0.25;
      u[g] += (this.rand() - 0.5) * 0.08;
    }
    u[e.goal] += e.state === 'SLEEPING' && n.thirst < 0.85 ? 0.6 : 0.15; // a sleeping dragon is hard to rouse
    // Commitment: finish a rest or a drink unless something is urgent.
    if (e.state === 'RESTING' && n.energy < 0.85) u[e.goal] += 0.45;
    if (e.state === 'DRINKING' && n.thirst > 0.1) u.drink += 0.5;
    this.utilities = u;
    return u;
  }

  think(env: EnvLike, force = false): void {
    const e = this.e;
    if (e.state === 'TAKING_OFF' || e.state === 'DESCENDING' || e.state === 'LANDING') return;
    if (!force && !this.fsm.canLeave(e)) return;
    const u = this.score(env);
    let best: Goal = 'idle', bv = -Infinity;
    for (const g of Object.keys(u) as Goal[]) if (u[g] > bv) { bv = u[g]; best = g; }
    if (!force && best === e.goal && this.planValid()) return;
    this.plan(best, env);
  }

  /** Is the current plan still being carried out? */
  private planValid(): boolean {
    const e = this.e;
    if (e.airborne) return !!e.target || e.state === 'CIRCLING';
    switch (e.goal) {
      case 'rest': case 'shelter': return e.state === 'RESTING';
      case 'sleep': return e.state === 'SLEEPING';
      case 'drink': return e.state === 'DRINKING' || e.state === 'WALKING';
      case 'idle': return e.state === 'IDLE' || e.state === 'WALKING';
      default: return false;
    }
  }

  /** User or autonomy-off: keep station (circle in the air, wait on the ground). */
  private hold(): void {
    const e = this.e;
    if (e.airborne && TRAVEL.has(e.state) && this.fsm.canLeave(e)) {
      e.circle = { x: e.x, y: e.y, r: 10, dir: 1, until: Infinity, z: 0 };
      e.target = null;
      this.fsm.change(e, 'CIRCLING', 'holding');
    }
  }

  /** Plan a goal: destination, landing spot and the first state. */
  plan(g: Goal, env: EnvLike): void {
    const e = this.e, s = this.senses, onGround = !e.airborne;
    e.goal = g; e.goalTime = e.time;
    const land = (x: number, y: number, kind: string, label: string, pref: Parameters<DragonSenses['findLanding']>[3], r: number, extra?: Partial<Target>): boolean => {
      const spot = s.findLanding(x, y, r, pref, this.rand);
      if (!spot) return false;
      e.target = { x: spot.x, y: spot.y, kind, label, land: true, ...extra };
      return true;
    };
    switch (g) {
      case 'explore': {
        const poi = chooseDestination(e, s, this.rand, e.target ?? undefined);
        if (!poi) return this.plan('roam', env);
        e.target = { x: poi.x, y: poi.y, kind: poi.kind, label: poi.label, land: false };
        return this.travel('EXPLORING');
      }
      case 'roam': {
        const a = e.heading + (this.rand() - 0.5) * 2.4, d = 30 + this.rand() * 45, w = s.world;
        e.target = { x: Math.min(w.w - 20, Math.max(20, e.x + Math.cos(a) * d)), y: Math.min(w.h - 20, Math.max(20, e.y + Math.sin(a) * d)), kind: 'roam', label: 'wherever the wind goes', land: false };
        return this.travel('ROAMING');
      }
      case 'drink': {
        const known = e.memory.nearestWater(e.x, e.y);
        const poi = s.pois.filter((p) => p.kind === 'lake' || p.kind === 'pond' || p.kind.includes('waterfall'))
          .sort((a, b) => Math.hypot(a.x - e.x, a.y - e.y) - Math.hypot(b.x - e.x, b.y - e.y))[0];
        const src = known ?? poi;
        const deep = src ? s.nearestDeepWater(src.x, src.y, 14) : s.nearestDeepWater(e.x, e.y, 60);
        if (!deep || !land(deep.x, deep.y, 'water', 'water to drink', 'water', 9, { lx: deep.x, ly: deep.y })) return this.plan('explore', env);
        if (onGround && Math.hypot(e.target!.x - e.x, e.target!.y - e.y) < 8) { this.walkTo = { x: e.target!.x, y: e.target!.y }; this.groundTo('WALKING', 'walk to water'); return; }
        return this.travel('FLYING');
      }
      case 'rest': case 'shelter': {
        if (onGround && (g === 'rest' || s.isSheltered(e.x, e.y))) { this.groundTo('RESTING', g); e.target = null; return; }
        const fav = e.memory.rest[0];
        const ok = g === 'shelter'
          ? land(e.x, e.y, 'shelter', 'shelter from the rain', 'shelter', 45)
          : (fav && fav.score > 1 && Math.hypot(fav.x - e.x, fav.y - e.y) < 90 && land(fav.x, fav.y, 'rest', 'a favourite resting place', 'cliff', 6))
            || land(e.x + Math.cos(e.heading) * 12, e.y + Math.sin(e.heading) * 12, 'rest', e.personality.boldness > 0.5 ? 'a high rock to rest on' : 'a quiet place to rest', e.personality.boldness > 0.5 ? 'cliff' : 'open', 40);
        if (!ok) return this.plan('roam', env);
        return this.travel('FLYING');
      }
      case 'sleep': {
        if (onGround && (s.isSheltered(e.x, e.y) || this.senses.world.magic[Math.floor(e.y) * s.world.w + Math.floor(e.x)] > 60)) { this.groundTo('SLEEPING', 'sleep here'); e.target = null; return; }
        const fav = e.memory.rest[0];
        const ok = (fav && land(fav.x, fav.y, 'sleep', 'its sleeping place', 'shelter', 8)) || land(e.x, e.y, 'sleep', 'a sheltered place to sleep', 'shelter', 50) || land(e.x, e.y, 'sleep', 'somewhere to sleep', 'open', 40);
        if (!ok) return this.plan('roam', env);
        if (onGround) { this.groundTo('SLEEPING', 'sleep here'); e.target = null; return; }
        return this.travel('FLYING');
      }
      case 'investigate': {
        const d = e.disturbance;
        if (!d) return this.plan('explore', env);
        e.target = { x: d.x, y: d.y, kind: 'disturbance', label: 'something it noticed', land: false };
        return this.travel('INVESTIGATING');
      }
      default: {
        if (onGround) {
          if (this.rand() < 0.5) {
            const a = this.rand() * Math.PI * 2;
            const tx = e.x + Math.cos(a) * 4, ty = e.y + Math.sin(a) * 4;
            if (s.isLandable(tx, ty)) { this.walkTo = { x: tx, y: ty }; this.groundTo('WALKING', 'stroll'); return; }
          }
          this.groundTo('IDLE', 'idle');
          return;
        }
        if (!land(e.x, e.y, 'idle', 'a place to land', 'open', 30)) return this.plan('roam', env);
        return this.travel('FLYING');
      }
    }
  }

  /** Ground state change, via IDLE when there is no direct transition (e.g. drinking -> sleeping). */
  private groundTo(state: DragonState, reason: string): void {
    const e = this.e;
    if (e.state !== state && !this.fsm.allowed(e.state, state)) this.fsm.change(e, 'IDLE', reason);
    this.fsm.change(e, state, reason);
  }

  private travel(state: DragonState): void {
    const e = this.e;
    if (e.airborne) {
      if (e.state === state) return;
      this.resume = state;
      if (!this.fsm.change(e, state, `travel (${e.goal})`) && e.state !== 'AVOIDING_OBSTACLE') this.fsm.change(e, 'FLYING', 'travel');
    } else {
      this.pendingTravel = state;
      this.fsm.change(e, 'TAKING_OFF', `take off (${e.goal})`);
      this.onEvent?.('takeoff');
    }
  }

  private done(g: Goal, env: EnvLike): void {
    this.e.cooldowns[g] = this.e.time + (DRAGON.cooldown[g] ?? 10);
    this.think(env, true);
  }

  // ------------------------------------------------------------------ per-step behaviour
  private behave(dt: number, env: EnvLike): void {
    const e = this.e, s = this.senses, now = e.time;
    const st = e.state;
    if (!AIRBORNE.has(st)) {
      // Ground states.
      if (st === 'WALKING') {
        if (!this.walkTo || Math.hypot(this.walkTo.x - e.x, this.walkTo.y - e.y) < 0.6 || e.stateTime > 12) {
          this.walkTo = null;
          if (e.goal === 'drink' && e.target?.lx !== undefined) { this.faceWater(); this.fsm.change(e, 'DRINKING', 'reached water'); }
          else this.fsm.change(e, 'IDLE', 'walked');
        }
      } else this.walkTo = null;
      if (st === 'DRINKING' && e.needs.thirst < 0.06 && this.fsm.canLeave(e)) { this.fsm.change(e, 'IDLE', 'drank'); this.done('drink', env); }
      if (st === 'RESTING') {
        if (env.night > 0.6 && e.needs.energy < 0.7 && this.fsm.canLeave(e)) this.fsm.change(e, 'SLEEPING', 'nightfall');
        else if (e.needs.energy > 0.9 && this.fsm.canLeave(e) && (e.goal !== 'shelter' || env.rain < 0.2)) {
          e.memory.noteRest(e.x, e.y, 0.6, now);
          this.fsm.change(e, 'IDLE', 'rested'); this.done(e.goal, env);
        }
      }
      if (st === 'SLEEPING' && env.daylight > 0.5 && e.needs.energy > 0.75 && this.fsm.canLeave(e)) {
        e.memory.noteRest(e.x, e.y, 1, now, 'sleep');
        e.needs.alertness = Math.max(e.needs.alertness, 0.5);
        this.fsm.change(e, 'IDLE', 'woke up'); this.done('sleep', env);
      }
      return;
    }

    if (st === 'TAKING_OFF') {
      const g = s.ground(e.x, e.y);
      const clear = probe(e, s, e.heading, [2, 5]);
      e.zTarget = Math.max(g + 9, clear + 1);
      // Rise almost vertically until clear of whatever is around (trees, a big crown), then fly off.
      e.desiredSpeed = e.z < clear - 0.5 ? 1 : 6;
      if (e.target) seek(e, e.target.x, e.target.y);
      if (e.stateTime >= DRAGON.minState.TAKING_OFF && e.z - g > 5 && e.speed > 3.5 && e.z >= clear - 0.5) {
        const next = this.pendingTravel ?? 'FLYING';
        this.pendingTravel = null;
        this.resume = next;
        this.fsm.change(e, next, 'airborne');
      }
      return;
    }

    if (st === 'DESCENDING' || st === 'LANDING') {
      const t = e.target;
      if (!t) { this.fsm.change(e, 'FLYING', 'lost landing target', true); return; }
      const gt = s.ground(t.x, t.y);
      const d = arrive(e, t.x, t.y, 16);
      if (st === 'DESCENDING') {
        e.zTarget = gt + 0.5 + Math.max(0, d - 2) * 0.45;
        if (d > 6) e.zTarget = Math.max(e.zTarget, requiredAlt(s, e.x, e.y) - 1.5);
        if (d < 2.5 && e.z - gt < 3.5) { this.fsm.change(e, 'LANDING', 'flare'); this.onEvent?.('flare'); }
        else if (e.stateTime > 16 || !s.isLandable(t.x, t.y)) { this.fsm.change(e, 'FLYING', 'abort landing'); this.think(env, true); }
      } else {
        e.desiredSpeed = d > 1 ? 1.2 : 0;
        e.zTarget = gt;
        if (e.z - s.ground(e.x, e.y) < 0.15 && e.speed < 0.9 && e.stateTime >= DRAGON.minState.LANDING) this.touchDown(env);
      }
      return;
    }

    // Travel and circling.
    if (st === 'CIRCLING') {
      circle(e);
      if (!e.circle.z) e.circle.z = this.ringAlt(e.circle.x, e.circle.y, e.circle.r);
      e.zTarget = Math.max(e.circle.z, s.ground(e.x, e.y) + 8);
      guard(e, s, now);
      if (now > e.circle.until && this.fsm.canLeave(e)) {
        e.target = null;
        // After circling something interesting a restful dragon may land nearby.
        if (e.autonomous && this.rand() < 0.15 + e.personality.restfulness * 0.25 && e.needs.energy < 0.6) this.plan('rest', env);
        else this.think(env, true);
      }
      return;
    }
    const t = e.target;
    if (t) seek(e, t.x, t.y); else wander(e, dt, this.rand);
    if (st === 'ROAMING') wander(e, dt * 0.5, this.rand);
    e.desiredSpeed = st === 'GLIDING' ? DRAGON.glideSpeed : st === 'ROAMING' ? DRAGON.cruiseSpeed * 0.85 : DRAGON.cruiseSpeed;
    cruise(e, s);
    if (st === 'GLIDING') e.zTarget = Math.max(requiredAlt(s, e.x, e.y) + 1, e.z - 3);
    // Approaching a landmark it will circle: be at circling height before arriving.
    if (t && !t.land && Math.hypot(t.x - e.x, t.y - e.y) < 45) e.zTarget = Math.max(e.zTarget, this.ringAlt(t.x, t.y, 12));
    const detour = guard(e, s, now);
    if (st === 'AVOIDING_OBSTACLE' || detour !== null) {
      // Brake and climb over whatever lies ahead while turning away from it.
      const ahead = probe(e, s, e.heading, [2, 5, 9]) + 1;
      e.zTarget = Math.max(e.zTarget, ahead);
      // Nearly hover (beating hard) while something taller is right ahead.
      e.desiredSpeed = Math.min(e.desiredSpeed, ahead > e.z + 2 ? 0.8 : 3.5);
    }
    if (detour !== null && st !== 'AVOIDING_OBSTACLE') {
      this.resume = st;
      this.fsm.change(e, 'AVOIDING_OBSTACLE', 'obstacle ahead');
    } else if (st === 'AVOIDING_OBSTACLE' && now > e.avoidUntil && this.fsm.canLeave(e) && e.z >= requiredAlt(s, e.x, e.y) - 0.5) {
      this.fsm.change(e, this.resume === 'AVOIDING_OBSTACLE' ? 'FLYING' : this.resume, 'clear');
    }
    // Glide now and then (more when tired), flap again when climbing is needed.
    if (st !== 'GLIDING' && st !== 'AVOIDING_OBSTACLE' && this.fsm.canLeave(e) && e.speed > 6 && e.zTarget <= e.z + 1 && this.rand() < dt * (0.06 + (1 - e.needs.energy) * 0.3 + env.gust * 0.1)) {
      this.resume = st;
      this.fsm.change(e, 'GLIDING', 'glide');
    } else if (st === 'GLIDING' && this.fsm.canLeave(e) && (e.stateTime > 7 || e.zTarget > e.z + 2 || e.speed < 5)) {
      this.fsm.change(e, this.resume === 'GLIDING' ? 'FLYING' : this.resume, 'flap');
    }
    // Arrivals.
    if (t) {
      const d = Math.hypot(t.x - e.x, t.y - e.y);
      if (t.land && d < Math.max(16, e.speed * 2.4)) this.fsm.change(e, 'DESCENDING', 'approach');
      else if (!t.land && d < 10) {
        e.memory.noteVisit(t.x, t.y, now, t.kind);
        if (t.kind !== 'roam') e.memory.noteLandmark(t.x, t.y, t.kind, now);
        if (t.kind === 'roam') { e.target = null; this.done('roam', env); return; }
        const interest = t.kind.includes('waterfall') ? 1 : t.kind === 'disturbance' ? 0.7 : 0.6;
        e.circle = { x: t.x, y: t.y, r: 9 + e.personality.wanderlust * 7, dir: this.rand() < 0.5 ? -1 : 1, until: now + 6 + 12 * interest * (0.5 + e.personality.curiosity), z: 0 };
        if (t.kind === 'disturbance') { e.disturbance = null; this.e.cooldowns.investigate = now + DRAGON.cooldown.investigate; }
        this.fsm.change(e, 'CIRCLING', `arrived at ${t.label}`);
      }
    }
  }

  /** Height that clears everything along a circle (and its centre) with margin. */
  private ringAlt(cx: number, cy: number, r: number): number {
    let z = requiredAlt(this.senses, cx, cy);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const rr of [r * 0.6, r, r * 1.4, r * 1.8]) z = Math.max(z, requiredAlt(this.senses, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
    }
    return z + 3;
  }

  private faceWater(): void {
    const e = this.e, t = e.target;
    if (t?.lx !== undefined && t.ly !== undefined) e.heading = Math.atan2(t.ly - e.y, t.lx - e.x);
  }

  private touchDown(env: EnvLike): void {
    const e = this.e, now = e.time;
    e.z = this.senses.terrain(e.x, e.y); e.speed = 0; e.vz = 0; e.angVel = 0;
    this.onEvent?.('land');
    e.memory.noteVisit(e.x, e.y, now, 'landing');
    const g = e.goal;
    if (g === 'drink') { this.faceWater(); this.fsm.change(e, 'DRINKING', 'drink'); }
    else if (g === 'rest' || g === 'shelter') { e.memory.noteRest(e.x, e.y, g === 'shelter' ? 0.8 : 0.6, now); this.fsm.change(e, 'RESTING', g); }
    else if (g === 'sleep') { e.memory.noteRest(e.x, e.y, 1, now, 'sleep'); this.fsm.change(e, 'SLEEPING', 'sleep'); }
    else this.fsm.change(e, 'IDLE', 'landed');
    e.target = null;
    void env;
  }
}
