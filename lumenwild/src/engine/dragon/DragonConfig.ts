/** Tuning for the dragon. Distances in world cells (1 m), speeds in cells/s, angles in radians. */
export const DRAGON = {
  // Flight
  cruiseSpeed: 8,
  glideSpeed: 9.5,
  circleSpeed: 6.5,
  maxSpeed: 13,
  approachSpeed: 3.2,
  accel: 3.2,
  decel: 4.5,
  maxTurn: 1.25,
  turnAccel: 2.4,
  climbRate: 3.2,
  takeoffClimb: 4.4,
  sinkRate: 2.8,
  glideSink: 1.2,
  /** Cruise height above the terrain and obstacles. */
  cruiseAlt: 13,
  /** Minimum clearance over terrain, trees and buildings while flying. */
  clearance: 3.5,
  edgeMargin: 14,
  windDrift: 0.35,
  // Ground
  walkSpeed: 1.4,
  // Animation
  flapHz: 1.5,
  takeoffHz: 2.3,
  tailSegments: 14,
  tailSeg: 0.95,
  neckSegments: 3,
  neckSeg: 1.25,
  // Decisions
  aiHz: 3,
  /** Minimum seconds in a state before the AI may leave it (transitional states end by themselves). */
  minState: {
    IDLE: 2.5, EXPLORING: 4, ROAMING: 8, TAKING_OFF: 1.2, FLYING: 3, GLIDING: 2.5, CIRCLING: 6, DESCENDING: 1,
    LANDING: 0.9, WALKING: 1.5, DRINKING: 6, RESTING: 10, SLEEPING: 20, INVESTIGATING: 3, AVOIDING_OBSTACLE: 0.8,
  } as Record<string, number>,
  /** Seconds a finished goal stays less attractive. */
  cooldown: { drink: 60, rest: 40, explore: 6, roam: 20, investigate: 25, shelter: 30, sleep: 30, idle: 6 } as Record<string, number>,
} as const;
