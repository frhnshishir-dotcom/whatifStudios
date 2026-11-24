import { CHUNK, type World } from '../world/World';
import { Mat, Cover } from '../world/materials';
import { Gradient, hex, pack, type RGB } from '../core/color';
import { hash2 } from '../core/rng';
import { gs } from './glyphs';

// Terrain look: per-material glyph sets (deterministic variation by cell hash, never random per frame), colour
// gradients, hillshade (light from the upper left, slightly towards the viewer), an ambient-occlusion estimate
// from the local height neighbourhood, and elevation tint. Results are cached per world cell and rebuilt only
// for dirty chunks. Faces (the vertical sides shown in the oblique view) are shaded on the fly.

// Each material: background gradient by light level (the land colour, shaded relief), a glyph tint mixed over the
// background at `contrast`, a glyph set and the share of blank cells (calm ground, detail only where it matters).
interface MatLook { bg: Gradient; tint: RGB; contrast: number; glyphs: Uint16Array; blank: number }
const look = (bg: Array<[number, string]>, tint: string, contrast: number, glyphs: string, blank: number): MatLook =>
  ({ bg: new Gradient(bg), tint: hex(tint), contrast, glyphs: gs(glyphs), blank });

const MAT_LOOK: Record<number, MatLook> = {
  [Mat.Grass]: look([[0, '#10240f'], [0.55, '#2b5226'], [1, '#4d7d36']], '#a8d878', 0.26, ",'.`’", 0.4),
  [Mat.Meadow]: look([[0, '#1a2c14'], [0.55, '#46682b'], [1, '#7c9a42']], '#d8e08a', 0.28, "'.,`\"", 0.4),
  [Mat.Dirt]: look([[0, '#22170d'], [0.55, '#4d3822'], [1, '#715236']], '#c09a6a', 0.3, '.·,∙', 0.45),
  [Mat.Path]: look([[0, '#2a261f'], [0.55, '#5a5244'], [1, '#8a7e66']], '#d8ccb0', 0.32, '▒░▖▗▘▝·', 0.15),
  [Mat.Sand]: look([[0, '#3a3020'], [0.55, '#7d6c48'], [1, '#b49d6a']], '#f0e0b0', 0.25, '·.∙˚', 0.5),
  [Mat.Stone]: look([[0, '#262a2b'], [0.55, '#4f5655'], [1, '#737a77']], '#b8c0bc', 0.26, '.:∙·▘▗', 0.4),
  [Mat.Moss]: look([[0, '#122412'], [0.55, '#2c4c28'], [1, '#4c7a3e']], '#9ad070', 0.32, '░▒:·', 0.35),
  [Mat.Cliff]: look([[0, '#1f211b'], [0.55, '#474a40'], [1, '#6c6f62']], '#b8bcac', 0.3, '▓▒░▓', 0.2),
  [Mat.Mud]: look([[0, '#1a140d'], [0.55, '#3a2d1f'], [1, '#56452e']], '#9a8460', 0.28, '~·.,', 0.45),
  [Mat.ForestFloor]: look([[0, '#0c160c'], [0.55, '#1f3219'], [1, '#33502a']], '#8aa060', 0.3, ",.·`'", 0.4),
  [Mat.Glade]: look([[0, '#0d1d1e'], [0.55, '#1c4644'], [1, '#2c7470']], '#b8fff0', 0.45, '·˚.✧', 0.4),
};

interface CoverLook { tint: RGB; contrast: number; glyphs: Uint16Array; blank: number }
const cover = (tint: string, contrast: number, glyphs: string, blank = 0): CoverLook => ({ tint: hex(tint), contrast, glyphs: gs(glyphs), blank });
const FLOWER_COLORS: RGB[] = ['#ff9cc0', '#ffd95c', '#f6f4e8', '#bc96ff', '#ff8c66', '#90d4ff'].map(hex);
const COVER_LOOK: Record<number, CoverLook> = {
  [Cover.ShortGrass]: cover('#b4e07c', 0.3, ",'`’.\"", 0.35),
  [Cover.TallGrass]: cover('#c2e486', 0.55, 'ʬψ"\'|'),
  [Cover.Flowers]: cover('#ffffff', 0.95, '✿❀❁✾✣*'),
  [Cover.Fern]: cover('#86d070', 0.6, '♣♧ψ❦♠'),
  [Cover.Reeds]: cover('#d2d488', 0.55, '|¦ψΨ\''),
  [Cover.MossPatch]: cover('#94d878', 0.38, '░▒:·'),
  [Cover.Litter]: cover('#d89a50', 0.45, ",.`·'"),
  [Cover.Clover]: cover('#8ae07a', 0.5, "☘♧,'"),
};

// Face (cliff side) looks: soil under vegetated ground, rock under stone.
const SOIL_FACE = { glyphs: gs('▒▓▒░'), fg: hex('#a07a52'), bg: hex('#3e2b1a') };
const ROCK_FACE = { glyphs: gs('▓█▓▒'), fg: hex('#a8aa9e'), bg: hex('#3a3c34') };
const MOSS_FACE = { glyphs: gs('▒░▓:'), fg: hex('#86a46a'), bg: hex('#283222') };
const BASE_FACE = { glyphs: gs('▓█▒'), fg: hex('#5e4c3a'), bg: hex('#21180f') };
const LIP = gs('▀▀▀▀▘▝');

const rockyMats = new Set<number>([Mat.Stone, Mat.Cliff, Mat.Path]);

/** Light direction (from upper left, a little towards the viewer). */
const LX = -0.55, LY = 0.3, LZ = 0.78;

export class TerrainShader {
  readonly world: World;
  readonly topGlyph: Uint16Array;
  readonly topFg: Uint32Array;
  readonly topBg: Uint32Array;
  /** Lighting factor per cell (hillshade x AO), 0..255 -> 0..2. Reused by water and objects. */
  readonly shade: Uint8Array;
  maxElev = 0;
  minElev = 0;
  rebuiltChunks = 0;

  constructor(world: World) {
    this.world = world;
    this.topGlyph = new Uint16Array(world.n);
    this.topFg = new Uint32Array(world.n);
    this.topBg = new Uint32Array(world.n);
    this.shade = new Uint8Array(world.n);
  }

  /** Rebuild dirty chunks; returns how many were rebuilt. */
  update(): number {
    const w = this.world;
    let n = 0;
    for (let c = 0; c < w.terrainDirty.length; c++) {
      if (!w.terrainDirty[c]) continue;
      w.terrainDirty[c] = 0;
      const cx = c % w.chunksX, cy = Math.floor(c / w.chunksX);
      this.shadeChunk(cx * CHUNK, cy * CHUNK, Math.min(w.w, cx * CHUNK + CHUNK), Math.min(w.h, cy * CHUNK + CHUNK));
      n++;
    }
    if (n) {
      let mx = -1e9, mn = 1e9;
      for (let i = 0; i < w.n; i++) { const e = w.elev[i]; if (e > mx) mx = e; if (e < mn) mn = e; }
      this.maxElev = mx;
      this.minElev = mn;
    }
    this.rebuiltChunks += n;
    return n;
  }

  private shadeChunk(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.world;
    const bg: RGB = [0, 0, 0];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w.w + x;
        const h = w.elev[i];
        // Hillshade from central differences.
        const dzdx = (w.elevAt(x + 1, y) - w.elevAt(x - 1, y)) * 0.5;
        const dzdy = (w.elevAt(x, y + 1) - w.elevAt(x, y - 1)) * 0.5;
        const nx = -dzdx * 1.4, ny = -dzdy * 1.4, nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        const lambert = Math.max(0, (nx * LX + ny * LY + nz * LZ) * inv);
        // Ambient occlusion: cells lower than their 5x5 neighbourhood (creases, valley floors) get darker.
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += w.elevAt(x + dx, y + dy);
        const ao = Math.min(1, Math.max(0.55, 1 - (sum / 25 - h) * 0.16));
        const light = (0.5 + 0.62 * lambert) * ao;
        this.shade[i] = Math.min(255, Math.round(light * 127.5));

        const m = w.mat[i], cov = w.cover[i];
        const r = hash2(x, y, 11), r2 = hash2(x, y, 23);
        const L = MAT_LOOK[m] ?? MAT_LOOK[Mat.Grass];
        // Land colour: material gradient by light (+ a little per-cell and moisture variation), elevation tint.
        const lt = Math.min(1, Math.max(0, (light - 0.28) / 0.92 + (r2 - 0.5) * (rockyMats.has(m) ? 0.03 : 0.06)));
        L.bg.sampleInto(bg, lt);
        const moist = w.moisture[i] / 255;
        const et = Math.max(0, Math.min(1, (h - 10) / 20)) * 0.12;
        bg[0] = (bg[0] + (150 - bg[0]) * et) * (0.94 + moist * 0.08);
        bg[1] = (bg[1] + (165 - bg[1]) * et) * (0.96 + moist * 0.06);
        bg[2] = bg[2] + (170 - bg[2]) * et;
        let glyph = 0, tint = L.tint, k = L.contrast;
        const C = cov !== Cover.None ? COVER_LOOK[cov] : undefined;
        if (C) {
          if (r >= C.blank) glyph = C.glyphs[Math.floor(hash2(x, y, 31) * C.glyphs.length)];
          tint = cov === Cover.Flowers ? FLOWER_COLORS[w.coverVar[i] % FLOWER_COLORS.length] : C.tint;
          k = C.contrast;
        } else if (r >= L.blank) glyph = L.glyphs[Math.floor(hash2(x, y, 31) * L.glyphs.length)];
        const kk = k * (0.85 + r2 * 0.3) * (0.7 + 0.3 * Math.min(1.3, light));
        this.topGlyph[i] = glyph;
        this.topFg[i] = pack(bg[0] + (tint[0] - bg[0]) * kk, bg[1] + (tint[1] - bg[1]) * kk, bg[2] + (tint[2] - bg[2]) * kk);
        this.topBg[i] = pack(bg[0], bg[1], bg[2]);
      }
    }
  }

  /**
   * Face cell `k` rows below the top surface of world cell i (k = 0 is the lip just under the edge).
   * Writes glyph/fg/bg into the out arrays at index o.
   */
  face(i: number, x: number, k: number, total: number, base: boolean, outG: Uint16Array, outF: Uint32Array, outB: Uint32Array, o: number): void {
    const w = this.world;
    const m = w.mat[i];
    const look = base ? BASE_FACE : rockyMats.has(m) ? ROCK_FACE : m === Mat.Moss ? MOSS_FACE : SOIL_FACE;
    // Grass lip: vegetated tops hang a little over the edge.
    if (k === 0 && !base && !rockyMats.has(m)) {
      outG[o] = LIP[Math.floor(hash2(x, i, 5) * LIP.length)];
      outF[o] = this.topBg[i];
      outB[o] = pack(look.bg[0], look.bg[1], look.bg[2]);
      return;
    }
    const strata = hash2(x, (k >> 1) + Math.floor(w.elev[i]), 7);
    outG[o] = look.glyphs[Math.floor(strata * look.glyphs.length)];
    const sh = this.shade[i] / 127.5;
    const depthDark = Math.max(0.5, 0.95 - 0.05 * k - (total > 6 ? 0.08 : 0)) * (0.78 + 0.22 * sh);
    const v = 0.9 + strata * 0.2;
    outF[o] = pack(look.fg[0] * depthDark * v, look.fg[1] * depthDark * v, look.fg[2] * depthDark * v);
    outB[o] = pack(look.bg[0] * depthDark, look.bg[1] * depthDark, look.bg[2] * depthDark);
  }
}
