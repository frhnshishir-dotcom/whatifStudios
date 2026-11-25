import { CHUNK, type World, shiftGrid } from '../world/World';
import { Mat, Cover } from '../world/materials';
import { Gradient, hex, pack, type RGB } from '../core/color';
import { hash2 } from '../core/rng';
import { valueNoise, fbm } from '../core/noise';
import { gs } from './glyphs';

// Terrain look, cached per world cell and rebuilt only for dirty chunks:
//  - land colour: a per-material gradient sampled by light (Lambert hillshade x ambient occlusion), blended softly
//    with neighbouring materials (jittered weights, so borders are organic instead of block edges), with low-frequency
//    variation (dry and lush patches, brighter and darker swathes) and a faint elevation tint;
//  - texture: curated glyph families per material and ground cover, in three density tiers (sparse, mid, dense).
//    Density follows a clump noise field mixed with a per-cell hash, so vegetation forms tufts and bare patches;
//    near borders, vegetation glyphs creep across. All of it is deterministic per cell: nothing flickers;
//  - glyph colour: from the family's tint to its tip colour by density, brighter on sun-facing slopes;
//  - faces (the vertical sides of the oblique view): rock strata that line up horizontally across columns,
//    layered soil, mossy and grassy lips; short steps on vegetated ground read as a shaded bank.

interface MatLook { bg: Gradient; veg: boolean }
const look = (stops: [string, string, string], veg: boolean): MatLook => ({ bg: new Gradient([[0, stops[0]], [0.55, stops[1]], [1, stops[2]]]), veg });

/** Ground colours by material: dark (shadow) -> mid -> lit. */
export const MAT_LOOK: Record<number, MatLook> = {
  [Mat.Grass]: look(['#0f2412', '#2a5427', '#4f8a3a'], true),
  [Mat.Meadow]: look(['#1b2e15', '#4a6e2e', '#86a548'], true),
  [Mat.Dirt]: look(['#24180e', '#4f3a24', '#78573a'], false),
  [Mat.Path]: look(['#2c241b', '#5e5040', '#91806a'], false),
  [Mat.Sand]: look(['#3b311f', '#86744c', '#c2aa74'], false),
  [Mat.Stone]: look(['#22272a', '#4c5458', '#7b8486'], false),
  [Mat.Moss]: look(['#10260f', '#2a5128', '#4a8040'], true),
  [Mat.Cliff]: look(['#1c1e19', '#454840', '#6e7264'], false),
  [Mat.Mud]: look(['#1a140d', '#3b2e1f', '#5a4830'], false),
  [Mat.ForestFloor]: look(['#0b170d', '#1d3420', '#34522c'], true),
  [Mat.Glade]: look(['#0d1a14', '#1d3f30', '#2f5f47'], true),
  [Mat.Snow]: look(['#6f7c88', '#c4ced6', '#f1f5f8'], false),
  [Mat.DryGrass]: look(['#2c2410', '#806a2a', '#d0b052'], true),
  [Mat.Ash]: look(['#120e12', '#36292e', '#5c4a50'], false),
  [Mat.Bog]: look(['#16150c', '#403b22', '#6e6538'], true),
  [Mat.Scree]: look(['#202224', '#555a5c', '#8c9294'], false),
};

/** A glyph family: three density tiers, the share of bare cells, clump size, glyph colours and contrast. */
interface Family {
  tiers: [Uint16Array, Uint16Array, Uint16Array];
  blank: number;
  scale: number;
  tint: RGB;
  tip: RGB;
  contrast: number;
  /** Sparse tier drawn in this colour instead (flower stems). */
  stem?: RGB;
  /** Density thresholds between sparse/mid and mid/dense tiers. */
  split: [number, number];
}
const fam = (sparse: string, mid: string, dense: string, blank: number, scale: number, tint: string, tip: string, contrast: number, stem?: string): Family =>
  ({ tiers: [gs(sparse), gs(mid), gs(dense)], blank, scale, tint: hex(tint), tip: hex(tip), contrast, stem: stem ? hex(stem) : undefined, split: stem ? [0.18, 0.62] : [0.45, 0.8] });

/** Bare ground, by material (used when a cell has no ground cover). */
const MAT_FAMILY: Record<number, Family> = {
  [Mat.Grass]: fam("‚.,'", "ʹ'’‛", 'ʺ"ʷ', 0.7, 3.2, '#8fc463', '#c9ea86', 0.26),
  [Mat.Meadow]: fam("‚'.", "ʹ'’", 'ʺʷ', 0.7, 3.2, '#b4cf6e', '#e2ef96', 0.26),
  [Mat.Dirt]: fam('⋅·.', '∴‚', '⁖⁏', 0.6, 2.4, '#b08d66', '#d4b48a', 0.3),
  [Mat.Path]: fam('⋅·', '◦▫◠', '⌓◡▪', 0.4, 1.6, '#cbbd9c', '#efe4c6', 0.3),
  [Mat.Sand]: fam('⋅·', '∴˚', '⁖∵', 0.58, 2.2, '#e6d4a4', '#fff2cc', 0.24),
  [Mat.Stone]: fam('⋅·⁚', '◜◞⌓◠', '▪◖◗⬮', 0.2, 1.8, '#b4bcbc', '#f0f4f0', 0.36),
  [Mat.Moss]: fam('⋅·', '∴∵', '⁘⁙∷', 0.36, 2.2, '#88c862', '#c2ee96', 0.38),
  [Mat.Cliff]: fam('▘▗⁚', '░▒', '▓◖◗', 0.2, 1.8, '#aeb2a4', '#e0e4d4', 0.34),
  [Mat.Mud]: fam('⋅·', '∼∽', '≃‿', 0.5, 2.4, '#97825e', '#bba57c', 0.28),
  [Mat.ForestFloor]: fam("‚,.", "’‛ʹ", '❦⁏„', 0.46, 2.8, '#7f9a56', '#c6a35a', 0.36),
  [Mat.Glade]: fam('⋅˚', '✧·', '✦⋰', 0.5, 2.6, '#86f0d2', '#d8fff2', 0.62),
  [Mat.Snow]: fam('⋅·', '˚∴', '⁖', 0.78, 2.6, '#ffffff', '#ffffff', 0.16),
  [Mat.DryGrass]: fam("‚.,'", "ʹ'’‛", 'ʺ"ʷ', 0.62, 3.0, '#e2c66c', '#fff0a4', 0.3),
  [Mat.Ash]: fam('⋅·.', '∴⁖⁘', '⁙✶', 0.55, 2.2, '#a08e94', '#cdbcc2', 0.3),
  [Mat.Bog]: fam('⋅·', '∼∽', '≈≃', 0.45, 2.4, '#7e8e5a', '#aebc7c', 0.34),
  [Mat.Scree]: fam('⋅·⁚', '∴⁖◦', '⁘▪◦', 0.28, 1.8, '#b2b6b2', '#e4e7e2', 0.36),
};

/** Ground cover families. */
const COVER_FAMILY: Record<number, Family> = {
  [Cover.ShortGrass]: fam("‚.,'", "ʹ'’‛\"", 'ʺʷ"', 0.56, 3.4, '#96cc66', '#d2f08e', 0.27),
  [Cover.TallGrass]: fam("ʹ'‚", '"ʺ|¦', 'ψʬʷ⁞', 0.3, 2.6, '#a2d066', '#e6f59a', 0.46),
  [Cover.Flowers]: fam("‚ʹ'", '✿❀✾*', '❁✣❃✲⚘', 0.12, 2.2, '#ffffff', '#ffffff', 0.95, '#8cc860'),
  [Cover.Fern]: fam('ψʹ‚', '♧ψ⚘', '❦♣♧', 0.2, 2.4, '#66b85a', '#b2e888', 0.62),
  [Cover.Reeds]: fam("ʹ'|", '¦|ψ', 'Ψ⁞ψ', 0.15, 2, '#c2c674', '#eef0a6', 0.6),
  [Cover.MossPatch]: fam('⋅·', '∴∵⁖', '∷⁘⁙', 0.3, 2.2, '#8acc66', '#c4f09a', 0.42),
  [Cover.Litter]: fam("‚,.", '’‛„', '❦⁏', 0.35, 2.4, '#c4863f', '#e8b468', 0.5),
  [Cover.Clover]: fam("‚'", '♧∴', '☘', 0.3, 2.2, '#78d26a', '#b8f29a', 0.55),
  [Cover.GoldenGrass]: fam("ʹ'‚", '"ʺ|¦', 'ψʬʷ⁞', 0.26, 2.6, '#e6c25e', '#fff2a6', 0.5),
  [Cover.Embers]: fam('⋅·', '∴⁖', '✶⁂', 0.6, 2.0, '#ff4a2a', '#ffb070', 0.95),
  [Cover.Thorns]: fam("ʹ‚", '⌇≀', 'ʬΨ', 0.38, 2.4, '#7c3a4a', '#b45c6c', 0.6),
};
const FLOWER_COLORS: RGB[] = ['#ff9cc0', '#ffd95c', '#f6f4e8', '#bc96ff', '#ff8c66', '#90d4ff'].map(hex);

// Faces (cliff sides): rock strata, layered soil, mossy rock, the diorama base.
interface FaceLook { glyphs: Uint16Array; fg: RGB; bg: RGB }
const SOIL_FACE: FaceLook = { glyphs: gs('▒░▒⁖'), fg: hex('#a07a52'), bg: hex('#3e2b1a') };
const ROCK_FACE: FaceLook = { glyphs: gs('█▓█▓▒'), fg: hex('#8e9294'), bg: hex('#3a3d3f') };
const MOSS_FACE: FaceLook = { glyphs: gs('▒░▓∴'), fg: hex('#86a46a'), bg: hex('#283222') };
const BASE_FACE: FaceLook = { glyphs: gs('▓█▒'), fg: hex('#5e4c3a'), bg: hex('#21180f') };
const SNOW_FACE: FaceLook = { glyphs: gs('█▓█▒'), fg: hex('#e4ebf0'), bg: hex('#a3afb9') };
const LIP = gs('▀▀▀▀▘▝');
const DRIP = gs("‚ʹ'¦");

const rockyMats = new Set<number>([Mat.Stone, Mat.Cliff, Mat.Path, Mat.Snow, Mat.Scree]);

/** Light direction (from upper left, a little towards the viewer). */
const LX = -0.55, LY = 0.3, LZ = 0.78;
const DRY: RGB = hex('#a49a4c'), LUSH: RGB = hex('#1d6a50');
const NB: Array<[number, number, number]> = [[1, 0, 0.32], [-1, 0, 0.32], [0, 1, 0.32], [0, -1, 0.32], [1, 1, 0.16], [-1, 1, 0.16], [1, -1, 0.16], [-1, -1, 0.16]];

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
  /** Rows per metre of the current view (set by the composer; face strata follow absolute height). */
  heightScale = 0.75;
  private c: RGB = [0, 0, 0];
  private c2: RGB = [0, 0, 0];
  private c3: RGB = [0, 0, 0];

  constructor(world: World) {
    this.world = world;
    this.topGlyph = new Uint16Array(world.n);
    this.topFg = new Uint32Array(world.n);
    this.topBg = new Uint32Array(world.n);
    this.shade = new Uint8Array(world.n);
  }

  /** Move the cached shading with the terrain when a streaming window moves; the caller marks the uncovered strip dirty. */
  shift(sx: number, sy: number): void {
    const { w, h } = this.world;
    for (const a of [this.topGlyph, this.topFg, this.topBg, this.shade]) shiftGrid(a, w, h, sx, sy);
  }

  /**
   * Rebuild dirty chunks; returns how many were rebuilt. With a time budget (ms) it stops early and continues next
   * call (streaming re-shades a newly loaded strip over several frames, far from the view).
   */
  update(budgetMs = Infinity): number {
    const w = this.world;
    let n = 0;
    const t0 = budgetMs < Infinity ? performance.now() : 0;
    for (let c = 0; c < w.terrainDirty.length; c++) {
      if (!w.terrainDirty[c]) continue;
      if (n > 0 && budgetMs < Infinity && performance.now() - t0 > budgetMs) break;
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

  /** Light 0..~1.1 at a cell: Lambert hillshade times ambient occlusion. */
  private lightAt(x: number, y: number): [number, number] {
    const w = this.world, h = w.elevAt(x, y);
    const dzdx = (w.elevAt(x + 1, y) - w.elevAt(x - 1, y)) * 0.5;
    const dzdy = (w.elevAt(x, y + 1) - w.elevAt(x, y - 1)) * 0.5;
    const nx = -dzdx * 1.4, ny = -dzdy * 1.4, nz = 1;
    const lambert = Math.max(0, (nx * LX + ny * LY + nz * LZ) / Math.hypot(nx, ny, nz));
    let sum = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += w.elevAt(x + dx, y + dy);
    const ao = Math.min(1, Math.max(0.55, 1 - (sum / 25 - h) * 0.16));
    return [(0.5 + 0.62 * lambert) * ao, lambert];
  }

  private shadeChunk(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.world, c = this.c, c2 = this.c2;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w.w + x;
        const h = w.elev[i];
        const [light, lambert] = this.lightAt(x, y);
        this.shade[i] = Math.min(255, Math.round(light * 127.5));
        const m = w.mat[i];
        const L = MAT_LOOK[m] ?? MAT_LOOK[Mat.Grass];
        const lt = Math.min(1, Math.max(0, (light - 0.28) / 0.92 + (hash2(x, y, 23) - 0.5) * 0.03));

        // Land colour, blended with differing neighbours (jittered weights -> organic borders).
        L.bg.sampleInto(c, lt);
        // Continent biome borders: a cell leans toward the neighbouring biome's ground colour (only while it keeps
        // the material it was generated with); neighbours below are read the same way. The Valley has no blend data.
        const blend = w.blend;
        if (blend) this.lean(blend[i], m, lt, c);
        let r = c[0], g = c[1], b = c[2], wsum = 1;
        let other = -1, otherCount = 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + NB[k][0], ny = y + NB[k][1];
          if (!w.inBounds(nx, ny)) continue;
          const j = ny * w.w + nx, mj = w.mat[j];
          if (mj === m) continue;
          // Rock keeps a crisper edge than soil and vegetation.
          const crisp = m === Mat.Path || mj === Mat.Path ? 0.6 : rockyMats.has(m) || rockyMats.has(mj) ? 0 : 1;
          const wt = NB[k][2] * (0.5 + hash2(x * 3 + NB[k][0], y * 3 + NB[k][1], 5)) * crisp;
          (MAT_LOOK[mj] ?? L).bg.sampleInto(c2, lt);
          if (blend) this.lean(blend[j], mj, lt, c2);
          r += c2[0] * wt; g += c2[1] * wt; b += c2[2] * wt; wsum += wt;
          otherCount++;
          if (hash2(x, y, 40 + k) < 1 / otherCount) other = j;
        }
        r /= wsum; g /= wsum; b /= wsum;
        // Rock is mottled (lichen, cracks and facets) rather than flat.
        if (m === Mat.Stone || m === Mat.Cliff) {
          const mott = 1 + (valueNoise(x / 1.7, y / 1.7, 811) - 0.5) * 0.3 + (hash2(x, y, 812) - 0.5) * 0.08;
          r *= mott; g *= mott; b *= mott;
        }

        // Low-frequency variation: brighter/darker swathes; dry (olive) and lush (blue-green) patches on vegetation.
        const moist = w.moisture[i] / 255;
        const swath = (fbm(x / 22, y / 22, 2, 701) - 0.5) * 0.2;
        r *= 1 + swath; g *= 1 + swath; b *= 1 + swath;
        if (L.veg) {
          const dry = Math.max(0, fbm(x / 30, y / 30, 2, 709) - 0.52) * 1.1 * (1 - moist);
          const lush = moist * 0.14;
          r += (DRY[0] - r) * dry + (LUSH[0] - r) * lush; g += (DRY[1] - g) * dry + (LUSH[1] - g) * lush; b += (DRY[2] - b) * dry + (LUSH[2] - b) * lush;
        }
        // Elevation: high ground a touch paler and cooler, valley floors a touch deeper.
        const et = Math.max(-1, Math.min(1, (h - 12) / 18));
        if (et > 0) { const k = et * 0.08; r += (168 - r) * k; g += (180 - g) * k; b += (182 - b) * k; }
        else { const k = 1 + et * 0.06; r *= k; g *= k; b *= k; }
        this.topBg[i] = pack(r, g, b);

        // Texture glyph: the cell's own family, or (near borders, sometimes) a neighbour's vegetation creeping in.
        let gm = m, gcov = w.cover[i], gvar = w.coverVar[i];
        if (other >= 0 && hash2(x, y, 77) < 0.32) {
          const om = w.mat[other], oc = w.cover[other];
          if (oc !== Cover.None || MAT_LOOK[om]?.veg) { gm = om; gcov = oc; gvar = w.coverVar[other]; }
        }
        const F = gcov !== Cover.None ? COVER_FAMILY[gcov] : MAT_FAMILY[gm] ?? MAT_FAMILY[Mat.Grass];
        const d = valueNoise(x / F.scale, y / F.scale, 300 + gm * 7 + gcov * 13) * 0.62 + hash2(x, y, 11) * 0.38;
        if (d < F.blank) { this.topGlyph[i] = 0; this.topFg[i] = this.topBg[i]; continue; }
        const t = (d - F.blank) / (1 - F.blank);
        const tier = t < F.split[0] ? 0 : t < F.split[1] ? 1 : 2;
        const set = F.tiers[tier];
        this.topGlyph[i] = set[Math.floor(hash2(x, y, 31) * set.length)];
        // Glyph colour: tint -> tip by density and sunlight; flowers take their patch colour (stems stay green).
        let tr: number, tg: number, tb: number;
        if (gcov === Cover.Flowers && !(tier === 0 && F.stem)) {
          const fc = FLOWER_COLORS[gvar % FLOWER_COLORS.length];
          tr = fc[0]; tg = fc[1]; tb = fc[2];
        } else {
          const base = tier === 0 && F.stem ? F.stem : F.tint;
          const u = Math.min(1, t * 0.55 + Math.max(0, lambert - 0.62) * 1.3);
          tr = base[0] + (F.tip[0] - base[0]) * u; tg = base[1] + (F.tip[1] - base[1]) * u; tb = base[2] + (F.tip[2] - base[2]) * u;
        }
        const kk = F.contrast * (0.8 + 0.4 * t) * (0.72 + 0.28 * Math.min(1.25, light));
        this.topFg[i] = pack(r + (tr - r) * kk, g + (tg - g) * kk, b + (tb - b) * kk);
      }
    }
  }

  /** Mix colour `c` (material m at light lt) toward the blend's material, if the blend belongs to material m. */
  private lean(bl: number, m: number, lt: number, c: RGB): void {
    if (!(bl & 255) || bl >>> 16 !== m) return;
    const L2 = MAT_LOOK[(bl >>> 8) & 255];
    if (!L2) return;
    const c3 = this.c3, a = (bl & 255) / 255;
    L2.bg.sampleInto(c3, lt);
    c[0] += (c3[0] - c[0]) * a; c[1] += (c3[1] - c[1]) * a; c[2] += (c3[2] - c[2]) * a;
  }

  /**
   * Face cell `k` rows below the top surface of world cell i (k = 0 is the lip just under the edge).
   * Writes glyph/fg/bg into the out arrays at index o.
   */
  face(i: number, x: number, k: number, total: number, base: boolean, outG: Uint16Array, outF: Uint32Array, outB: Uint32Array, o: number): void {
    const w = this.world;
    const m = w.mat[i];
    const rocky = rockyMats.has(m);
    const look = base ? BASE_FACE : m === Mat.Snow ? SNOW_FACE : rocky ? ROCK_FACE : m === Mat.Moss ? MOSS_FACE : SOIL_FACE;
    // Short steps on vegetated ground (gentle slopes facing the viewer) read as a shaded grassy bank.
    if (!base && total <= 2 && !rocky) {
      const tb = this.topBg[i], dk = k === 0 ? 0.74 : 0.62;
      outG[o] = k === 0 ? LIP[Math.floor(hash2(x, i, 5) * LIP.length)] : 0;
      outF[o] = tb;
      outB[o] = pack((tb & 255) * dk, ((tb >>> 8) & 255) * dk, ((tb >>> 16) & 255) * dk);
      return;
    }
    // Lip: vegetation hangs over the edge (with the odd drip of grass below); rock catches the light on its edge.
    if (k === 0 && !base) {
      const tb = this.topBg[i];
      outG[o] = LIP[Math.floor(hash2(x, i, 5) * LIP.length)];
      outF[o] = rocky ? pack(Math.min(255, (tb & 255) * 1.25), Math.min(255, ((tb >>> 8) & 255) * 1.25), Math.min(255, ((tb >>> 16) & 255) * 1.25)) : tb;
      outB[o] = pack(look.bg[0], look.bg[1], look.bg[2]);
      return;
    }
    if (k === 1 && !base && !rocky && hash2(x, i, 9) < 0.45) {
      outG[o] = DRIP[Math.floor(hash2(x, i, 10) * DRIP.length)];
      const tb = this.topBg[i];
      outF[o] = pack((tb & 255) * 1.2, ((tb >>> 8) & 255) * 1.2, ((tb >>> 16) & 255) * 1.1);
      outB[o] = pack(look.bg[0] * 0.92, look.bg[1] * 0.92, look.bg[2] * 0.92);
      return;
    }
    // Strata follow absolute height, so layers line up across neighbouring columns.
    const z = w.elev[i] - (k + 0.5) / Math.max(0.2, this.heightScale);
    const band = Math.floor(z * 1.4);
    const layer = 0.84 + 0.26 * hash2(band, 0, base ? 3 : rocky ? 1 : 2);
    const strata = hash2(x >> 1, band, 7);
    outG[o] = look.glyphs[Math.floor(strata * look.glyphs.length)];
    const sh = this.shade[i] / 127.5;
    const depthDark = Math.max(0.5, 0.95 - 0.045 * k - (total > 6 ? 0.06 : 0)) * (0.78 + 0.22 * sh) * layer;
    const v = 0.92 + strata * 0.16;
    outF[o] = pack(look.fg[0] * depthDark * v, look.fg[1] * depthDark * v, look.fg[2] * depthDark * v);
    outB[o] = pack(look.bg[0] * depthDark, look.bg[1] * depthDark, look.bg[2] * depthDark);
  }
}
