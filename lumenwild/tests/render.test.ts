import { describe, it, expect } from 'vitest';
import { GLYPH_DEFS, g, gs } from '../src/engine/render/glyphs';
import { drawProcedural } from '../src/engine/render/GlyphAtlas';
import { World } from '../src/engine/world/World';
import { Camera } from '../src/engine/world/Camera';
import { TerrainShader } from '../src/engine/render/TerrainShader';
import { Composer } from '../src/engine/render/Composer';
import { Mat, Cover } from '../src/engine/world/materials';
import { generateTerrain } from '../src/engine/gen/terrain';

describe('glyph registry', () => {
  it('has unique glyphs and resolves the brief\'s glyph sets', () => {
    const chars = GLYPH_DEFS.map((d) => d.ch);
    expect(new Set(chars).size).toBe(chars.length);
    for (const set of ['~≈∿≋░▒·°˚｡', '♣♠♧❀✿❋’,.', '░▒▓█▄▀▖▗▘▝', '✧✦*+°❂☼❋']) expect(() => gs(set)).not.toThrow();
    expect(() => g('☃')).toThrow();
  });
  it('procedural glyphs have the right coverage', () => {
    const cov = (ch: string, w = 10, h = 16) => { const m = new Uint8Array(w * h); drawProcedural(ch, m, w, h); return m.reduce((a, v) => a + v, 0) / (255 * w * h); };
    expect(cov('█')).toBe(1);
    expect(cov('▀')).toBeCloseTo(0.5, 2);
    expect(cov('▄')).toBeCloseTo(0.5, 2);
    expect(cov('▒')).toBeCloseTo(0.5, 2);
    expect(cov('░')).toBeCloseTo(0.25, 2);
    expect(cov('▓')).toBeCloseTo(0.75, 2);
    expect(cov('▖')).toBeCloseTo(0.25, 2);
    expect(cov('│')).toBeGreaterThan(0.05);
  });
});

function testCamera(cols: number, rows: number): Camera {
  const cam = new Camera();
  cam.zoomIndex = 3; // 8 x 13 px
  cam.setViewport(cols * cam.cellW, rows * cam.cellH);
  cam.x = 0; cam.y = 0;
  return cam;
}

describe('oblique projection', () => {
  it('lifts elevated cells, draws cliff faces and occludes', () => {
    const w = new World(16, 16);
    w.mat.fill(Mat.Grass); w.cover.fill(Cover.None);
    // A 4 m high block at x 5..7, y 8..10 (heightScale 0.5 -> 2 rows up).
    for (let y = 8; y <= 10; y++) for (let x = 5; x <= 7; x++) w.elev[w.idx(x, y)] = 4;
    const cam = testCamera(16, 16);
    cam.heightScale = 0.5;
    const comp = new Composer(w, new TerrainShader(w));
    const buf = comp.compose(cam, 0);
    const at = (c: number, r: number) => r * buf.cols + c;
    // Top of the block's front row (y=10) is at screen row 10 - 2 = 8 and picks cell (6, 10).
    expect(buf.pick[at(6, 8)]).toBe(w.idx(6, 10));
    expect(buf.kind[at(6, 8)]).toBe(1);
    // Rows 9 and 10 below it are the block's front face (kind 2), owned by (6, 10).
    expect(buf.kind[at(6, 9)]).toBe(2);
    expect(buf.kind[at(6, 10)]).toBe(2);
    expect(buf.pick[at(6, 10)]).toBe(w.idx(6, 10));
    // The flat cell behind the block (6, 7) at row 7 is hidden: the block top (6, 9) is drawn over it.
    expect(buf.pick[at(6, 7)]).toBe(w.idx(6, 9));
    // Flat ground outside the block maps 1:1.
    expect(buf.pick[at(2, 3)]).toBe(w.idx(2, 3));
  });
  it('generation is deterministic per seed', () => {
    const a = new World(64, 64), b = new World(64, 64), c = new World(64, 64);
    generateTerrain(a, 5); generateTerrain(b, 5); generateTerrain(c, 6);
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev));
    expect(Array.from(a.mat)).toEqual(Array.from(b.mat));
    expect(Array.from(a.elev)).not.toEqual(Array.from(c.elev));
  });
});

describe('camera', () => {
  it('zooms around the cursor', () => {
    const cam = new Camera();
    cam.setViewport(1000, 800);
    cam.x = 50; cam.y = 60;
    const px = 400, py = 300;
    const before = [cam.x + px / cam.cellW, cam.y + py / cam.cellH];
    cam.zoomAt(px, py, 1, 256, 256);
    const after = [cam.x + px / cam.cellW, cam.y + py / cam.cellH];
    expect(after[0]).toBeCloseTo(before[0], 5);
    expect(after[1]).toBeCloseTo(before[1], 5);
  });
  it('pans and stays over the world', () => {
    const cam = new Camera();
    cam.setViewport(800, 600);
    cam.x = 10; cam.y = 10;
    cam.panPixels(-cam.cellW * 5, 0, 256, 256);
    expect(cam.x).toBeCloseTo(15, 5);
    cam.panPixels(1e6, 1e6, 256, 256);
    expect(cam.x).toBeGreaterThanOrEqual(-4);
    expect(cam.y).toBeGreaterThanOrEqual(-12);
  });
});
