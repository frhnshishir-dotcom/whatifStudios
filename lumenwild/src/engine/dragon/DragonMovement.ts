import type { DragonEntity } from './DragonEntity';
import type { DragonSenses } from './DragonEnvironmentAwareness';
import { DRAGON } from './DragonConfig';
import { cruiseAltitude, requiredAlt, avoidance, edgeSteer, wrapAngle } from './DragonNavigation';

/**
 * Steering behaviours that turn a goal into desired heading, speed and height for the flight model:
 * seek, arrive (slow down near a landing spot), wander, circle (orbit with radial correction), obstacle and terrain
 * avoidance (detour heading plus climbing to the clearance ahead) and edge avoidance.
 */
export function seek(e: DragonEntity, tx: number, ty: number): void {
  e.desiredHeading = Math.atan2(ty - e.y, tx - e.x);
}

export function arrive(e: DragonEntity, tx: number, ty: number, slowRadius: number): number {
  const d = Math.hypot(tx - e.x, ty - e.y);
  seek(e, tx, ty);
  e.desiredSpeed = DRAGON.approachSpeed + (DRAGON.cruiseSpeed - DRAGON.approachSpeed) * Math.min(1, Math.max(0, (d - 2) / slowRadius));
  return d;
}

export function wander(e: DragonEntity, dt: number, rand: () => number): void {
  e.desiredHeading = wrapAngle(e.desiredHeading + (rand() - 0.5) * 1.6 * dt);
}

export function circle(e: DragonEntity): void {
  const c = e.circle;
  const dx = e.x - c.x, dy = e.y - c.y, d = Math.hypot(dx, dy) || 1;
  // Tangent plus a correction toward the circle radius.
  const tang = Math.atan2(dy, dx) + (c.dir * Math.PI) / 2;
  const corr = Math.max(-0.9, Math.min(0.9, (d - c.r) / c.r)) * c.dir;
  e.desiredHeading = wrapAngle(tang + corr);
  e.desiredSpeed = DRAGON.circleSpeed;
}

/** Height and obstacle handling common to all flight states. Returns a detour heading when one is needed. */
export function guard(e: DragonEntity, senses: DragonSenses, now: number): number | null {
  const w = senses.world;
  const edge = edgeSteer(e, w.w, w.h);
  if (edge !== null) e.desiredHeading = edge;
  const detour = avoidance(e, senses);
  if (detour !== null) { e.avoidHeading = detour; e.avoidUntil = now + 1.2; }
  if (now < e.avoidUntil) e.desiredHeading = e.avoidHeading;
  // Always at least the clearance over what is under and just ahead.
  const need = Math.max(requiredAlt(senses, e.x, e.y), requiredAlt(senses, e.x + Math.cos(e.heading) * 6, e.y + Math.sin(e.heading) * 6));
  if (e.zTarget < need) e.zTarget = need;
  return detour;
}

export function cruise(e: DragonEntity, senses: DragonSenses): void {
  e.zTarget = cruiseAltitude(e, senses, e.heading);
}
