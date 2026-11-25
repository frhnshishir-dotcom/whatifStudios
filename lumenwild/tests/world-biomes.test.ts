import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain, WK_NONE, WK_MARSH, type RegionData } from '../src/world/terrain';
import { Mat, Cover, MAT_NAMES, COVER_NAMES } from '../src/engine/world/materials';
import { MAT_LOOK } from '../src/engine/render/TerrainShader';

/**
 * The six regions must look and feel different on the playable 1 m terrain, not only on the blueprint. Each biome is
 * sampled over 3 x 3 regions (768 x 768 m) at a place well inside it, and compared on what the player sees: ground
 * materials, ground cover, trees, rocks and water.
 */
const PLACES: Array<[string, number, number]> = [
  ['heartlands', 560, 560], ['dragon-peaks', 560, 160], ['elderwood', 160, 380],
  ['golden-plains', 250, 860], ['whispering-marshes', 740, 790], ['hollow-lands', 850, 400],
];
const S = 256, MPU = 100;
interface Stats { mat: number[]; cover: number[]; water: number; marsh: number; trees: Record<string, number>; rocks: Record<string, number>; colour: [number, number, number]; cells: number }
let bp: Blueprint;
const stats: Record<string, Stats> = {};

function sample(ct: ContinentTerrain, ux: number, uy: number): Stats {
  const rx = Math.floor((ux * MPU) / S), ry = Math.floor((uy * MPU) / S);
  const st: Stats = { mat: new Array(MAT_NAMES.length).fill(0), cover: new Array(COVER_NAMES.length).fill(0), water: 0, marsh: 0, trees: {}, rocks: {}, colour: [0, 0, 0], cells: 0 };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const r: RegionData = ct.generateRegion(rx + dx, ry + dy);
    for (let k = 0; k < S * S; k++) {
      st.cells++;
      if (r.waterKind[k] !== WK_NONE) { st.water++; if (r.waterKind[k] === WK_MARSH) st.marsh++; continue; }
      st.mat[r.mat[k]]++; st.cover[r.cover[k]]++;
      const g = MAT_LOOK[r.mat[k]].bg.table, q = 140 * 3; // the mid tone of the material's ground colour
      st.colour[0] += g[q]; st.colour[1] += g[q + 1]; st.colour[2] += g[q + 2];
    }
    for (const o of r.objects) {
      const t = o.kind === 'tree' ? st.trees : o.kind === 'rock' ? st.rocks : null;
      if (t) t[o.variant] = (t[o.variant] ?? 0) + 1;
    }
  }
  const land = st.cells - st.water;
  st.mat = st.mat.map((v) => v / land); st.cover = st.cover.map((v) => v / land);
  st.colour = st.colour.map((v) => v / land) as [number, number, number];
  return st;
}
const share = (s: Stats, ...ms: number[]) => ms.reduce((a, m) => a + s.mat[m], 0);
const cov = (s: Stats, ...cs: number[]) => cs.reduce((a, c) => a + s.cover[c], 0);
const count = (t: Record<string, number>) => Object.values(t).reduce((a, b) => a + b, 0);

beforeAll(() => {
  bp = buildBlueprint(WORLD);
  const ct = new ContinentTerrain(bp);
  for (const [id, x, y] of PLACES) stats[id] = sample(ct, x, y);
  for (const [id] of PLACES) {
    const s = stats[id], top = (a: number[], names: readonly string[]) => a.map((v, i) => [names[i], v] as const).filter((q) => q[1] > 0.02).sort((p, q) => q[1] - p[1]).map(([n, v]) => `${n} ${(v * 100).toFixed(0)}%`).join(', ');
    console.log(`${id}: ground ${top(s.mat, MAT_NAMES)} | cover ${top(s.cover, COVER_NAMES)} | water ${(100 * s.water / s.cells).toFixed(1)}% (marsh ${(100 * s.marsh / s.cells).toFixed(1)}%) | trees ${JSON.stringify(s.trees)} | rocks ${JSON.stringify(s.rocks)} | colour ${s.colour.map((v) => v.toFixed(0)).join(',')}`);
  }
}, 120_000);

describe('the six biomes are different on the playable terrain', () => {
  it('every pair differs in what covers the ground (materials and cover, L1 distance)', () => {
    const ids = PLACES.map((p) => p[0]);
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const A = stats[ids[a]], B = stats[ids[b]];
      const d = A.mat.reduce((s, v, i) => s + Math.abs(v - B.mat[i]), 0) + A.cover.reduce((s, v, i) => s + Math.abs(v - B.cover[i]), 0);
      console.log(`${ids[a]} vs ${ids[b]}: ${d.toFixed(2)}`);
      expect(d, `${ids[a]} vs ${ids[b]}`).toBeGreaterThan(1.0);
    }
  });

  it('Dragon Peaks: snow, scree and bare rock on the heights; pine forest in the valleys', () => {
    const s = stats['dragon-peaks'];
    expect(share(s, Mat.Snow)).toBeGreaterThan(0.1);
    expect(share(s, Mat.Scree)).toBeGreaterThan(0.05);
    expect(share(s, Mat.Snow, Mat.Scree, Mat.Stone, Mat.Cliff)).toBeGreaterThan(0.6);
    // A Peaks valley (blueprint 450-600 m, Peaks all around): pines below the tree line.
    const pi = WORLD.regions.findIndex((r) => r.id === 'dragon-peaks'), N = bp.N;
    let at: [number, number] | null = null;
    for (let k = 0; k < N * N && !at; k++) {
      const i = k % N, j = Math.floor(k / N);
      if (bp.region[k] !== pi || bp.elevPre[k] < 450 || bp.elevPre[k] > 600 || i < 3 || j < 3 || i >= N - 3 || j >= N - 3) continue;
      let all = true;
      for (let dy = -3; dy <= 3 && all; dy++) for (let dx = -3; dx <= 3; dx++) if (bp.region[k + dy * N + dx] !== pi) { all = false; break; }
      if (all) at = [(i + 0.5) * bp.unit, (j + 0.5) * bp.unit];
    }
    expect(at).not.toBeNull();
    const v = sample(new ContinentTerrain(bp), at![0], at![1]);
    console.log(`Peaks valley at ${at}: trees ${JSON.stringify(v.trees)}, ground ${MAT_NAMES.map((n, i) => [n, v.mat[i]] as const).filter((q) => q[1] > 0.05).map((q) => `${q[0]} ${(q[1] * 100).toFixed(0)}%`).join(', ')}`);
    expect(count(v.trees)).toBeGreaterThan(300);
    expect((v.trees.pine ?? 0) / count(v.trees)).toBeGreaterThan(0.6);
  });

  it('Whispering Marshes: open water in pools and channels, bog and reed beds', () => {
    const s = stats['whispering-marshes'];
    expect(s.marsh / s.cells).toBeGreaterThan(0.05);
    expect(share(s, Mat.Bog)).toBeGreaterThan(0.15);
    expect(cov(s, Cover.Reeds)).toBeGreaterThan(0.25);
    expect((s.trees.willow ?? 0) + (s.trees.dead ?? 0)).toBeGreaterThan(count(s.trees) * 0.6);
  });

  it('Golden Plains: dry golden grass, few trees, rock outcrops', () => {
    const s = stats['golden-plains'];
    expect(share(s, Mat.DryGrass)).toBeGreaterThan(0.5);
    expect(cov(s, Cover.GoldenGrass)).toBeGreaterThan(0.35);
    expect(count(s.trees)).toBeLessThan(count(stats.heartlands.trees));
    expect(s.rocks.formation ?? 0).toBeGreaterThan(5);
  });

  it('Hollow Lands: ash and bare ground, ember cracks, thorns, dead trees', () => {
    const s = stats['hollow-lands'];
    expect(share(s, Mat.Ash, Mat.Dirt, Mat.Stone, Mat.Scree, Mat.Cliff)).toBeGreaterThan(0.8);
    expect(share(s, Mat.Grass, Mat.Meadow, Mat.DryGrass, Mat.ForestFloor)).toBeLessThan(0.05);
    expect(cov(s, Cover.Thorns)).toBeGreaterThan(0.02);
    expect((s.trees.dead ?? 0) / Math.max(1, count(s.trees))).toBeGreaterThan(0.6);
  });

  it('Hollow Lands fissures glow: ember cracks run along the Rift of Shadows', () => {
    const ct = new ContinentTerrain(bp);
    const f = WORLD.elevation.fissures.find((q) => q.id === 'rift-of-shadows-trench')!;
    const [ux, uy] = f.line[1];
    const r = ct.generateRegion(Math.floor((ux * MPU) / S), Math.floor((uy * MPU) / S));
    let embers = 0;
    for (let k = 0; k < S * S; k++) if (r.cover[k] === Cover.Embers) embers++;
    expect(embers / (S * S)).toBeGreaterThan(0.01);
  });

  it('Elderwood: dense forest on forest floor and moss; Heartlands: green farmland grass with clover and flowers', () => {
    const e = stats.elderwood, h = stats.heartlands;
    expect(share(e, Mat.ForestFloor, Mat.Moss)).toBeGreaterThan(0.8);
    expect(count(e.trees)).toBeGreaterThan(count(h.trees) * 4);
    expect(share(h, Mat.Grass, Mat.Meadow)).toBeGreaterThan(0.8);
    expect(cov(h, Cover.Clover, Cover.Flowers)).toBeGreaterThan(0.1);
  });

  it('the ground colour (palette mid tone) differs between every pair', () => {
    const ids = PLACES.map((p) => p[0]);
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const A = stats[ids[a]].colour, B = stats[ids[b]].colour;
      const d = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
      console.log(`colour ${ids[a]} vs ${ids[b]}: ${d.toFixed(0)}`);
      expect(d, `${ids[a]} vs ${ids[b]}`).toBeGreaterThan(15);
    }
  });
});
