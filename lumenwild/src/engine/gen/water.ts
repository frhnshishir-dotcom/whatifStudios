import type { World } from '../world/World';
import type { WaterSystem } from '../water/WaterSystem';

/**
 * Initial water for a bare terrain: sources on the highest local peaks of the highlands (spread apart), then a
 * warm-up so the world starts with flowing streams. Milestone 3's generator carves rivers and lakes instead.
 */
export function seedSources(world: World, water: WaterSystem, count = 3, rate = 2.4): Array<[number, number]> {
  const { w, h } = world;
  const cands: Array<[number, number, number]> = [];
  for (let y = 4; y < h * 0.3; y++) {
    for (let x = 8; x < w - 8; x++) {
      const e = world.elev[y * w + x];
      let peak = true;
      for (let dy = -3; dy <= 3 && peak; dy++) for (let dx = -3; dx <= 3; dx++) if (world.elevAt(x + dx, y + dy) > e) { peak = false; break; }
      if (peak) cands.push([e, x, y]);
    }
  }
  cands.sort((a, b) => b[0] - a[0]);
  const chosen: Array<[number, number]> = [];
  for (const [, x, y] of cands) {
    if (chosen.every(([cx, cy]) => Math.hypot(cx - x, cy - y) > 45)) chosen.push([x, y]);
    if (chosen.length >= count) break;
  }
  for (const [x, y] of chosen) water.setSource(x, y, rate);
  return chosen;
}
