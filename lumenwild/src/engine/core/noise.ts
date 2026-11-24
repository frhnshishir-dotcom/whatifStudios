import { hash2 } from './rng';

// Smooth deterministic 2D value noise and fractal sums, for terrain and animation fields.

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0, 1]. */
export function valueNoise(x: number, y: number, salt = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, salt), b = hash2(xi + 1, yi, salt);
  const c = hash2(xi, yi + 1, salt), d = hash2(xi + 1, yi + 1, salt);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal Brownian motion, normalised to [0, 1]. */
export function fbm(x: number, y: number, octaves = 5, salt = 0, lacunarity = 2.03, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, y * f, salt + o * 131);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise in [0, 1]: sharp crests, for rock formations and ridgelines. */
export function ridged(x: number, y: number, octaves = 4, salt = 0): number {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * f, y * f, salt + o * 977) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return sum / norm;
}
