import { describe, it, expect } from 'vitest';
import { World } from '../src/engine/world/World';
import { TerrainShader } from '../src/engine/render/TerrainShader';
import { Mat, Cover } from '../src/engine/world/materials';
import { generateWorld } from '../src/engine/gen/world';
import { ObjectStore } from '../src/engine/objects/ObjectStore';

const lum = (c: number) => 0.2126 * (c & 255) + 0.7152 * ((c >>> 8) & 255) + 0.0722 * ((c >>> 16) & 255);
const g = (c: number) => (c >>> 8) & 255;

function flat(left: number, right: number, cover = Cover.None): World {
  const w = new World(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = y * 64 + x;
    w.elev[i] = 5; w.mat[i] = x < 32 ? left : right; w.cover[i] = cover;
  }
  w.markAllDirty();
  return w;
}

describe('terrain shading (visual upgrade, phase B)', () => {
  it('is deterministic: the same world shades to identical glyphs and colours', () => {
    const a = new World(256, 256), b = new World(256, 256);
    generateWorld(a, new ObjectStore(a), 7); generateWorld(b, new ObjectStore(b), 7);
    const sa = new TerrainShader(a), sb = new TerrainShader(b);
    sa.update(); sb.update();
    expect(sa.topGlyph).toEqual(sb.topGlyph);
    expect(sa.topFg).toEqual(sb.topFg);
    expect(sa.topBg).toEqual(sb.topBg);
    // Rebuilding a chunk gives the same result (no per-frame or per-call randomness).
    const before = Uint32Array.from(sa.topBg);
    a.markTerrainDirty(100, 100, 120, 120);
    sa.update();
    expect(sa.topBg).toEqual(before);
  });

  it('vegetation borders blend over a cell or two; rock keeps a crisp edge', () => {
    const w = flat(Mat.ForestFloor, Mat.Meadow);
    const s = new TerrainShader(w); s.update();
    const row = (x: number) => { let v = 0; for (let y = 10; y < 54; y++) v += g(s.topBg[y * 64 + x]); return v / 44; };
    const inL = row(20), inR = row(44), edgeL = row(31), edgeR = row(32);
    expect(inR).toBeGreaterThan(inL + 20);
    // Border cells sit between the two interiors.
    expect(edgeL).toBeGreaterThan(inL + 3);
    expect(edgeR).toBeLessThan(inR - 3);
    const r = flat(Mat.Grass, Mat.Stone);
    const sr = new TerrainShader(r); sr.update();
    let mixed = 0;
    for (let y = 10; y < 54; y++) {
      const a = sr.topBg[y * 64 + 31], b = sr.topBg[y * 64 + 30];
      if (Math.abs(g(a) - g(b)) > 12) mixed++;
    }
    expect(mixed).toBeLessThan(6); // the grass cell next to stone is not pulled toward grey
  });

  it('ground cover forms clumps: a glyph cell is more likely to have glyph neighbours than chance', () => {
    const w = flat(Mat.Grass, Mat.Grass, Cover.ShortGrass);
    const s = new TerrainShader(w); s.update();
    let on = 0, pairs = 0, both = 0;
    for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) {
      const a = s.topGlyph[y * 64 + x] !== 0;
      if (a) on++;
      const b = s.topGlyph[y * 64 + x + 1] !== 0;
      if (a) { pairs++; if (b) both++; }
    }
    const p = on / (62 * 62), pCond = both / pairs;
    expect(p).toBeGreaterThan(0.25);
    expect(p).toBeLessThan(0.8); // bare patches remain
    expect(pCond).toBeGreaterThan(p + 0.05);
  });

  it('lit slopes are brighter than shaded slopes, and every land cell gets a colour', () => {
    const w = new World(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const i = y * 64 + x;
      w.elev[i] = 10 - Math.abs(x - 32) * 0.6; // a ridge along y: west face lit, east face in shade
      w.mat[i] = Mat.Grass;
    }
    w.markAllDirty();
    const s = new TerrainShader(w); s.update();
    let lit = 0, shaded = 0;
    for (let y = 10; y < 54; y++) { lit += lum(s.topBg[y * 64 + 25]); shaded += lum(s.topBg[y * 64 + 39]); }
    expect(lit).toBeGreaterThan(shaded * 1.15);
    for (let i = 0; i < w.n; i++) expect(s.topBg[i] >>> 24).toBe(255);
  });
});
