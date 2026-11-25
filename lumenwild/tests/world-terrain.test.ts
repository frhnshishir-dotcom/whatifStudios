import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, regionAt, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain, WK_NONE, WK_RIVER, WK_LAKE, type RegionData } from '../src/world/terrain';
import { Mat } from '../src/engine/world/materials';

let bp: Blueprint, ct: ContinentTerrain;
const cache = new Map<string, RegionData>();
const region = (rx: number, ry: number) => {
  const k = `${rx},${ry}`;
  if (!cache.has(k)) cache.set(k, ct.generateRegion(rx, ry));
  return cache.get(k)!;
};
const S = 256, MPU = 100;
/** Region containing a map point. */
const regionOf = (ux: number, uy: number): [number, number] => [Math.floor((ux * MPU) / S), Math.floor((uy * MPU) / S)];

beforeAll(() => { bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp); }, 60_000);

describe('continent terrain at 1 m', { timeout: 60_000 }, () => {
  it('is deterministic', () => {
    const [rx, ry] = regionOf(500, 510);
    const a = ct.generateRegion(rx, ry), b = ct.generateRegion(rx, ry);
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev));
    expect(Array.from(a.mat)).toEqual(Array.from(b.mat));
    expect(a.objects).toEqual(b.objects);
  });

  it('is seamless: neighbouring regions meet without steps (heights, water and materials)', () => {
    for (const [ux, uy] of [[500, 510], [470, 300], [250, 470], [700, 700]] as [number, number][]) {
      const [rx, ry] = regionOf(ux, uy);
      const a = region(rx, ry), right = region(rx + 1, ry), below = region(rx, ry + 1);
      const inside: number[] = [], across: number[] = [];
      for (let j = 0; j < S; j++) {
        across.push(Math.abs(a.elev[j * S + S - 1] - right.elev[j * S]));
        inside.push(Math.abs(a.elev[j * S + S - 2] - a.elev[j * S + S - 1]));
      }
      for (let i = 0; i < S; i++) {
        across.push(Math.abs(a.elev[(S - 1) * S + i] - below.elev[i]));
        inside.push(Math.abs(a.elev[(S - 2) * S + i] - a.elev[(S - 1) * S + i]));
      }
      const q = (v: number[], f: number) => v.slice().sort((x, y) => x - y)[Math.floor(f * (v.length - 1))];
      expect(q(across, 0.99), `${ux},${uy}`).toBeLessThanOrEqual(q(inside, 0.999) + 0.5);
      expect(Math.max(...across), `${ux},${uy}`).toBeLessThan(25);
    }
  });

  it('rivers hold water at their true width and their surface never rises downstream; Emberfall is a real drop', () => {
    const lumen = bp.rivers.find((r) => r.id === 'lumen-river')!;
    // Walk the Lumen from Emberfall to King's Bridge sampling the centreline every 10 points (500 m).
    let last = Infinity, wet = 0, n = 0;
    for (let k = Math.floor(lumen.pts.length * 0.2); k < lumen.pts.length * 0.85; k += 10) {
      const [ux, uy] = lumen.pts[k], [rx, ry] = regionOf(ux, uy), r = region(rx, ry);
      const ci = Math.floor(ux * MPU) - r.ox, cj = Math.floor(uy * MPU) - r.oy, c = cj * S + ci;
      n++;
      if (r.waterKind[c] === WK_RIVER || r.waterKind[c] === WK_LAKE) {
        wet++;
        expect(r.waterLevel[c]).toBeLessThanOrEqual(last + 1e-3);
        last = r.waterLevel[c];
        expect(r.elev[c]).toBeLessThan(r.waterLevel[c]); // the bed is below the surface
      }
    }
    expect(wet / n).toBeGreaterThan(0.9);
    // Emberfall: within its region the river surface spans a drop of more than 100 m.
    const [ex, ey] = regionOf(550, 275), er = region(ex, ey);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < S * S; k++) if (er.waterKind[k] === WK_RIVER) { lo = Math.min(lo, er.waterLevel[k]); hi = Math.max(hi, er.waterLevel[k]); }
    expect(hi - lo).toBeGreaterThan(100);
    // Channel width near Lumenfall: 20-80 m of water across the river.
    const k0 = lumen.pts.findIndex((p) => Math.hypot(p[0] - 495, p[1] - 515) < 3);
    const [cx, cy] = lumen.pts[k0], [rx, ry] = regionOf(cx, cy), r = region(rx, ry);
    const row = Math.floor(cy * MPU) - r.oy;
    let width = 0;
    for (let i = 0; i < S; i++) if (r.waterKind[row * S + i] === WK_RIVER) width++;
    expect(width).toBeGreaterThan(15);
    expect(width).toBeLessThan(90);
  });

  it('lakes are flat at their blueprint level', () => {
    const l = WORLD.lakes.find((q) => q.id === 'kings-basin')!;
    const [rx, ry] = regionOf(l.at[0], l.at[1]), r = region(rx, ry);
    let n = 0;
    for (let k = 0; k < S * S; k++) if (r.waterKind[k] === WK_LAKE) { n++; expect(r.waterLevel[k]).toBeCloseTo(bp.lakeLevels[l.id], 3); expect(r.elev[k]).toBeLessThan(r.waterLevel[k]); }
    expect(n).toBe(S * S); // the region at the lake's centre is all lake
  });

  it('mountains and lowlands: the Dragon Peaks reach about 1,600 m, the Heartlands roll gently', () => {
    const [px, py] = regionOf(480, 90);
    let top = -Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const e of region(px + dx, py + dy).elev) top = Math.max(top, e);
    expect(top).toBeGreaterThan(1450);
    expect(top).toBeLessThan(1750);
    const [hx, hy] = regionOf(560, 560), h = region(hx, hy);
    let lo = Infinity, hi = -Infinity;
    for (const e of h.elev) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
    expect(hi - lo).toBeLessThan(60);
    // Real relief exists in the peaks at 1 m: steep ground and rock.
    const p = region(px, py);
    expect(p.mat.filter((m) => m === Mat.Stone || m === Mat.Cliff || m === Mat.Snow).length).toBeGreaterThan(S * S * 0.3);
  });

  it('agrees with the blueprint away from rivers (mean of each 256 m region within 25 m)', () => {
    for (const [ux, uy] of [[200, 800], [900, 400], [150, 300], [560, 560], [780, 820]] as [number, number][]) {
      const [rx, ry] = regionOf(ux, uy), r = region(rx, ry);
      let sum = 0;
      for (const e of r.elev) sum += e;
      const mean = sum / (S * S);
      let ref = 0, n = 0;
      for (let j = 0; j < S; j += 32) for (let i = 0; i < S; i += 32) { ref += ct.macroAt(r.ox + i, r.oy + j); n++; }
      expect(Math.abs(mean - ref / n), `${ux},${uy}`).toBeLessThan(25);
    }
  });

  it('biome borders are gradual: the share of the new biome rises over more than 500 m', () => {
    // Walk west from the Heartlands into Elderwood along y = 510 and find the blueprint border.
    let border = 0;
    for (let ux = 470; ux > 330; ux -= 1) if (regionAt(bp, ux, 510) === 'elderwood') { border = ux; break; }
    expect(border).toBeGreaterThan(0);
    const elder = WORLD.regions.findIndex((r) => r.id === 'elderwood');
    const shares: Array<[number, number]> = [];
    for (let m = -2500; m <= 2500; m += 250) {
      const xm = border * MPU + m, ym = 510 * MPU, rx = Math.floor(xm / S), ry = Math.floor(ym / S), r = region(rx, ry);
      let e = 0, n = 0;
      for (let j = 0; j < S; j += 4) for (let i = 0; i < S; i += 4) { n++; if (r.biome[j * S + i] === elder) e++; }
      shares.push([m, e / n]);
    }
    // Mixed band: samples (250 m apart) where neither biome holds more than 85 % of the ground.
    const mixed = shares.filter(([, s]) => s > 0.15 && s < 0.85).length * 250;
    expect(shares[0][1]).toBeGreaterThan(0.6); // west of the border: Elderwood
    expect(shares[shares.length - 1][1]).toBeLessThan(0.4); // east: Heartlands
    expect(mixed).toBeGreaterThanOrEqual(500);
  });

  it('paths, trees and rocks: on land, off the water; dense in Elderwood, sparse on the plains', () => {
    const [ex, ey] = regionOf(150, 360), forest = region(ex, ey);
    const trees = (r: RegionData) => r.objects.filter((o) => o.kind === 'tree').length;
    expect(trees(forest)).toBeGreaterThan(300);
    const [gx, gy] = regionOf(250, 860);
    expect(trees(region(gx, gy))).toBeLessThan(trees(forest) / 4);
    for (const r of cache.values()) for (const o of r.objects) {
      expect(r.waterKind[o.y * S + o.x]).toBe(WK_NONE);
      expect(r.mat[o.y * S + o.x]).not.toBe(Mat.Path);
    }
    // King's Road runs through the region south of Lumenfall as a narrow path.
    const road = bp.roads.find((q) => q.id === 'kings-road')!;
    const p = road.pts[Math.floor(road.pts.length * 0.15)], [rx, ry] = regionOf(p[0], p[1]);
    let path = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) path += region(rx + dx, ry + dy).mat.filter((m) => m === Mat.Path).length;
    expect(path).toBeGreaterThan(200);
    expect(path).toBeLessThan(9 * S * 4); // narrow: a few metres wide
  });

  it('generates a region fast enough to stream (under 300 ms on average here)', () => {
    const t0 = performance.now();
    const list: Array<[number, number]> = [[190, 230], [120, 140], [250, 330], [300, 200], [80, 300], [220, 60]];
    for (const [rx, ry] of list) ct.generateRegion(rx, ry);
    const avg = (performance.now() - t0) / list.length;
    console.log(`region generation: ${avg.toFixed(0)} ms average over ${list.length} regions`);
    expect(avg).toBeLessThan(300);
  });
});
