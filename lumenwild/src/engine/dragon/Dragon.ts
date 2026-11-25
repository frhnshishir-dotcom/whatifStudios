import type { World } from '../world/World';
import type { ObjectStore } from '../objects/ObjectStore';
import type { Particles } from '../render/Particles';
import { mulberry32, seedOf } from '../core/rng';
import { DragonEntity, validateDragon, type DragonSave, type DragonState } from './DragonEntity';
import { DragonStateMachine } from './DragonStateMachine';
import { DragonSenses } from './DragonEnvironmentAwareness';
import { DragonAI, type EnvLike } from './DragonAI';
import { DragonInteractions, type WaterSink } from './DragonInteractions';
import { updateNeeds } from './DragonNeeds';
import { flightStep, groundStep } from './DragonFlight';
import { animate } from './DragonAnimation';
import { DRAGON } from './DragonConfig';

const NAMES = ['Verdigris', 'Mossfang', 'Thornwing', 'Emberleaf', 'Sylvane', 'Aldermaw', 'Fernspire', 'Lichenclaw'];

interface WaterView { depth: Float32Array; fall: Float32Array }

/**
 * The dragon subsystem: one autonomous creature. Stepped by the engine at the fixed simulation rate (it pauses with
 * the world). Each step: repair invalid state, update needs, let the AI decide and steer, integrate flight or
 * ground movement, animate, and apply effects to the world. Rendering is separate (DragonRenderer).
 */
export class Dragon {
  readonly name = 'dragon';
  readonly e = new DragonEntity();
  readonly fsm = new DragonStateMachine();
  readonly fx = new DragonInteractions();
  senses: DragonSenses;
  ai: DragonAI;
  env: EnvLike;
  rand: () => number;
  /** Times invalid state was repaired (tests, diagnostics). */
  recoveries = 0;
  /** Follow the dragon with the camera (read by the engine). */
  follow = false;

  constructor(world: World, objects: ObjectStore, water: WaterView | null, env: EnvLike, seed: number) {
    this.env = env;
    this.rand = mulberry32(seedOf('dragon', seed));
    this.senses = new DragonSenses(world, objects, water);
    this.ai = new DragonAI(this.e, this.fsm, this.senses, this.rand);
    this.ai.onEvent = (n) => this.fx.event(this.e, n, this.senses, this.rand);
  }

  attach(water: (WaterSink & { view: WaterView }) | null, particles: Particles | null): void {
    this.fx.water = water;
    this.fx.particles = particles;
    if (water) this.senses.water = water.view;
  }

  /** Point the subsystem at a (re)generated or loaded world. */
  rebind(world: World, objects: ObjectStore, water: WaterView | null): void {
    const fresh = new DragonSenses(world, objects, water);
    this.senses = fresh;
    this.ai = new DragonAI(this.e, this.fsm, fresh, this.rand);
    this.ai.onEvent = (n) => this.fx.event(this.e, n, this.senses, this.rand);
  }

  /** A new dragon for a world: personality and name from the seed, aloft near `home`. */
  spawn(seed: number, features: Array<{ kind: string; x: number; y: number }> | null, home: [number, number] | null): void {
    const r = mulberry32(seedOf('dragon-spawn', seed)), e = this.e, w = this.senses.world;
    e.name = NAMES[Math.floor(r() * NAMES.length)];
    e.personality = { curiosity: 0.45 + r() * 0.5, boldness: 0.3 + r() * 0.6, restfulness: 0.25 + r() * 0.6, wanderlust: 0.35 + r() * 0.55, sensitivity: 0.3 + r() * 0.6 };
    e.needs = { energy: 0.8 + r() * 0.15, thirst: 0.15 + r() * 0.2, comfort: 0.85, alertness: 0.3 };
    const [hx, hy] = home ?? [w.w / 2, w.h / 2];
    e.x = Math.min(w.w - 20, Math.max(20, hx + (r() - 0.5) * 30));
    e.y = Math.min(w.h - 20, Math.max(20, hy - 20 - r() * 20));
    e.heading = r() * Math.PI * 2;
    e.speed = DRAGON.cruiseSpeed;
    this.senses.refresh(true);
    e.z = this.senses.obstacleTop(e.x, e.y) + DRAGON.cruiseAlt + 4;
    e.zTarget = e.z;
    e.state = 'FLYING'; e.stateTime = 0; e.goal = 'roam'; e.target = null; e.time = 0; e.cooldowns = {};
    e.memory = new (e.memory.constructor as new () => typeof e.memory)();
    e.autonomous = true; e.paused = false; e.effects = true;
    e.resetTail();
    this.senses.scanPOIs(features);
  }

  step(dt: number): void {
    const e = this.e, s = this.senses;
    if (e.sanitize(s.world.w, s.world.h, (x, y) => s.ground(x, y))) this.recoveries++;
    if (e.paused) { animate(e, dt * 0.25); return; }
    e.time += dt;
    e.stateTime += dt;
    updateNeeds(e, dt, { rain: this.env.rain, night: this.env.night, sheltered: !e.airborne && s.isSheltered(e.x, e.y) });
    this.ai.update(dt, this.env);
    if (e.airborne) {
      const wind = { x: this.env.windDir * this.env.gust * 2.4, y: 0.15 * this.env.gust };
      flightStep(e, dt, s, wind, this.env.rain);
    } else groundStep(e, dt, s, this.ai.walkTo);
    animate(e, dt);
    this.fx.update(e, dt, s, this.rand);
  }

  /** Something happened in the world (a click, an edit): the dragon may come to look. */
  notifyDisturbance(x: number, y: number, strength = 1): void {
    const e = this.e, d = Math.hypot(x - e.x, y - e.y);
    if (d > 110) return;
    const k = strength * (1 - d / 110) * (0.5 + e.personality.curiosity * 0.5);
    if (e.state === 'SLEEPING' && k < 0.7) return;
    e.disturbance = { x, y, t: e.time };
    e.needs.alertness = Math.min(1, e.needs.alertness + k * 0.8);
  }

  /** User: go and look at a place (the dragon stays autonomous afterwards). */
  investigate(x: number, y: number): void {
    const e = this.e;
    e.disturbance = { x, y, t: e.time };
    e.needs.alertness = 1;
    e.cooldowns.investigate = 0;
    this.ai.plan('investigate', this.env);
  }

  /** User: back to the sky above home, flying. */
  reset(home: [number, number] | null): void {
    const e = this.e, w = this.senses.world, [hx, hy] = home ?? [w.w / 2, w.h / 2];
    e.x = hx; e.y = hy - 20;
    e.z = this.senses.obstacleTop(e.x, e.y) + DRAGON.cruiseAlt + 4;
    e.vx = e.vy = e.vz = 0; e.speed = DRAGON.cruiseSpeed; e.angVel = 0;
    this.fsm.change(e, 'FLYING', 'reset', true);
    e.target = null; e.goal = 'roam';
    e.resetTail();
  }

  setState(s: DragonState, reason: string): void { this.fsm.change(this.e, s, reason, true); }

  toJSON(): DragonSave { return this.e.toJSON(); }

  /** Restore from a save (validated). Returns warnings. Invalid data leaves a fresh dragon in place. */
  load(raw: unknown): string[] {
    const s = this.senses, w = s.world;
    const { save, warnings } = validateDragon(raw, w.w, w.h);
    if (!save) return warnings;
    const e = this.e;
    Object.assign(e, { name: save.name, x: save.x, y: save.y, z: save.z, heading: save.heading, speed: save.speed, goal: save.goal, target: save.target, time: save.time,
      autonomous: save.autonomous, paused: save.paused, effects: save.effects, needs: { ...save.needs }, personality: { ...save.personality } });
    e.memory.load(save.memory, w.w, w.h);
    // Transitional states resume as their natural continuation.
    const st: DragonState = save.state === 'TAKING_OFF' ? 'FLYING' : save.state === 'LANDING' ? 'DESCENDING' : save.state;
    e.state = st; e.stateTime = 0; e.cooldowns = {};
    if (e.airborne) e.z = Math.max(e.z, s.ground(e.x, e.y) + 1); else e.z = s.terrain(e.x, e.y);
    if (e.state === 'DESCENDING' && !e.target) e.state = 'FLYING';
    e.zTarget = e.z; e.vx = e.vy = e.vz = 0; e.angVel = 0;
    e.resetTail();
    return warnings;
  }
}
