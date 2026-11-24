import type { World } from '../world/World';
import { Mat, Cover } from '../world/materials';
import { fbm, ridged, valueNoise } from '../core/noise';
import { smoothstep, clamp } from '../core/math';
import { seedOf } from '../core/rng';

/**
 * Base terrain: a seeded heightmap with highlands at the back (north, low y) so cliffs and waterfalls face the
 * viewer, terraced plateaus (cliff bands for waterfalls), ridged rock formations, then materials by slope and
 * height, moisture and ground cover. Rivers, lakes and structures are carved on top (gen/world.ts).
 */
export function generateTerrain(world: World, seed: number): void {
  const { w, h } = world;
  const s = seedOf('terrain', seed) % 10000;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ny = y / h;
      const base = fbm(x / 72, y / 72, 5, s);
      const detail = fbm(x / 16, y / 16, 3, s + 7);
      const ridge = ridged(x / 46, y / 46, 4, s + 13);
      // Highlands at the back, a warped edge so the escarpment is not a straight line.
      const warp = (valueNoise(x / 40, 3.7, s + 3) - 0.5) * 0.22;
      const north = smoothstep(0.62 + warp, 0.08 + warp, ny);
      let e = 1.5 + base * 6 + north * 11 + ridge * 5 * (0.3 + north) + detail * 1.1;
      // Terraces: plateaus separated by short steep steps (strongest in the highlands).
      const step = 3.4;
      const q = e / step, fl = Math.floor(q), fr = q - fl;
      const terr = (fl + smoothstep(0.7, 0.98, fr)) * step;
      e = e + (terr - e) * (0.35 + 0.55 * north);
      world.elev[i] = e;
      world.moisture[i] = Math.round(clamp(fbm(x / 50, y / 50, 3, s + 21) * 1.25 - 0.1, 0, 1) * 255);
    }
  }
  assignSurface(world, seed);
  world.markAllDirty();
}

/** Materials and ground cover from slope, height, moisture and biome noise. Reused after terrain edits. */
export function assignSurface(world: World, seed: number, x0 = 0, y0 = 0, x1 = world.w - 1, y1 = world.h - 1): void {
  const { w } = world;
  const s = seedOf('surface', seed) % 10000;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (world.mat[i] === Mat.Path || world.mat[i] === Mat.Glade) continue; // placed features keep their material
      const e = world.elev[i];
      const gx = world.elevAt(x + 1, y) - world.elevAt(x - 1, y), gy = world.elevAt(x, y + 1) - world.elevAt(x, y - 1);
      const slope = Math.hypot(gx, gy) * 0.5;
      const moist = world.moisture[i] / 255;
      const forest = fbm(x / 34, y / 34, 3, s + 5);
      const meadow = fbm(x / 28, y / 28, 2, s + 9);
      const rocky = ridged(x / 23, y / 23, 3, s + 17);
      const r = valueNoise(x * 0.9, y * 0.9, s + 31);
      // Clumped cover: tall grass, flowers and ferns grow in patches (noise fields), not per-cell scatter.
      const tall = fbm(x / 6, y / 6, 2, s + 51), bloom = fbm(x / 9, y / 9, 2, s + 53), fern = fbm(x / 5, y / 5, 2, s + 57);
      let mat: number = Mat.Grass, cover: number = Cover.ShortGrass;
      if (slope > 1.35) { mat = Mat.Cliff; cover = Cover.None; }
      else if (rocky > 0.62 && e > 11) { mat = Mat.Stone; cover = r > 0.62 ? Cover.MossPatch : Cover.None; }
      else if (forest > 0.56) {
        mat = Mat.ForestFloor;
        cover = fern > 0.6 ? Cover.Fern : r > 0.55 ? Cover.Litter : r > 0.4 ? Cover.MossPatch : Cover.None;
      } else if (meadow > 0.58 && moist < 0.7) {
        mat = Mat.Meadow;
        cover = bloom > 0.62 && r > 0.35 ? Cover.Flowers : tall > 0.56 ? Cover.TallGrass : bloom < 0.35 && r > 0.6 ? Cover.Clover : Cover.ShortGrass;
      } else if (moist > 0.78) {
        mat = Mat.Moss;
        cover = r > 0.6 ? Cover.MossPatch : fern > 0.62 ? Cover.Fern : Cover.None;
      } else {
        mat = Mat.Grass;
        cover = bloom > 0.7 && r > 0.55 ? Cover.Flowers : tall > 0.6 ? Cover.TallGrass : Cover.ShortGrass;
      }
      world.mat[i] = mat;
      world.cover[i] = cover;
      world.coverVar[i] = Math.floor(valueNoise(x / 6, y / 6, s + 41) * 6) % 6; // flower colours in patches
    }
  }
}
