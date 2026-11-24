// Colour system. Colours are float RGB triples (0..255) while composing and packed to 32-bit RGBA for the
// pixel buffer (ImageData's Uint32 view is little-endian: 0xAABBGGRR).

export type RGB = [number, number, number];

export const rgb = (r: number, g: number, b: number): RGB => [r, g, b];

export function hex(h: string): RGB {
  const v = parseInt(h.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function pack(r: number, g: number, b: number): number {
  const R = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  const G = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  const B = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
}

export const packRGB = (c: RGB) => pack(c[0], c[1], c[2]);

export function unpack(p: number): RGB {
  return [p & 255, (p >>> 8) & 255, (p >>> 16) & 255];
}

/** out = a + (b - a) * t, written into `out` (no allocation in hot loops). */
export function mixInto(out: RGB, a: RGB, b: RGB, t: number): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export const mix = (a: RGB, b: RGB, t: number): RGB => mixInto([0, 0, 0], a, b, t);

/** A gradient of colour stops sampled by t in [0, 1]. Pre-baked to a 256-entry table for hot paths. */
export class Gradient {
  readonly table: Float32Array;
  constructor(stops: Array<[number, RGB | string]>) {
    const s = stops.map(([t, c]) => [t, typeof c === 'string' ? hex(c) : c] as [number, RGB]).sort((a, b) => a[0] - b[0]);
    this.table = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < s.length - 2 && t > s[k + 1][0]) k++;
      const [t0, c0] = s[k], [t1, c1] = s[Math.min(k + 1, s.length - 1)];
      const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
      this.table[i * 3] = c0[0] + (c1[0] - c0[0]) * u;
      this.table[i * 3 + 1] = c0[1] + (c1[1] - c0[1]) * u;
      this.table[i * 3 + 2] = c0[2] + (c1[2] - c0[2]) * u;
    }
  }
  sampleInto(out: RGB, t: number): RGB {
    const i = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) * 3;
    out[0] = this.table[i]; out[1] = this.table[i + 1]; out[2] = this.table[i + 2];
    return out;
  }
}
