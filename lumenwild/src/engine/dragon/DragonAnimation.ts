import type { DragonEntity } from './DragonEntity';
import { DRAGON } from './DragonConfig';

/** Wing beat per state: frequency (Hz), amplitude (rad) and bias (rad, positive = raised). */
const WINGS: Record<string, [number, number, number]> = {
  TAKING_OFF: [DRAGON.takeoffHz, 1.0, 0.1], FLYING: [DRAGON.flapHz, 0.85, 0.05], EXPLORING: [DRAGON.flapHz, 0.85, 0.05],
  INVESTIGATING: [DRAGON.flapHz * 1.1, 0.85, 0.05], AVOIDING_OBSTACLE: [DRAGON.flapHz * 1.25, 0.95, 0.05], ROAMING: [1.3, 0.75, 0.05],
  CIRCLING: [1.2, 0.6, 0.12], GLIDING: [0, 0, 0.14], DESCENDING: [1.2, 0.45, 0.2], LANDING: [2, 0.35, 0.85],
};

/** Where the neck starts, relative to the body centre (cells, along the heading). */
export const NECK_BASE = 2.8;
/** Where the tail starts behind the body centre. */
export const TAIL_BASE = 2.6;

/**
 * Animation state, advanced every step: wing phase and flap angle (smoothly blended between states, so a glide
 * eases out of the beat), legs (tucked in flight, out for landing and on the ground), head yaw and dip, and the
 * tail: a chain of segments that follows the body with a delay (follow-the-leader with a little spring), so it
 * swings out on turns and trails in climbs instead of moving as a rigid piece.
 */
export function animate(e: DragonEntity, dt: number): void {
  const [hz, amp, bias] = WINGS[e.state] ?? [0, 0, 0];
  const climbBoost = e.airborne ? Math.max(0, Math.min(1, e.vz / 3)) * 0.5 : 0;
  e.wingAmp += (amp + climbBoost * 0.2 - e.wingAmp) * Math.min(1, dt * 3);
  e.wingPhase = (e.wingPhase + Math.PI * 2 * (hz + climbBoost) * dt) % (Math.PI * 2);
  const want = e.airborne ? bias + e.wingAmp * Math.sin(e.wingPhase) : 0;
  e.flap += (want - e.flap) * Math.min(1, dt * 10);
  // Legs: out to land and on the ground, out briefly after take-off, tucked in flight.
  const legs = !e.airborne || e.state === 'LANDING' || (e.state === 'TAKING_OFF' && e.stateTime < 0.8) || e.state === 'DESCENDING' && e.speed < 4 ? 1 : 0;
  e.legs += (legs - e.legs) * Math.min(1, dt * 4);
  // Head: leans into turns in flight; looks around when idle; down to drink; tucked asleep.
  const t = e.time;
  const yaw = e.airborne ? e.angVel * 0.45
    : e.state === 'IDLE' ? Math.sin(t * 0.45) * 0.7 + Math.sin(t * 1.3) * 0.15
    : e.state === 'SLEEPING' ? 2.3 : e.state === 'RESTING' ? 0.6 + Math.sin(t * 0.2) * 0.2 : 0;
  e.headYaw += (yaw - e.headYaw) * Math.min(1, dt * 2.5);
  const dip = e.state === 'DRINKING' ? 1 : e.state === 'SLEEPING' ? 0.7 : e.state === 'RESTING' ? 0.3 : 0;
  e.headDip += (dip - e.headDip) * Math.min(1, dt * 2);
  // Tail chain.
  const ch = Math.cos(e.heading), sh = Math.sin(e.heading);
  let px = e.x - ch * TAIL_BASE, py = e.y - sh * TAIL_BASE, pz = e.z;
  const curl = e.state === 'SLEEPING' ? 0.34 : e.state === 'RESTING' ? 0.14 : 0;
  const swish = e.airborne ? Math.sin(t * 2.2) * 0.05 : Math.sin(t * 0.7) * 0.03;
  const seg = DRAGON.tailSeg, X = e.tailX, Y = e.tailY, Z = e.tailZ;
  let dirX = -ch, dirY = -sh;
  for (let k = 0; k < X.length; k++) {
    let dx = X[k] - px, dy = Y[k] - py;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    // Bend toward a curl or swish relative to the previous segment's direction (organic, not rigid).
    const bend = curl + swish * (k / X.length);
    const bx = dirX * Math.cos(bend) - dirY * Math.sin(bend), by = dirX * Math.sin(bend) + dirY * Math.cos(bend);
    const stiff = curl > 0 ? 0.25 : 0.06;
    dx += (bx - dx) * stiff; dy += (by - dy) * stiff;
    const n = Math.hypot(dx, dy) || 1;
    dirX = dx / n; dirY = dy / n;
    X[k] = px + dirX * seg; Y[k] = py + dirY * seg;
    // Height trails the body with a lag (the tail droops behind a climb and lifts after a dive).
    Z[k] += (pz - Z[k]) * Math.min(1, dt * (e.airborne ? 5 : 9));
    if (!e.airborne) Z[k] = Math.min(Z[k], pz);
    px = X[k]; py = Y[k]; pz = Z[k];
  }
}
