import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain, WK_NONE, type RegionData } from '../src/world/terrain';
import { MAT_LOOK } from '../src/engine/render/TerrainShader';
import { ecologyAffinity, biomeShares, pickBiome } from '../src/world/ecotone';

/**
 * Biome borders as natural patches: deterministic, seamless, no speckle or checkerboard, patches of real size,
 * ground colour that changes gradually, and vegetation that follows the ground (elevation, slope, wetness).
 * Each border is sampled over 3 x 3 regions (768 x 768 m) centred on it.
 */
const BORDERS: Array<[string, number, number]> = [
  ['elderwood-heartlands', 458, 514], ['heartlands-plains', 393, 722], ['peaks-heartlands', 560, 296], ['heartlands-marshes', 648, 672],
];
const S = 256, MPU = 100, W = 3 * S;
let bp: Blueprint, ct: ContinentTerrain;
const windows: Record<string, { regions: RegionData[]; biome: Uint8Array; mat: Uint8Array; blend: Uint32Array; elev: Float32Array; kind: Uint8Array }> = {};

function windowAt(t: ContinentTerrain, ux: number, uy: number) {
  const rx = Math.floor((ux * MPU) / S) - 1, ry = Math.floor((uy * MPU) / S) - 1, regions: RegionData[] = [];
  const biome = new Uint8Array(W * W), mat = new Uint8Array(W * W), blend = new Uint32Array(W * W), elev = new Float32Array(W * W), kind = new Uint8Array(W * W);
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
    const r = t.generateRegion(rx + gx, ry + gy);
    regions.push(r);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const a = (gy * S + j) * W + gx * S + i, b = j * S + i;
      biome[a] = r.biome[b]; mat[a] = r.mat[b]; blend[a] = r.blend[b]; elev[a] = r.elev[b]; kind[a] = r.waterKind[b];
    }
  }
  return { regions, biome, mat, blend, elev, kind };
}

/** The rendered ground colour's mid tone, including the blend toward the neighbouring biome. */
function groundColour(m: number, bl: number): [number, number, number] {
  const t = MAT_LOOK[m].bg.table, q = 140 * 3;
  let c: [number, number, number] = [t[q], t[q + 1], t[q + 2]];
  if (bl & 255 && bl >>> 16 === m) {
    const t2 = MAT_LOOK[(bl >>> 8) & 255].bg.table, a = (bl & 255) / 255;
    c = [c[0] + (t2[q] - c[0]) * a, c[1] + (t2[q + 1] - c[1]) * a, c[2] + (t2[q + 2] - c[2]) * a];
  }
  return c;
}

beforeAll(() => {
  bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp);
  for (const [id, x, y] of BORDERS) windows[id] = windowAt(ct, x, y);
}, 180_000);

describe('biome transitions are natural patches', { timeout: 180_000 }, () => {
  it('is deterministic: a fresh generator gives identical biomes, ground, blend and vegetation', () => {
    const ct2 = new ContinentTerrain(buildBlueprint(WORLD));
    for (const [id, x, y] of BORDERS) {
      const rx = Math.floor((x * MPU) / S), ry = Math.floor((y * MPU) / S);
      const a = ct2.generateRegion(rx, ry), b = windows[id].regions[4];
      expect(Buffer.from(a.biome).equals(Buffer.from(b.biome)), id).toBe(true);
      expect(Buffer.from(a.mat).equals(Buffer.from(b.mat)), id).toBe(true);
      expect(Buffer.from(a.cover).equals(Buffer.from(b.cover)), id).toBe(true);
      expect(Buffer.from(a.blend.buffer).equals(Buffer.from(b.blend.buffer)), id).toBe(true);
      expect(a.objects).toEqual(b.objects);
    }
  });

  it('every border is a real mix of both biomes in this window', () => {
    for (const [id] of BORDERS) {
      const w = windows[id], count = new Map<number, number>();
      let land = 0;
      for (let k = 0; k < W * W; k++) if (w.kind[k] === WK_NONE) { land++; count.set(w.biome[k], (count.get(w.biome[k]) ?? 0) + 1); }
      const shares = [...count.values()].map((v) => v / land).sort((p, q) => q - p);
      console.log(`${id}: biome shares ${shares.map((v) => (v * 100).toFixed(0) + '%').join(', ')}`);
      expect(shares[1], id).toBeGreaterThan(0.08);
    }
  });

  it('no speckle or checkerboard: almost no cell stands alone, no alternating 2 x 2 blocks', () => {
    for (const [id] of BORDERS) {
      const w = windows[id];
      let alone = 0, checker = 0, n = 0, blocks = 0;
      for (let y = 1; y < W - 1; y++) for (let x = 1; x < W - 1; x++) {
        const k = y * W + x, b = w.biome[k];
        if (b === 255) continue;
        n++;
        if (w.biome[k - 1] !== b && w.biome[k + 1] !== b && w.biome[k - W] !== b && w.biome[k + W] !== b) alone++;
        const r = w.biome[k + 1], d = w.biome[k + W], dr = w.biome[k + W + 1];
        blocks++;
        if (b === dr && r === d && b !== r) checker++;
      }
      console.log(`${id}: isolated cells ${(100 * alone / n).toFixed(3)}%, checker blocks ${(100 * checker / blocks).toFixed(3)}%`);
      expect(alone / n, id).toBeLessThan(0.001);
      expect(checker / blocks, id).toBeLessThan(0.001);
    }
  });

  it('patches have real size: tiny islands are rare and runs across the mix are tens of metres long', () => {
    for (const [id] of BORDERS) {
      const w = windows[id], seen = new Uint8Array(W * W), stack: number[] = [];
      let small = 0, cells = 0;
      for (let s = 0; s < W * W; s++) {
        if (seen[s] || w.biome[s] === 255) continue;
        const b = w.biome[s];
        let size = 0, edge = false;
        stack.push(s); seen[s] = 1;
        while (stack.length) {
          const k = stack.pop()!, x = k % W, y = (k / W) | 0;
          size++;
          if (x === 0 || y === 0 || x === W - 1 || y === W - 1) edge = true;
          for (const q of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, y > 0 ? k - W : -1, y < W - 1 ? k + W : -1]) if (q >= 0 && !seen[q] && w.biome[q] === b) { seen[q] = 1; stack.push(q); }
        }
        cells += size;
        if (size < 25 && !edge) small += size;
      }
      // Mean run length along rows, counted only where the biome changes within the row (the mixed band).
      let runs = 0, changes = 0;
      for (let y = 0; y < W; y += 8) for (let x = 1; x < W; x++) { runs++; if (w.biome[y * W + x] !== w.biome[y * W + x - 1]) changes++; }
      const meanRun = runs / Math.max(1, changes);
      console.log(`${id}: cells in islands under 25 m² ${(100 * small / cells).toFixed(3)}%; mean run between biome changes ${meanRun.toFixed(0)} m`);
      expect(small / cells, id).toBeLessThan(0.005);
      expect(meanRun, id).toBeGreaterThan(20);
    }
  });

  it('patches meet seamlessly across region edges (the edge changes biome no more often than any other line)', () => {
    for (const [id] of BORDERS) {
      const w = windows[id];
      const rate = (x: number) => { let c = 0; for (let y = 0; y < W; y++) if (w.biome[y * W + x] !== w.biome[y * W + x - 1]) c++; return c / W; };
      const inside: number[] = [];
      for (let x = 1; x < W; x++) if (x % S) inside.push(rate(x));
      const mean = inside.reduce((a, b) => a + b, 0) / inside.length, edge = Math.max(rate(S), rate(2 * S));
      expect(edge, id).toBeLessThanOrEqual(Math.max(0.05, mean * 4));
    }
  });

  it('ground colour blends across patch edges, and the mix changes gradually across the border', () => {
    let raw = 0, blended = 0, pairs = 0;
    for (const [id] of BORDERS) {
      const w = windows[id];
      const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      for (let y = 0; y < W; y++) for (let x = 1; x < W; x++) {
        const a = y * W + x - 1, b = a + 1;
        if (w.biome[a] === w.biome[b] || w.kind[a] !== WK_NONE || w.kind[b] !== WK_NONE || w.biome[a] === 255 || w.biome[b] === 255) continue;
        raw += dist(groundColour(w.mat[a], 0), groundColour(w.mat[b], 0));
        blended += dist(groundColour(w.mat[a], w.blend[a]), groundColour(w.mat[b], w.blend[b]));
        pairs++;
      }
      // The second biome's share in 64 m bands, along whichever axis it changes most: no jumps.
      const top = (() => { const c = new Map<number, number>(); for (const v of w.biome) c.set(v, (c.get(v) ?? 0) + 1); return [...c.entries()].filter(([k]) => k !== 255).sort((p, q) => q[1] - p[1]).map(([k]) => k); })();
      let bestRange = 0, bestStep = 0;
      for (const ax of [true, false]) {
        const sh: number[] = [];
        for (let band = 0; band < W / 64; band++) {
          let n = 0, c = 0;
          for (let a = band * 64; a < band * 64 + 64; a++) for (let o = 0; o < W; o += 2) { const k = ax ? o * W + a : a * W + o; if (w.kind[k] !== WK_NONE) continue; n++; if (w.biome[k] === top[1]) c++; }
          sh.push(c / Math.max(1, n));
        }
        const range = Math.max(...sh) - Math.min(...sh);
        let step = 0;
        for (let k = 1; k < sh.length; k++) step = Math.max(step, Math.abs(sh[k] - sh[k - 1]));
        if (range > bestRange) { bestRange = range; bestStep = step; }
      }
      console.log(`${id}: second biome share across the window rises by ${(bestRange * 100).toFixed(0)} points, largest step between 64 m bands ${(bestStep * 100).toFixed(0)} points`);
      expect(bestStep, id).toBeLessThan(0.3);
    }
    console.log(`colour jump at patch edges: ${(raw / pairs).toFixed(1)} without the blend, ${(blended / pairs).toFixed(1)} with it (${pairs} edges)`);
    expect(blended / pairs).toBeLessThan((raw / pairs) * 0.75);
  });

  it('vegetation follows the ground: Peaks up the slopes, marsh in the wet', () => {
    // Peaks / Heartlands: within the mixed band, Peaks patches are commoner on steep ground than on flat ground.
    const peaks = WORLD.regions.findIndex((r) => r.id === 'dragon-peaks'), w = windows['peaks-heartlands'];
    let steepP = 0, steepN = 0, flatP = 0, flatN = 0;
    for (let y = 1; y < W - 1; y++) for (let x = 1; x < W - 1; x++) {
      const k = y * W + x;
      if (w.kind[k] !== WK_NONE) continue;
      const sl = Math.hypot(w.elev[k + 1] - w.elev[k - 1], w.elev[k + W] - w.elev[k - W]) / 2, isP = w.biome[k] === peaks ? 1 : 0;
      if (sl > 0.3) { steepN++; steepP += isP; } else if (sl < 0.1) { flatN++; flatP += isP; }
    }
    console.log(`peaks share: steep ${(100 * steepP / steepN).toFixed(0)}%, flat ${(100 * flatP / flatN).toFixed(0)}%`);
    expect(steepP / steepN).toBeGreaterThan((flatP / flatN) * 1.2);
    // The ecology rules themselves.
    expect(ecologyAffinity('whispering-marshes', 30, 0.02, 0.9)).toBeGreaterThan(ecologyAffinity('whispering-marshes', 30, 0.02, 0.1) + 1.5);
    expect(ecologyAffinity('whispering-marshes', 30, 0.3, 0.9)).toBeLessThan(ecologyAffinity('whispering-marshes', 30, 0.02, 0.9) - 2);
    expect(ecologyAffinity('golden-plains', 100, 0.02, 0.1)).toBeGreaterThan(ecologyAffinity('golden-plains', 100, 0.02, 0.9));
    expect(ecologyAffinity('elderwood', 300, 0.1, 0.9)).toBeGreaterThan(ecologyAffinity('elderwood', 300, 0.1, 0.1));
    expect(ecologyAffinity('dragon-peaks', 1000, 0.5, 0.2)).toBeGreaterThan(ecologyAffinity('dragon-peaks', 200, 0.05, 0.2) + 2);
  });

  it('cores keep their own biome: ecology cannot bring a biome in where its blueprint weight is negligible', () => {
    const ids = WORLD.regions.map((r) => r.id), out = new Float64Array(ids.length);
    const w = ids.map((id) => (id === 'golden-plains' ? 0.99 : id === 'whispering-marshes' ? 0.01 : 0));
    biomeShares(ids, w, 20, 0.01, 1, out); // as wet and flat as a marsh could want
    expect(out[ids.indexOf('golden-plains')]).toBe(1);
    expect(pickBiome(out, 0.999)).toBe(ids.indexOf('golden-plains'));
  });

  it('trees cross borders in groves: both biomes have trees on both sides of the Elderwood edge', () => {
    const w = windows['elderwood-heartlands'], elder = WORLD.regions.findIndex((r) => r.id === 'elderwood');
    let inElder = 0, inHeart = 0, heartSpeciesInElder = 0, elderSpeciesInHeart = 0;
    w.regions.forEach((r) => {
      for (const o of r.objects) {
        if (o.kind !== 'tree') continue;
        const b = r.biome[o.y * S + o.x];
        if (b === elder) { inElder++; if (o.variant === 'blossom') heartSpeciesInElder++; } else { inHeart++; if (o.variant === 'pine' || o.variant === 'willow') elderSpeciesInHeart++; }
      }
    });
    console.log(`elderwood-heartlands trees: ${inElder} on Elderwood ground, ${inHeart} on Heartlands ground; blossom on Elderwood ground ${heartSpeciesInElder}, pine/willow on Heartlands ground ${elderSpeciesInHeart}`);
    // Denser on the forest's own ground, but stands of its trees reach onto the meadow and the reverse.
    const elderCells = w.biome.filter((b) => b === elder).length, heartCells = w.biome.filter((b) => b !== elder && b !== 255).length;
    expect(inElder / elderCells).toBeGreaterThan((inHeart / heartCells) * 1.3);
    expect(elderSpeciesInHeart).toBeGreaterThan(10);
    expect(heartSpeciesInElder).toBeGreaterThan(5);
  });
});
