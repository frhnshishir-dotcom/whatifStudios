import type { DragonEntity } from './DragonEntity';
import type { DragonSenses } from './DragonEnvironmentAwareness';
import { DRAGON } from './DragonConfig';
import { wrapAngle } from './DragonNavigation';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Airborne physics for one step. The AI sets desiredHeading, desiredSpeed and zTarget; this integrates them with
 * limits so motion is always continuous: turn rate and turn acceleration (no snapping), forward acceleration and
 * braking, climb and sink rates per state, wind drift, a floor above the ground, and the world bounds.
 */
export function flightStep(e: DragonEntity, dt: number, senses: DragonSenses, wind: { x: number; y: number }, rainSlow: number): void {
  const s = e.state;
  // Heading: angular velocity chases the heading error, limited in rate and acceleration (smooth banking turns).
  const delta = wrapAngle(e.desiredHeading - e.heading);
  const maxTurn = DRAGON.maxTurn * (s === 'LANDING' ? 0.7 : s === 'CIRCLING' ? 1.1 : 1) * (1 - 0.3 * Math.min(1, e.speed / DRAGON.maxSpeed));
  const wantAng = clamp(delta * 1.6, -maxTurn, maxTurn);
  e.angVel += clamp(wantAng - e.angVel, -DRAGON.turnAccel * dt, DRAGON.turnAccel * dt);
  e.heading = wrapAngle(e.heading + e.angVel * dt);
  // Speed: accelerate / brake toward the desired speed; gliding trades height for speed.
  const want = Math.min(DRAGON.maxSpeed, e.desiredSpeed * (1 - 0.15 * rainSlow));
  const dv = want - e.speed;
  e.speed = clamp(e.speed + clamp(dv, -DRAGON.decel * dt, DRAGON.accel * dt), 0, DRAGON.maxSpeed);
  if (s === 'GLIDING' && e.vz < -0.3) e.speed = Math.min(DRAGON.maxSpeed, e.speed + -e.vz * 0.25 * dt);
  // Vertical: rate toward the target height, limited by what this state can do.
  const climb = s === 'TAKING_OFF' || s === 'AVOIDING_OBSTACLE' ? DRAGON.takeoffClimb : s === 'GLIDING' ? 0.35 : s === 'LANDING' || s === 'DESCENDING' ? 0.8 : DRAGON.climbRate;
  const sink = s === 'GLIDING' ? DRAGON.glideSink : s === 'LANDING' ? 1.6 : DRAGON.sinkRate;
  const vzWant = clamp((e.zTarget - e.z) * 0.9, -sink, climb);
  e.vz += clamp(vzWant - e.vz, -3.5 * dt, 3.5 * dt);
  // Integrate (wind pushes harder when the dragon is slow).
  const drift = DRAGON.windDrift * (1 - 0.5 * Math.min(1, e.speed / DRAGON.maxSpeed));
  e.vx = Math.cos(e.heading) * e.speed + wind.x * drift;
  e.vy = Math.sin(e.heading) * e.speed + wind.y * drift;
  e.z += e.vz * dt;
  // Collision with tall things: never move into an area whose top is above the dragon (except on the final
  // landing approach, where the landing spot itself is known to be clear). Brake and climb instead.
  const nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
  const finalApproach = (s === 'LANDING' || s === 'DESCENDING') && !!e.target && Math.hypot(e.target.x - e.x, e.target.y - e.y) < 7;
  const topNext = senses.obstacleTop(nx, ny);
  if (!finalApproach && topNext > e.z && topNext > senses.obstacleTop(e.x, e.y) + 0.01) {
    e.speed *= 0.5;
    e.vx = e.vy = 0;
    if (e.zTarget < topNext + DRAGON.clearance) e.zTarget = topNext + DRAGON.clearance;
    e.vz = Math.max(e.vz, Math.min(DRAGON.takeoffClimb, 2));
  } else { e.x = nx; e.y = ny; }
  const w = senses.world;
  e.x = clamp(e.x, 2, w.w - 3);
  e.y = clamp(e.y, 2, w.h - 3);
  // Never through the ground (only the landing flare comes down to it).
  const floor = senses.ground(e.x, e.y) + (s === 'LANDING' ? 0 : 0.6);
  if (e.z < floor) { e.z = floor; if (e.vz < 0) e.vz = 0; }
}

/** Ground movement: walk toward a point at walking pace if the way is passable; otherwise stop. */
export function groundStep(e: DragonEntity, dt: number, senses: DragonSenses, walkTo: { x: number; y: number } | null): void {
  if (walkTo) {
    const want = Math.atan2(walkTo.y - e.y, walkTo.x - e.x);
    const delta = wrapAngle(want - e.heading);
    e.heading = wrapAngle(e.heading + clamp(delta, -2 * dt, 2 * dt));
    const sp = Math.abs(delta) > 1.2 ? 0.3 : DRAGON.walkSpeed;
    e.speed += clamp(sp - e.speed, -3 * dt, 2 * dt);
  } else e.speed = Math.max(0, e.speed - 3 * dt);
  const nx = e.x + Math.cos(e.heading) * e.speed * dt, ny = e.y + Math.sin(e.heading) * e.speed * dt;
  const passable = senses.depth(nx, ny) < 0.15 && Math.abs(senses.terrain(nx, ny) - senses.terrain(e.x, e.y)) < 0.8
    && !(senses.objects.at(Math.floor(ny) * senses.world.w + Math.floor(nx))?.kind && ['rock', 'cottage', 'mill', 'stone'].includes(senses.objects.at(Math.floor(ny) * senses.world.w + Math.floor(nx))!.kind));
  if (passable) { e.x = nx; e.y = ny; } else e.speed = 0;
  e.vx = Math.cos(e.heading) * e.speed; e.vy = Math.sin(e.heading) * e.speed;
  e.vz = 0;
  e.angVel = 0;
  e.z = senses.terrain(e.x, e.y);
}
