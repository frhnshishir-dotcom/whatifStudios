import { type Blueprint, W_SEA, W_LAKE, W_RIVER, W_MARSH } from './blueprint';

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Hypsometric tint stops (metres). */
const HYPSO: Array<[number, RGB]> = [
  [0, hex('#6f9a58')], [100, hex('#7fa55e')], [250, hex('#9aa865')], [500, hex('#a99a6a')],
  [800, hex('#8f8478')], [1100, hex('#9c9aa0')], [1350, hex('#d8dde2')], [1600, hex('#ffffff')],
];
function hypso(e: number): RGB {
  if (e <= HYPSO[0][0]) return HYPSO[0][1];
  for (let k = 1; k < HYPSO.length; k++) if (e <= HYPSO[k][0]) return mix(HYPSO[k - 1][1], HYPSO[k][1], (e - HYPSO[k - 1][0]) / (HYPSO[k][0] - HYPSO[k - 1][0]));
  return HYPSO[HYPSO.length - 1][1];
}

/**
 * The blueprint as pixels, one per sample (N x N, RGBA packed little-endian): elevation tint blended with the region
 * colour, hill shading from the north-west, sea depth, lakes, rivers and marsh water, and soft region borders.
 */
export function renderBlueprint(bp: Blueprint, out: Uint32Array): void {
  const { N, elev, water, region } = bp;
  const tints = bp.data.regions.map((r) => hex(r.colour));
  const tint = blurredTints(bp, tints);
  const spacing = bp.unit * bp.coords.metresPerUnit;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, e = elev[k], w = water[k];
    let c: RGB;
    if (w === W_SEA) c = mix(hex('#2f6f8f'), hex('#0d2436'), Math.min(1, -e / 80));
    else if (w === W_LAKE) c = hex('#3a7fae');
    else if (w === W_RIVER) c = hex('#4a90c0');
    else {
      c = mix(hypso(e), [tint[k * 3], tint[k * 3 + 1], tint[k * 3 + 2]], e > 1250 ? 0.12 : 0.5);
      if (w === W_MARSH) c = mix(c, hex('#3f7a72'), 0.65);
      const gx = (elev[Math.min(N * N - 1, k + 1)] - elev[Math.max(0, k - 1)]) / (2 * spacing);
      const gy = (elev[Math.min(N * N - 1, k + N)] - elev[Math.max(0, k - N)]) / (2 * spacing);
      const shade = Math.max(0.55, Math.min(1.35, 1 - (gx + gy) * 1.1));
      c = [c[0] * shade, c[1] * shade, c[2] * shade];
      const rr = region[k];
      if (((i + j) & 3) === 0 && ((i < N - 1 && region[k + 1] !== rr && region[k + 1] >= 0) || (j < N - 1 && region[k + N] !== rr && region[k + N] >= 0))) c = mix(c, [255, 255, 255], 0.25);
    }
    out[k] = (0xff000000 | (Math.min(255, Math.round(c[2])) << 16) | (Math.min(255, Math.round(c[1])) << 8) | Math.min(255, Math.round(c[0]))) >>> 0;
  }
}

/** Region colours blurred over about 40 map units, so regions blend into each other. */
function blurredTints(bp: Blueprint, tints: RGB[]): Float32Array {
  const { N, region } = bp;
  let a = new Float32Array(N * N * 3), b = new Float32Array(N * N * 3);
  for (let k = 0; k < N * N; k++) { const t = tints[Math.max(0, region[k])] ?? tints[0]; a[k * 3] = t[0]; a[k * 3 + 1] = t[1]; a[k * 3 + 2] = t[2]; }
  const R = 10, span = 2 * R + 1;
  for (let pass = 0; pass < 2; pass++) for (const horiz of [true, false]) {
    for (let line = 0; line < N; line++) for (let ch = 0; ch < 3; ch++) {
      const at = (q: number) => { const qq = Math.max(0, Math.min(N - 1, q)); return (horiz ? line * N + qq : qq * N + line) * 3 + ch; };
      let sum = 0;
      for (let q = -R; q <= R; q++) sum += a[at(q)];
      for (let q = 0; q < N; q++) { b[at(q)] = sum / span; sum += a[at(q + R + 1)] - a[at(q - R)]; }
    }
    [a, b] = [b, a];
  }
  return a;
}

/** Where to write each region's name: the centroid of its land. */
export function regionLabels(bp: Blueprint): Array<{ name: string; x: number; y: number }> {
  const { N, region } = bp;
  const sx = new Float64Array(bp.data.regions.length), sy = new Float64Array(bp.data.regions.length), n = new Float64Array(bp.data.regions.length);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const r = region[j * N + i]; if (r >= 0) { sx[r] += i; sy[r] += j; n[r]++; } }
  return bp.data.regions.map((r, ri) => ({ name: r.name, x: ((sx[ri] / Math.max(1, n[ri])) + 0.5) * bp.unit, y: ((sy[ri] / Math.max(1, n[ri])) + 0.5) * bp.unit }));
}
