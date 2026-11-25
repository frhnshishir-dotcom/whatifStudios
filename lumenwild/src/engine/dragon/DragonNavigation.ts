import type { DragonEntity } from './DragonEntity';
import type { DragonSenses, POI } from './DragonEnvironmentAwareness';
import { DRAGON } from './DragonConfig';

export const wrapAngle = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/**
 * Destination choice: weighted random over points of interest. Weight = interest x personality x novelty (recently
 * visited places are much less attractive) x distance preference (not too near, not across the whole map).
 */
export function chooseDestination(e: DragonEntity, senses: DragonSenses, rand: () => number, exclude?: { x: number; y: number }): POI | null {
  const pois = senses.pois;
  if (!pois.length) return null;
  let total = 0;
  const weights = pois.map((p) => {
    if (exclude && Math.hypot(p.x - exclude.x, p.y - exclude.y) < 10) return 0;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    const dist = d < 12 ? 0.05 : Math.min(1, (d - 12) / 25) * (d > 150 ? 0.6 : 1);
    const novelty = 1 - 0.92 * e.memory.recency(p.x, p.y, 14, e.time, 300);
    const curious = p.kind.includes('waterfall') || p.kind.includes('glade') || p.kind === 'christmas tree' ? 0.4 + e.personality.curiosity : 0.6 + e.personality.wanderlust * 0.5;
    const wgt = Math.max(0, p.interest * curious * novelty * dist);
    total += wgt;
    return wgt;
  });
  if (total <= 0) return null;
  let r = rand() * total;
  for (let k = 0; k < pois.length; k++) { r -= weights[k]; if (r <= 0) return pois[k]; }
  return pois[pois.length - 1];
}

/** Height the dragon needs over (x, y): obstacle top plus clearance. */
export function requiredAlt(senses: DragonSenses, x: number, y: number): number {
  return senses.obstacleTop(x, y) + DRAGON.clearance;
}

/** Highest requirement along a heading, probing at a few distances ahead. */
export function probe(e: DragonEntity, senses: DragonSenses, heading: number, dists: readonly number[] = [4, 9, 15, 22]): number {
  let need = requiredAlt(senses, e.x, e.y);
  for (const d of dists) need = Math.max(need, requiredAlt(senses, e.x + Math.cos(heading) * d, e.y + Math.sin(heading) * d));
  return need;
}

/** Cruise height for the area ahead: terrain-following with clearance plus a personality-dependent margin. */
export function cruiseAltitude(e: DragonEntity, senses: DragonSenses, heading: number): number {
  return Math.max(probe(e, senses, heading) + 2, senses.ground(e.x, e.y) + DRAGON.cruiseAlt + e.personality.boldness * 8);
}

/**
 * Obstacle check along the current heading: if what lies ahead is higher than the dragon can climb to before it
 * gets there, pick a detour heading (the side with the lower obstacles). Returns the detour or null.
 */
export function avoidance(e: DragonEntity, senses: DragonSenses): number | null {
  const sp = Math.max(3, e.speed);
  // Already inside something taller (e.g. drifted into a big tree's crown): get out by the lowest way.
  if (requiredAlt(senses, e.x, e.y) > e.z + 0.5) {
    let best = e.heading, bestNeed = Infinity;
    for (let k = 0; k < 8; k++) {
      const h = e.heading + (k / 8) * Math.PI * 2;
      const n = probe(e, senses, h, [3, 6]);
      if (n < bestNeed - 0.5) { bestNeed = n; best = h; }
    }
    return best;
  }
  for (const d of [4, 8, 13, 19, 26]) {
    // Along the predicted arc (current turn rate) and along the heading it is turning toward.
    const arc = e.heading + Math.max(-1.2, Math.min(1.2, e.angVel * (d / sp)));
    const need = Math.max(
      requiredAlt(senses, e.x + Math.cos(arc) * d, e.y + Math.sin(arc) * d),
      requiredAlt(senses, e.x + Math.cos(e.desiredHeading) * d, e.y + Math.sin(e.desiredHeading) * d),
      requiredAlt(senses, e.x + Math.cos(e.heading) * d, e.y + Math.sin(e.heading) * d),
    );
    const reach = e.z + DRAGON.climbRate * (d / sp);
    if (need > reach) {
      let best = e.heading, bestNeed = Infinity;
      for (const off of [0.55, -0.55, 1.1, -1.1, 1.7, -1.7]) {
        const n = probe(e, senses, e.heading + off, [6, 12]);
        if (n < bestNeed - 0.5) { bestNeed = n; best = e.heading + off; }
      }
      return best;
    }
  }
  return null;
}

/** Steering away from the world edge (a heading bias toward the centre when close to it). */
export function edgeSteer(e: DragonEntity, w: number, h: number): number | null {
  const m = DRAGON.edgeMargin;
  if (e.x > m && e.y > m && e.x < w - m && e.y < h - m) return null;
  return Math.atan2(h / 2 - e.y, w / 2 - e.x);
}
