// Deterministic randomness. Nothing that affects a rendered frame may use Math.random().

/** mulberry32: small, fast, good enough for sampling. Returns a function giving floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string (or number) to a 32-bit seed, so modules can derive independent streams: rng('trees', seed). */
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x9e3779b9;
  }
  return h >>> 0;
}

export class Rng {
  constructor(...seedParts) {
    this.next = mulberry32(hashSeed(...seedParts));
  }
  float() { return this.next(); }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  /** Standard normal via Box-Muller. */
  gauss() {
    const u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Uniform direction on the unit sphere -> [x, y, z]. */
  dir() {
    const z = this.range(-1, 1), a = this.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
  }
}

/** Smooth 1D value noise on the CPU (for camera shake etc.), deterministic in t. */
export function noise1(t, seed = 0) {
  const i = Math.floor(t), f = t - i;
  const h = (n) => {
    const x = Math.sin((n + seed * 131.7) * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const u = f * f * (3 - 2 * f);
  return (h(i) * (1 - u) + h(i + 1) * u) * 2 - 1;
}

/** Fractal 1D noise, roughly in [-1, 1]. */
export function fbm1(t, seed = 0, octaves = 3) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < octaves; o++) { s += a * noise1(t * f, seed + o * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
