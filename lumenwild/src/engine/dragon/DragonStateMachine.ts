import type { DragonEntity, DragonState } from './DragonEntity';
import { DRAGON } from './DragonConfig';

const GROUND: DragonState[] = ['IDLE', 'WALKING', 'DRINKING', 'RESTING', 'SLEEPING'];
const FLIGHT: DragonState[] = ['EXPLORING', 'ROAMING', 'FLYING', 'GLIDING', 'CIRCLING', 'INVESTIGATING', 'AVOIDING_OBSTACLE'];

/** Allowed transitions. Anything else is refused (and counted), so the creature can't jump between poses. */
const ALLOWED: Record<DragonState, DragonState[]> = {
  IDLE: ['WALKING', 'DRINKING', 'RESTING', 'SLEEPING', 'TAKING_OFF'],
  WALKING: ['IDLE', 'DRINKING', 'RESTING', 'SLEEPING', 'TAKING_OFF'],
  DRINKING: ['IDLE', 'WALKING', 'RESTING', 'TAKING_OFF'],
  RESTING: ['IDLE', 'SLEEPING', 'WALKING', 'TAKING_OFF'],
  SLEEPING: ['IDLE', 'RESTING', 'TAKING_OFF'],
  TAKING_OFF: [...FLIGHT],
  EXPLORING: [...FLIGHT, 'DESCENDING'],
  ROAMING: [...FLIGHT, 'DESCENDING'],
  FLYING: [...FLIGHT, 'DESCENDING'],
  GLIDING: [...FLIGHT, 'DESCENDING'],
  CIRCLING: [...FLIGHT, 'DESCENDING'],
  INVESTIGATING: [...FLIGHT, 'DESCENDING'],
  AVOIDING_OBSTACLE: [...FLIGHT, 'DESCENDING'],
  DESCENDING: ['LANDING', ...FLIGHT],
  LANDING: [...GROUND, 'FLYING'],
};

export interface Transition { from: DragonState; to: DragonState; t: number; reason: string }

/** Finite-state machine: validates transitions, enforces minimum durations, keeps a short history. */
export class DragonStateMachine {
  readonly history: Transition[] = [];
  refused = 0;
  readonly refusals: Transition[] = [];

  canLeave(e: DragonEntity): boolean {
    return e.stateTime >= (DRAGON.minState[e.state] ?? 0);
  }

  allowed(from: DragonState, to: DragonState): boolean {
    return ALLOWED[from]?.includes(to) ?? false;
  }

  /** Change state if allowed (or forced for recovery). Returns whether the state changed. */
  change(e: DragonEntity, to: DragonState, reason: string, force = false): boolean {
    if (to === e.state) return false;
    if (!force && !this.allowed(e.state, to)) {
      this.refused++;
      this.refusals.push({ from: e.state, to, t: e.time, reason });
      if (this.refusals.length > 16) this.refusals.shift();
      return false;
    }
    this.history.push({ from: e.state, to, t: e.time, reason });
    if (this.history.length > 64) this.history.shift();
    e.prevState = e.state;
    e.state = to;
    e.stateTime = 0;
    return true;
  }
}

export const isGround = (s: DragonState) => GROUND.includes(s);
export const isFlight = (s: DragonState) => FLIGHT.includes(s);
