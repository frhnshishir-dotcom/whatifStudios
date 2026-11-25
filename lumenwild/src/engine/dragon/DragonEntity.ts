import { DragonMemory } from './DragonMemory';
import { DRAGON } from './DragonConfig';

export const STATES = [
  'IDLE', 'EXPLORING', 'ROAMING', 'TAKING_OFF', 'FLYING', 'GLIDING', 'CIRCLING', 'DESCENDING', 'LANDING',
  'WALKING', 'DRINKING', 'RESTING', 'SLEEPING', 'INVESTIGATING', 'AVOIDING_OBSTACLE',
] as const;
export type DragonState = (typeof STATES)[number];
export type Goal = 'explore' | 'roam' | 'drink' | 'rest' | 'sleep' | 'shelter' | 'investigate' | 'idle';
export const GOALS: Goal[] = ['explore', 'roam', 'drink', 'rest', 'sleep', 'shelter', 'investigate', 'idle'];

/** States in which the dragon is in the air (flight physics apply). */
export const AIRBORNE = new Set<DragonState>(['EXPLORING', 'ROAMING', 'TAKING_OFF', 'FLYING', 'GLIDING', 'CIRCLING', 'DESCENDING', 'LANDING', 'INVESTIGATING', 'AVOIDING_OBSTACLE']);
/** Airborne states that travel toward a target (the AI may switch between them). */
export const TRAVEL = new Set<DragonState>(['EXPLORING', 'ROAMING', 'FLYING', 'GLIDING', 'INVESTIGATING', 'AVOIDING_OBSTACLE']);

export interface Personality { curiosity: number; boldness: number; restfulness: number; wanderlust: number; sensitivity: number }
export interface Needs { energy: number; thirst: number; comfort: number; alertness: number }
/** Where the dragon is heading and what it means to do there. */
export interface Target { x: number; y: number; kind: string; label: string; land: boolean; lx?: number; ly?: number }

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** The dragon's complete state: body, motion, animation, mind. Pure data plus validation and serialisation. */
export class DragonEntity {
  name = 'Verdigris';
  // Body (world cells; z = absolute height in metres, comparable to terrain elevation)
  x = 128; y = 128; z = 20;
  vx = 0; vy = 0; vz = 0;
  heading = 0; angVel = 0; speed = 0;
  // Mind
  state: DragonState = 'FLYING';
  stateTime = 0;
  prevState: DragonState = 'IDLE';
  goal: Goal = 'roam';
  goalTime = 0;
  target: Target | null = null;
  zTarget = 20;
  desiredSpeed: number = DRAGON.cruiseSpeed;
  desiredHeading = 0;
  circle = { x: 0, y: 0, r: 12, dir: 1, until: 0, z: 0 };
  avoidUntil = 0;
  avoidHeading = 0;
  cooldowns: Record<string, number> = {};
  disturbance: { x: number; y: number; t: number } | null = null;
  needs: Needs = { energy: 0.85, thirst: 0.25, comfort: 0.8, alertness: 0.3 };
  personality: Personality = { curiosity: 0.7, boldness: 0.6, restfulness: 0.5, wanderlust: 0.6, sensitivity: 0.5 };
  memory = new DragonMemory();
  /** Its cave: where it lands to rest and sleep (the cell in front of the cave mouth), and the mouth itself. */
  lair: { x: number; y: number; mx: number; my: number } | null = null;
  // Controls
  autonomous = true;
  paused = false;
  effects = true;
  /** Dragon clock (simulation seconds). */
  time = 0;
  // Animation
  wingPhase = 0;
  wingAmp = 0.9;
  flap = 0.2;
  legs = 0;
  headYaw = 0;
  headDip = 0;
  readonly tailX = new Float32Array(DRAGON.tailSegments);
  readonly tailY = new Float32Array(DRAGON.tailSegments);
  readonly tailZ = new Float32Array(DRAGON.tailSegments);

  get airborne(): boolean { return AIRBORNE.has(this.state); }

  /** Lay the tail out straight behind the body (spawn, load, recovery). */
  resetTail(): void {
    const cx = Math.cos(this.heading), cy = Math.sin(this.heading);
    for (let k = 0; k < this.tailX.length; k++) {
      const d = 2.8 + k * DRAGON.tailSeg;
      this.tailX[k] = this.x - cx * d; this.tailY[k] = this.y - cy * d; this.tailZ[k] = this.z;
    }
  }

  /** Repair anything invalid (non-finite numbers, out-of-range needs); returns true if something was fixed. */
  sanitize(w: number, h: number, ground: (x: number, y: number) => number): boolean {
    let fixed = false;
    const bad = (v: number) => !Number.isFinite(v);
    if (bad(this.x) || bad(this.y) || this.x < 1 || this.y < 1 || this.x > w - 2 || this.y > h - 2) {
      if (bad(this.x) || bad(this.y)) { this.x = w / 2; this.y = h / 2; }
      this.x = Math.min(w - 2, Math.max(1, this.x)); this.y = Math.min(h - 2, Math.max(1, this.y));
      fixed = true;
    }
    const g = ground(this.x, this.y);
    if (bad(this.z)) { this.z = g + DRAGON.cruiseAlt; fixed = true; }
    if (this.z < g - 0.01) { this.z = g; fixed = true; }
    for (const k of ['vx', 'vy', 'vz', 'heading', 'angVel', 'speed', 'zTarget', 'desiredSpeed', 'desiredHeading', 'stateTime', 'time'] as const) {
      if (bad(this[k])) { this[k] = k === 'zTarget' ? this.z : 0; fixed = true; }
    }
    if (!(STATES as readonly string[]).includes(this.state)) { this.state = 'FLYING'; fixed = true; }
    if (!GOALS.includes(this.goal)) { this.goal = 'roam'; fixed = true; }
    for (const n of Object.keys(this.needs) as Array<keyof Needs>) { const v = clamp01(this.needs[n]); if (v !== this.needs[n]) { this.needs[n] = v; fixed = true; } }
    for (const p of Object.keys(this.personality) as Array<keyof Personality>) this.personality[p] = clamp01(this.personality[p]);
    if (this.target && (bad(this.target.x) || bad(this.target.y))) { this.target = null; fixed = true; }
    for (let k = 0; k < this.tailX.length; k++) if (bad(this.tailX[k]) || bad(this.tailY[k]) || bad(this.tailZ[k])) { this.resetTail(); fixed = true; break; }
    return fixed;
  }

  toJSON(): DragonSave {
    return {
      version: 1, name: this.name, x: this.x, y: this.y, z: this.z, heading: this.heading, speed: this.speed,
      state: this.state, goal: this.goal, target: this.target ? { ...this.target } : null,
      needs: { ...this.needs }, personality: { ...this.personality }, memory: this.memory.toJSON(),
      autonomous: this.autonomous, paused: this.paused, effects: this.effects, time: this.time,
    };
  }
}

export interface DragonSave {
  version: number;
  name: string;
  x: number; y: number; z: number; heading: number; speed: number;
  state: DragonState; goal: Goal; target: Target | null;
  needs: Needs; personality: Personality;
  memory: ReturnType<DragonMemory['toJSON']>;
  autonomous: boolean; paused: boolean; effects: boolean; time: number;
}

/**
 * Validate saved dragon data (from a world file). Never throws. Invalid fields fall back to safe values with a
 * warning; a dragon that cannot be read at all returns null (the world then spawns a fresh one).
 */
export function validateDragon(raw: unknown, w: number, h: number): { save: DragonSave | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { save: null, warnings: ['Dragon data unreadable; a new dragon will hatch.'] };
  const d = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, def: number, label: string) => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.min(hi, Math.max(lo, v));
    warnings.push(`Dragon ${label} was invalid and was reset.`);
    return def;
  };
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, number>) : {});
  const n = obj(d.needs), p = obj(d.personality);
  let state = d.state as DragonState;
  if (!(STATES as readonly string[]).includes(state)) { warnings.push('Unknown dragon state; it will start flying.'); state = 'FLYING'; }
  const goal = GOALS.includes(d.goal as Goal) ? (d.goal as Goal) : 'roam';
  const t = d.target as Record<string, unknown> | null;
  const target = t && typeof t === 'object' && typeof t.x === 'number' && typeof t.y === 'number' && Number.isFinite(t.x) && Number.isFinite(t.y)
    ? { x: Math.min(w - 2, Math.max(1, t.x)), y: Math.min(h - 2, Math.max(1, t.y)), kind: String(t.kind ?? 'place').slice(0, 24), label: String(t.label ?? '').slice(0, 40), land: t.land === true,
        ...(typeof t.lx === 'number' && typeof t.ly === 'number' ? { lx: t.lx, ly: t.ly } : {}) }
    : null;
  const save: DragonSave = {
    version: 1,
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 32) : 'Verdigris',
    x: num(d.x, 1, w - 2, w / 2, 'position'), y: num(d.y, 1, h - 2, h / 2, 'position'), z: num(d.z, -20, 300, 30, 'altitude'),
    heading: num(d.heading, -1000, 1000, 0, 'heading'), speed: num(d.speed, 0, DRAGON.maxSpeed, 0, 'speed'),
    state, goal, target,
    needs: { energy: num(n.energy, 0, 1, 0.8, 'energy'), thirst: num(n.thirst, 0, 1, 0.3, 'thirst'), comfort: num(n.comfort, 0, 1, 0.8, 'comfort'), alertness: num(n.alertness, 0, 1, 0.3, 'alertness') },
    personality: {
      curiosity: num(p.curiosity, 0, 1, 0.7, 'curiosity'), boldness: num(p.boldness, 0, 1, 0.6, 'boldness'), restfulness: num(p.restfulness, 0, 1, 0.5, 'restfulness'),
      wanderlust: num(p.wanderlust, 0, 1, 0.6, 'wanderlust'), sensitivity: num(p.sensitivity, 0, 1, 0.5, 'sensitivity'),
    },
    memory: (d.memory ?? {}) as DragonSave['memory'],
    autonomous: d.autonomous !== false, paused: d.paused === true, effects: d.effects !== false,
    time: num(d.time, 0, 1e9, 0, 'clock'),
  };
  return { save, warnings };
}
