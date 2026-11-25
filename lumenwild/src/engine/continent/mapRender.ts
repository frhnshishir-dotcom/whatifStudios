import { SIZE, Biome, Use, Water, type Continent, type Village } from './types';
import { CULTURES } from './cultures';
import { kindAt } from './trails';
import { valueNoise } from '../core/noise';

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const pack = (c: RGB) => (0xff000000 | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const BIOME_RGB: Record<number, RGB> = {
  [Biome.Heartlands]: hex('#6f8f4a'), [Biome.DragonPeaks]: hex('#7b7f80'), [Biome.GoldenPlains]: hex('#a3a05c'),
  [Biome.WhisperingMarshes]: hex('#5d7154'), [Biome.Elderwood]: hex('#3f6a3a'), [Biome.Thornwild]: hex('#55693a'),
};
const FOREST: RGB = hex('#1f3d22'), SNOW: RGB = hex('#e8eef0');
const WATER_RGB: Record<number, RGB> = { [Water.River]: hex('#3f86b8'), [Water.Lake]: hex('#2f6f9e'), [Water.Marsh]: hex('#4d7a6a') };
const TRAIL_RGB: Record<string, RGB> = { footpath: hex('#9c6b3a'), 'forest-trail': hex('#8a5f30'), 'mountain-pass': hex('#d8cdb6'), boardwalk: hex('#a8946a') };
const FARM_RGB: Record<string, RGB> = { fields: hex('#d6b85a'), pasture: hex('#a3c36b'), ponds: hex('#4f8f8a'), gardens: hex('#86b05e') };

const blurred = new WeakMap<Continent, Float32Array>();

/** Biome colours blurred over about 12 cells, so regions blend into each other instead of meeting at hard lines. */
function biomeColours(c: Continent): Float32Array {
  const hit = blurred.get(c);
  if (hit) return hit;
  const W = SIZE, n = W * W;
  let a = new Float32Array(n * 3), b = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const col = BIOME_RGB[c.biome[i]] ?? BIOME_RGB[Biome.Heartlands];
    a[i * 3] = col[0]; a[i * 3 + 1] = col[1]; a[i * 3 + 2] = col[2];
  }
  const R = 6, span = 2 * R + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (const horiz of [true, false]) {
      for (let line = 0; line < W; line++) {
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0;
          const at = (k: number) => { const kk = Math.max(0, Math.min(W - 1, k)); return (horiz ? line * W + kk : kk * W + line) * 3 + ch; };
          for (let k = -R; k <= R; k++) sum += a[at(k)];
          for (let k = 0; k < W; k++) {
            b[at(k)] = sum / span;
            sum += a[at(k + R + 1)] - a[at(k - R)];
          }
        }
      }
      [a, b] = [b, a];
    }
  }
  blurred.set(c, a);
  return a;
}

/** Base terrain colour of a cell: biome, tree cover, snow, hillshade (light from the north-west), water. */
function terrainRGB(c: Continent, x: number, y: number): RGB {
  const W = SIZE, i = y * W + x, b = c.biome[i];
  if (b === Biome.Sea) {
    const d = Math.min(1, -c.height[i] / 25);
    return mix(hex('#2a5674'), hex('#0e2233'), d);
  }
  const wv = c.water[i];
  if (wv !== Water.None) return WATER_RGB[wv] ?? WATER_RGB[Water.River];
  const bc = biomeColours(c);
  let col: RGB = [bc[i * 3], bc[i * 3 + 1], bc[i * 3 + 2]];
  col = mix(col, FOREST, (c.forest[i] / 255) * 0.75);
  const h = c.height[i];
  if (h > 95) col = mix(col, SNOW, Math.min(1, (h - 95) / 25));
  const hx = c.height[i + (x < W - 1 ? 1 : 0)] - c.height[i - (x > 0 ? 1 : 0)];
  const hy = c.height[i + (y < W - 1 ? W : 0)] - c.height[i - (y > 0 ? W : 0)];
  // Hillshade plus a soft mottling, so flat grassland is not a single flat colour.
  const shade = Math.max(0.55, Math.min(1.35, 1 - (hx + hy) * 0.09)) * (0.93 + 0.14 * valueNoise(x * 0.07, y * 0.07, 7));
  return [col[0] * shade, col[1] * shade, col[2] * shade].map((v) => Math.min(255, v)) as RGB;
}

/** The whole continent, one pixel per cell (1024 x 1024), with land use and paths painted in. */
export function renderContinent(c: Continent, out: Uint32Array): void {
  const W = SIZE;
  const farmKind = new Map<number, string>();
  for (const v of c.villages) for (const f of [...v.fields, ...v.pens]) {
    const k = CULTURES[v.culture].farm.kind;
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) farmKind.set(y * W + x, v.pens.includes(f) ? 'pasture' : k);
  }
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let col = terrainRGB(c, x, y);
    switch (c.use[i]) {
      case Use.Village: col = mix(col, hex('#c4b08c'), 0.55); break;
      case Use.Farmland: col = mix(col, FARM_RGB[farmKind.get(i) ?? 'fields'], y % 3 === 0 ? 0.32 : 0.5); break;
      case Use.Outpost: col = mix(col, hex('#d38c4c'), 0.55); break;
      case Use.Special: col = mix(col, hex('#9b7cc0'), 0.15); break;
      case Use.AncientRoad: col = mix(col, hex('#c4b9a0'), 0.7); break;
      case Use.Trail: col = TRAIL_RGB[kindAt(c.biome[i], c.water[i])] ?? TRAIL_RGB.footpath; break;
    }
    out[i] = pack(col);
  }
  for (const v of c.villages) for (const b of v.buildings) {
    const pal = CULTURES[v.culture].architecture.palette;
    const roof = hex(pal.roof), trim = hex(pal.trim);
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) out[y * W + x] = pack(x === b.x || y === b.y || x === b.x + b.w - 1 || y === b.y + b.h - 1 ? trim : roof);
  }
  for (const k of c.crossings) out[k.y * W + k.x] = pack(k.kind === 'stone-crossing' ? hex('#b8b8b0') : hex('#c08040'));
}

/**
 * A village close-up: `scale` pixels per cell over a square of `2 * radius` cells around its centre. Buildings in the
 * culture's palette (roof, trim, accent for raised ones), lanes, fields and pens with hedges.
 */
export function renderVillage(c: Continent, v: Village, radius: number, scale: number, out: Uint32Array): void {
  const W = SIZE, n = radius * 2, px = n * scale;
  const x0 = v.centre[0] - radius, y0 = v.centre[1] - radius;
  const pal = CULTURES[v.culture].architecture.palette;
  const roof = hex(pal.roof), wall = hex(pal.wall), trim = hex(pal.trim), accent = hex(pal.accent);
  const farmCol = FARM_RGB[CULTURES[v.culture].farm.kind];
  const fill = (cx: number, cy: number, col: RGB) => {
    const p = pack(col);
    for (let yy = 0; yy < scale; yy++) out.fill(p, (cy * scale + yy) * px + cx * scale, (cy * scale + yy) * px + cx * scale + scale);
  };
  for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
    const x = x0 + cx, y = y0 + cy;
    if (x < 0 || y < 0 || x >= W || y >= W) { fill(cx, cy, [10, 14, 12]); continue; }
    const i = y * W + x;
    let col = terrainRGB(c, x, y);
    if (c.use[i] === Use.Village) col = mix(col, hex('#b9a47e'), 0.35);
    if (c.use[i] === Use.Trail) col = TRAIL_RGB[kindAt(c.biome[i], c.water[i])];
    if (c.forest[i] > 200 && c.use[i] !== Use.Farmland) col = mix(col, hex('#173219'), 0.5);
    fill(cx, cy, col);
  }
  const rect = (r: { x: number; y: number; w: number; h: number }, f: (lx: number, ly: number) => RGB | null) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const cx = x - x0, cy = y - y0;
      if (cx < 0 || cy < 0 || cx >= n || cy >= n) continue;
      const col = f(x - r.x, y - r.y);
      if (col) fill(cx, cy, col);
    }
  };
  const kind = CULTURES[v.culture].farm.kind;
  v.fields.forEach((f, k) => {
    const tint = mix(farmCol, hex(k % 3 === 0 ? '#9a8a40' : k % 3 === 1 ? '#c8c070' : '#a8b060'), 0.3);
    if (kind === 'ponds' || kind === 'gardens') {
      // Fish ponds and forest gardens are soft-edged, not rectangles.
      rect(f, (lx, ly) => {
        const dx = (lx + 0.5 - f.w / 2) / (f.w / 2), dy = (ly + 0.5 - f.h / 2) / (f.h / 2), d = dx * dx + dy * dy;
        if (d > 1) return null;
        return kind === 'ponds' ? (d > 0.7 ? hex('#6f8a52') : mix(hex('#3f7f86'), hex('#2f6670'), d)) : ((lx + ly) % 3 ? tint : mix(tint, hex('#3f6a2a'), 0.4));
      });
    } else {
      const alongX = f.w >= f.h;
      rect(f, (lx, ly) => ((alongX ? ly : lx) % 2 ? tint : mix(tint, hex('#7a6a32'), 0.22)));
    }
  });
  for (const p of v.pens) rect(p, (lx, ly) => (lx === 0 || ly === 0 || lx === p.w - 1 || ly === p.h - 1 ? hex('#6b4a2a') : hex('#a3c36b')));
  for (const l of v.lanes) for (const [x, y] of l) {
    const cx = x - x0, cy = y - y0;
    if (cx >= 0 && cy >= 0 && cx < n && cy < n) fill(cx, cy, v.culture === 'marsh-stilt' ? hex('#a8946a') : hex('#a07a4c'));
  }
  for (const b of v.buildings) {
    rect(b, (lx, ly) => {
      const edge = lx === 0 || ly === 0 || lx === b.w - 1 || ly === b.h - 1;
      if (!b.counts) return edge ? trim : accent;
      if (edge) return b.raised ? accent : trim;
      return ly < b.h / 2 ? roof : mix(roof, wall, 0.35);
    });
  }
}
