import type { DragonEntity } from './DragonEntity';

/** Rates per second. Flapping costs most; gliding little; resting and sleeping restore. */
const ENERGY: Record<string, number> = {
  IDLE: 0.004, WALKING: -0.002, DRINKING: 0.003, RESTING: 0.022, SLEEPING: 0.03,
  TAKING_OFF: -0.03, FLYING: -0.0045, EXPLORING: -0.0045, ROAMING: -0.004, INVESTIGATING: -0.0045, AVOIDING_OBSTACLE: -0.006,
  GLIDING: -0.0015, CIRCLING: -0.0035, DESCENDING: -0.002, LANDING: -0.01,
};

export interface NeedsContext { rain: number; night: number; sheltered: boolean }

/** Advance the dragon's needs. All values stay in 0..1. */
export function updateNeeds(e: DragonEntity, dt: number, ctx: NeedsContext): void {
  const n = e.needs, s = e.state, air = e.airborne;
  const effort = air && s !== 'GLIDING' ? 1 + 0.4 * (e.speed / 13) + Math.max(0, e.vz) * 0.06 : 1;
  n.energy += (ENERGY[s] ?? 0) * (ENERGY[s] < 0 ? effort : 1) * dt;
  n.thirst += (s === 'DRINKING' ? -0.09 : s === 'SLEEPING' ? 0.0012 : air ? 0.0042 : 0.003) * dt;
  // Comfort: rain hurts (less under cover), night in the open a little; it settles toward that level.
  const target = 1 - ctx.rain * (0.3 + 0.7 * e.personality.sensitivity) * (ctx.sheltered ? 0.3 : 1) - ctx.night * (air ? 0.2 : 0.05);
  n.comfort += (target - n.comfort) * Math.min(1, dt * 0.08);
  // Alertness decays toward a resting level (lower asleep); disturbances raise it elsewhere.
  const rest = s === 'SLEEPING' ? 0.03 : 0.15;
  n.alertness += (rest - n.alertness) * Math.min(1, dt * 0.03);
  for (const k of ['energy', 'thirst', 'comfort', 'alertness'] as const) n[k] = Math.min(1, Math.max(0, n[k]));
}
