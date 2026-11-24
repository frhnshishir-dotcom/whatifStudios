import type { World } from '../world/World';
import { Mat, Cover } from '../world/materials';
import { fbm } from '../core/noise';
import type { WaterSystem } from '../water/WaterSystem';

/**
 * Deterministic test world for water behaviour (and browser tests): an upper plateau (10 m) with a winding channel,
 * a 5 m cliff with a waterfall into a round pond, a middle terrace with a rock in the stream, a 3.5 m cliff into a
 * second pond, and the river leaving the map at the front edge.
 */
export function buildWaterTest(world: World): void {
  const { w, h } = world;
  const cx = (y: number) => 128 + 14 * Math.sin(y / 22);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const n = fbm(x / 30, y / 30, 3, 5) * 1.2;
      let e = y < 70 ? 10 : y < 150 ? 5 : 1.5;
      const dx = Math.abs(x - cx(y));
      const bank = Math.min(1, Math.max(0, 1 - dx / 4) * 1.6);
      // Banks get the terrain noise; the channel bed slopes down monotonically (no dips to fill).
      e += n * (1 - bank) - y * 0.006 - 1.3 * bank - (bank > 0.99 ? 0.4 : 0);
      const p1 = Math.hypot(x - cx(70), y - 82), p2 = Math.hypot(x - cx(150), y - 162);
      if (p1 < 13) e = Math.min(e, 5 - 2.6 * Math.cos((p1 / 13) * Math.PI * 0.5));
      if (p2 < 11) e = Math.min(e, 1.5 - 2.2 * Math.cos((p2 / 11) * Math.PI * 0.5));
      world.elev[i] = e;
      world.mat[i] = y > 66 && y < 72 && dx > 4 ? Mat.Cliff : y > 146 && y < 152 && dx > 4 ? Mat.Cliff : dx < 5 || (p1 < 15 && p1 > 11) || (p2 < 13 && p2 > 9) ? Mat.Sand : n > 0.65 ? Mat.Meadow : Mat.Grass;
      world.cover[i] = world.mat[i] === Mat.Sand || world.mat[i] === Mat.Cliff ? Cover.None : n > 0.7 ? Cover.Flowers : Cover.ShortGrass;
      world.coverVar[i] = (x * 7 + y) % 6;
      world.moisture[i] = 160;
    }
  }
  // A rock in the stream on the middle terrace.
  for (let y = 108; y <= 111; y++) for (let x = Math.round(cx(110)) - 1; x <= Math.round(cx(110)) + 1; x++) { world.elev[y * w + x] += 3; world.mat[y * w + x] = Mat.Stone; }
  world.markAllDirty();
}

/** Fill both ponds to their rim and start the river source. */
export function waterTestWater(world: World, water: WaterSystem): void {
  const cx = (y: number) => 128 + 14 * Math.sin(y / 22);
  water.addWater(cx(70), 82, 11, 11 * 11 * Math.PI * 1.0);
  water.addWater(cx(150), 162, 9, 9 * 9 * Math.PI * 0.9);
  water.setSource(Math.round(cx(4)), 4, 6);
  water.warmup(1200);
  void world;
}
