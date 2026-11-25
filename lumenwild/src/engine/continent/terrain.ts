import { SIZE, Biome } from './types';
import { fbm, ridged, valueNoise } from '../core/noise';
import { seedOf } from '../core/rng';
import { clamp, smoothstep } from '../core/math';

/**
 * Biome anchors: each biome is the set of cells closest (after a noise warp) to one of its anchors. Placed from the
 * settlement brief: Dragon Peaks across the north, Heartlands in the centre, Elderwood to the west, Golden Plains in
 * the south-west, Whispering Marshes in the south-east, and the untamed Thornwild in the east (no villages).
 */
export const ANCHORS: Array<{ b: Biome; x: number; y: number }> = [
  { b: Biome.DragonPeaks, x: 470, y: 160 }, { b: Biome.DragonPeaks, x: 350, y: 185 }, { b: Biome.DragonPeaks, x: 600, y: 190 },
  { b: Biome.Heartlands, x: 420, y: 530 }, { b: Biome.Heartlands, x: 545, y: 470 }, { b: Biome.Heartlands, x: 440, y: 640 },
  { b: Biome.Elderwood, x: 250, y: 390 }, { b: Biome.Elderwood, x: 160, y: 505 }, { b: Biome.Elderwood, x: 205, y: 285 },
  { b: Biome.GoldenPlains, x: 210, y: 760 }, { b: Biome.GoldenPlains, x: 335, y: 790 }, { b: Biome.GoldenPlains, x: 110, y: 670 },
  { b: Biome.WhisperingMarshes, x: 700, y: 710 }, { b: Biome.WhisperingMarshes, x: 795, y: 650 }, { b: Biome.WhisperingMarshes, x: 640, y: 800 },
  { b: Biome.Thornwild, x: 790, y: 420 }, { b: Biome.Thornwild, x: 705, y: 320 }, { b: Biome.Thornwild, x: 825, y: 255 },
];

const BIOMES = [Biome.Heartlands, Biome.DragonPeaks, Biome.GoldenPlains, Biome.WhisperingMarshes, Biome.Elderwood, Biome.Thornwild];

function biomeHeight(b: Biome, x: number, y: number, s: number): number {
  switch (b) {
    case Biome.Heartlands: return 9 + 13 * fbm(x * 0.006, y * 0.006, 4, s + 1) + 3 * fbm(x * 0.03, y * 0.03, 2, s + 2);
    case Biome.DragonPeaks: return 38 + 100 * ridged(x * 0.006, y * 0.006, 5, s + 3) + 8 * fbm(x * 0.025, y * 0.025, 3, s + 4);
    case Biome.GoldenPlains: return 4 + 5 * fbm(x * 0.005, y * 0.005, 3, s + 5) + 1.2 * fbm(x * 0.04, y * 0.04, 2, s + 6);
    case Biome.WhisperingMarshes: return 0.9 + 2.6 * fbm(x * 0.012, y * 0.012, 3, s + 7);
    case Biome.Elderwood: return 13 + 20 * fbm(x * 0.008, y * 0.008, 4, s + 8) + 5 * fbm(x * 0.035, y * 0.035, 2, s + 9);
    default: return 18 + 22 * fbm(x * 0.007, y * 0.007, 4, s + 10) + 30 * ridged(x * 0.011, y * 0.011, 3, s + 11);
  }
}

/** Base tree cover by biome (0..1), before patches. */
function biomeForest(b: Biome, h: number): number {
  switch (b) {
    case Biome.Heartlands: return 0.3;
    case Biome.DragonPeaks: return 0.5 * (1 - smoothstep(50, 80, h));
    case Biome.GoldenPlains: return 0.05;
    case Biome.WhisperingMarshes: return 0.3;
    case Biome.Elderwood: return 0.64;
    default: return 0.7;
  }
}

/** Distance metric of the landmass: < 1 is land. A squarish superellipse with a noisy coast. */
export function coastMetric(x: number, y: number, s: number): number {
  const dx = Math.abs(x - 512) / 470, dy = Math.abs(y - 520) / 462;
  const d = Math.pow(Math.pow(dx, 2.7) + Math.pow(dy, 2.7), 1 / 2.7);
  return d + (fbm(x * 0.006, y * 0.006, 4, s + 40) - 0.5) * 0.24 + (fbm(x * 0.025, y * 0.025, 2, s + 41) - 0.5) * 0.06;
}

export interface TerrainFields { height: Float32Array; biome: Uint8Array; forest: Uint8Array }

/**
 * Height (metres; sea below 0), biome and tree cover for every cell. Smooth fields are computed on a half-resolution
 * grid (soft blending between biomes over 40-80 cells) and upsampled with a fine detail octave.
 */
export function generateTerrain(seed: number): TerrainFields {
  const s = seedOf('continent-terrain', seed) % 100000;
  const C = SIZE / 2;
  const ch = new Float32Array(C * C), cb = new Uint8Array(C * C), cf = new Float32Array(C * C);
  const dB = new Float64Array(7);
  for (let cy = 0; cy < C; cy++) {
    for (let cx = 0; cx < C; cx++) {
      const x = cx * 2 + 1, y = cy * 2 + 1, k = cy * C + cx;
      const cm = coastMetric(x, y, s);
      if (cm >= 1) { ch[k] = -1 - 30 * (cm - 1); cb[k] = Biome.Sea; cf[k] = 0; continue; }
      const wx = x + (fbm(x * 0.0035, y * 0.0035, 3, s + 50) - 0.5) * 250 + (fbm(x * 0.013, y * 0.013, 2, s + 52) - 0.5) * 70;
      const wy = y + (fbm(x * 0.0035, y * 0.0035, 3, s + 51) - 0.5) * 250 + (fbm(x * 0.013, y * 0.013, 2, s + 53) - 0.5) * 70;
      dB.fill(1e9);
      for (const a of ANCHORS) { const d = Math.hypot(wx - a.x, wy - a.y); if (d < dB[a.b]) dB[a.b] = d; }
      let best = Biome.Heartlands, dmin = 1e9;
      for (const b of BIOMES) if (dB[b] < dmin) { dmin = dB[b]; best = b; }
      let wsum = 0, h = 0, f = 0;
      for (const b of BIOMES) {
        const dd = dB[b] - dmin;
        if (dd > 160) continue;
        const w = Math.exp(-dd / 38);
        const hb = biomeHeight(b, x, y, s);
        h += w * hb; f += w * biomeForest(b, hb); wsum += w;
      }
      h /= wsum; f /= wsum;
      ch[k] = 0.5 + (h - 0.5) * smoothstep(0.99, 0.86, cm);
      cb[k] = best;
      const p = fbm(x * 0.012, y * 0.012, 3, s + 60);
      cf[k] = clamp(f * 1.25 + (p - 0.5) * 0.95, 0, 1);
    }
  }
  const height = new Float32Array(SIZE * SIZE), biome = new Uint8Array(SIZE * SIZE), forest = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const gy = Math.max(0, Math.min(C - 1.001, (y - 1) / 2)), y0 = Math.floor(gy), ty = gy - y0;
    for (let x = 0; x < SIZE; x++) {
      const gx = Math.max(0, Math.min(C - 1.001, (x - 1) / 2)), x0 = Math.floor(gx), tx = gx - x0;
      const k = y0 * C + x0;
      const h = (ch[k] * (1 - tx) + ch[k + 1] * tx) * (1 - ty) + (ch[k + C] * (1 - tx) + ch[k + C + 1] * tx) * ty;
      const i = y * SIZE + x;
      const b = cb[(y >> 1) * C + (x >> 1)];
      biome[i] = b;
      height[i] = b === Biome.Sea ? h : h + (valueNoise(x * 0.15, y * 0.15, s + 70) - 0.5) * 1.2;
      const fr = (cf[k] * (1 - tx) + cf[k + 1] * tx) * (1 - ty) + (cf[k + C] * (1 - tx) + cf[k + C + 1] * tx) * ty;
      forest[i] = b === Biome.Sea ? 0 : Math.round(clamp(fr + (valueNoise(x * 0.3, y * 0.3, s + 71) - 0.5) * 0.25, 0, 1) * 255);
    }
  }
  return { height, biome, forest };
}
