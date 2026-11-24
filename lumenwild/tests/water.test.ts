import { describe, it, expect } from 'vitest';
import { WaterSim } from '../src/engine/water/WaterSim';

const DT = 1 / 60;
function sim(w: number, h: number, elevFn: (x: number, y: number) => number, params = {}) {
  const elev = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) elev[y * w + x] = elevFn(x, y);
  return new WaterSim(w, h, elev, undefined, { edgeDrain: false, evaporation: 0, ...params });
}
const run = (s: WaterSim, n: number) => { for (let k = 0; k < n; k++) s.step(DT); };
const centroidY = (s: WaterSim) => { let m = 0, my = 0; for (let i = 0; i < s.n; i++) { m += s.depth[i]; my += s.depth[i] * Math.floor(i / s.w); } return my / m; };

describe('water flow', () => {
  it('conserves water exactly in a closed basin', () => {
    const s = sim(48, 48, (x, y) => 2 + Math.sin(x * 0.3) * 0.8 + Math.cos(y * 0.25) * 0.6);
    s.addWater(10, 12, 5, 40);
    s.addWater(36, 30, 4, 25);
    const v0 = s.totalWater();
    run(s, 3000);
    expect(Math.abs(s.totalWater() - v0) / v0).toBeLessThan(1e-4);
    for (let i = 0; i < s.n; i++) expect(s.depth[i]).toBeGreaterThanOrEqual(0);
  });

  it('balances the books with sources, drains and open edges', () => {
    const s = sim(40, 40, (_x, y) => 6 - y * 0.12, { edgeDrain: true });
    s.setSource(20, 3, 2);
    s.setDrain(10, 30, 0.5);
    run(s, 1500);
    expect(s.added).toBeGreaterThan(40);
    expect(s.removed).toBeGreaterThan(1);
    expect(Math.abs(s.added - s.removed - s.totalWater())).toBeLessThan(1e-2 * s.added);
  });

  it('moves downhill', () => {
    const s = sim(32, 64, (_x, y) => 10 - y * 0.15);
    s.addWater(16, 6, 4, 30);
    const y0 = centroidY(s);
    run(s, 600);
    expect(centroidY(s)).toBeGreaterThan(y0 + 15);
  });

  it('respects terrain walls', () => {
    // Wall at x = 20 taller than the water can ever reach.
    const s = sim(40, 20, (x) => (x === 20 ? 50 : 1));
    s.addWater(8, 10, 5, 80);
    run(s, 2000);
    let right = 0;
    for (let y = 0; y < 20; y++) for (let x = 21; x < 40; x++) right += s.depth[y * 40 + x];
    expect(right).toBe(0);
  });

  it('flows around an obstacle', () => {
    // Channel sloping in +y with a rock block (x 8..12, y 20..24) in the path of the stream.
    const s = sim(21, 60, (x, y) => (x >= 8 && x <= 12 && y >= 20 && y <= 24 ? 40 : 8 - y * 0.1));
    s.setSource(10, 2, 6);
    run(s, 1800);
    const d = (x: number, y: number) => s.depth[y * 21 + x];
    for (let y = 20; y <= 24; y++) for (let x = 8; x <= 12; x++) expect(d(x, y)).toBe(0); // the rock stays dry
    expect(d(6, 22)).toBeGreaterThan(0.004); // the stream splits around both sides of the rock...
    expect(d(14, 22)).toBeGreaterThan(0.004);
    expect(d(6, 32)).toBeGreaterThan(0.004); // ...continues downstream on both sides...
    expect(d(14, 32)).toBeGreaterThan(0.004);
    let pool = 0;
    for (let x = 0; x < 21; x++) pool += d(x, 58);
    expect(pool).toBeGreaterThan(3); // ...and collects at the bottom of the channel
  });

  it('records waterfalls over a cliff and transfers the water down', () => {
    // Plateau (y < 20) 5 m above a basin.
    const s = sim(24, 40, (_x, y) => (y < 20 ? 6 : 1));
    s.addWater(12, 10, 4, 40);
    let sawFall = 0;
    for (let k = 0; k < 400; k++) { s.step(DT); for (let x = 0; x < 24; x++) sawFall = Math.max(sawFall, s.fall[19 * 24 + x]); }
    expect(sawFall).toBeGreaterThan(0.1);
    let below = 0;
    for (let i = 20 * 24; i < s.n; i++) below += s.depth[i];
    expect(below).toBeGreaterThan(0.6 * s.totalWater());
    const edge = 19 * 24 + 12;
    expect(s.fallTo[edge] === edge + 24 || s.fall[edge] === 0).toBe(true);
  });

  it('stays stable (no blow-up) with steep terrain at the fixed timestep', () => {
    const s = sim(32, 32, (x, y) => ((x * 7 + y * 13) % 5) * 1.5);
    s.addWater(16, 16, 10, 300);
    run(s, 2000);
    let maxD = 0;
    for (let i = 0; i < s.n; i++) { expect(Number.isFinite(s.depth[i])).toBe(true); maxD = Math.max(maxD, s.depth[i]); }
    expect(maxD).toBeLessThan(30);
  });
});

describe('ripples', () => {
  const pond = () => { const s = sim(64, 64, () => 0); s.addWater(32, 32, 40, 64 * 64 * 1.0); run(s, 5); return s; };
  const energy = (s: WaterSim) => { let e = 0; const r = s.ripple; for (let i = 0; i < s.n; i++) e += r[i] * r[i]; return e; };
  const radius = (s: WaterSim, cx: number, cy: number) => {
    // Radius of the strongest crest along +x from the centre.
    const r = s.ripple; let best = 0, at = 0;
    for (let x = cx; x < s.w; x++) { const v = Math.abs(r[cy * s.w + x]); if (v > best) { best = v; at = x - cx; } }
    return at;
  };

  it('spread outwards as a ring, symmetrically', () => {
    const s = pond();
    s.disturb(32, 32, 1.5, 1);
    run(s, 10);
    const r10 = radius(s, 32, 32);
    run(s, 15);
    const r25 = radius(s, 32, 32);
    expect(r25).toBeGreaterThan(r10 + 2);
    const rip = s.ripple;
    expect(rip[32 * 64 + 32 + 8]).toBeCloseTo(rip[32 * 64 + 32 - 8], 4);
    expect(rip[(32 + 8) * 64 + 32]).toBeCloseTo(rip[32 * 64 + 32 + 8], 4);
  });

  it('are damped over time', () => {
    const s = pond();
    s.disturb(32, 32, 2, 1);
    run(s, 20);
    const e20 = energy(s);
    run(s, 200);
    expect(energy(s)).toBeLessThan(e20 * 0.1);
  });

  it('interfere linearly (two sources = sum of each alone)', () => {
    const a = pond(), b = pond(), ab = pond();
    a.disturb(20, 32, 1.5, 1);
    b.disturb(44, 32, 1.5, 0.7);
    ab.disturb(20, 32, 1.5, 1);
    ab.disturb(44, 32, 1.5, 0.7);
    run(a, 30); run(b, 30); run(ab, 30);
    const ra = a.ripple, rb = b.ripple, rab = ab.ripple;
    let maxErr = 0, maxV = 0;
    for (let i = 0; i < ab.n; i++) { maxErr = Math.max(maxErr, Math.abs(rab[i] - (ra[i] + rb[i]))); maxV = Math.max(maxV, Math.abs(rab[i])); }
    expect(maxErr).toBeLessThan(1e-5);
    expect(maxV).toBeGreaterThan(0.01);
  });

  it('reflect at dry boundaries and never leak onto land', () => {
    const s = sim(40, 40, (x) => (x >= 30 ? 10 : 0));
    s.addWater(15, 20, 30, 30 * 40 * 1.0);
    run(s, 300);
    s.disturb(25, 20, 1.5, 1);
    run(s, 40);
    for (let y = 0; y < 40; y++) for (let x = 30; x < 40; x++) expect(s.ripple[y * 40 + x]).toBe(0);
    let back = 0; // energy that came back towards x < 25 after hitting the wall at x = 30
    for (let y = 0; y < 40; y++) for (let x = 0; x < 25; x++) back += Math.abs(s.ripple[y * 40 + x]);
    expect(back).toBeGreaterThan(0.05);
  });
});
