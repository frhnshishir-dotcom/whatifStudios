import { describe, it, expect } from 'vitest';
import { WaterSim } from '../src/engine/water/WaterSim';

/** A 128 x 128 m bowl (lake) with a channel on one side; water filled to 2 m level. */
function bowl(sleep: boolean) {
  const W = 128, elev = new Float32Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) elev[y * W + x] = Math.hypot(x - 64, y - 64) * 0.05 + 0.2 * Math.sin(x * 0.3) * Math.cos(y * 0.2);
  const sim = new WaterSim(W, W, elev, undefined, { edgeDrain: false, sleep });
  const d = new Float32Array(W * W);
  for (let i = 0; i < W * W; i++) d[i] = Math.max(0, 2 - elev[i]);
  sim.reset(d);
  return sim;
}

describe('water: settled chunks sleep (continent mode)', () => {
  it('a still lake goes to sleep, conserves its water exactly, and matches the awake simulation', () => {
    const a = bowl(true), b = bowl(false), v0 = a.totalWater();
    for (let k = 0; k < 900; k++) { a.step(1 / 60); b.step(1 / 60); }
    expect(a.sleepingChunks).toBeGreaterThan(20);
    expect(a.activeChunks).toBeLessThan(b.activeChunks / 2);
    expect(Math.abs(a.totalWater() - v0) / v0).toBeLessThan(1e-4); // evaporation of films only
    let maxDiff = 0;
    for (let i = 0; i < a.n; i++) maxDiff = Math.max(maxDiff, Math.abs(a.depth[i] - b.depth[i]));
    expect(maxDiff).toBeLessThan(0.01);
  });

  it('pouring water into a sleeping lake wakes it; the water spreads and is all accounted for', () => {
    const a = bowl(true);
    for (let k = 0; k < 900; k++) a.step(1 / 60);
    const asleep = a.sleepingChunks, v0 = a.totalWater();
    a.addWater(64, 64, 3, 40);
    for (let k = 0; k < 10; k++) a.step(1 / 60);
    expect(a.sleepingChunks).toBeLessThan(asleep);
    for (let k = 0; k < 600; k++) a.step(1 / 60);
    expect(Math.abs(a.totalWater() - (v0 + 40))).toBeLessThan(0.05 * 40);
    // 40 m^3 over the lake (about 9,000 m^2) raises it a few millimetres everywhere, including far chunks.
    const far = a.depth[64 * 128 + 20] , near = a.depth[64 * 128 + 64];
    expect(near - far).toBeGreaterThan(0); // deeper in the middle of the bowl
  });

  it('flowing water (a source and a drain) never sleeps', () => {
    const W = 64, elev = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) elev[y * W + x] = (W - x) * 0.05 + (Math.abs(y - 32) < 3 ? 0 : 2);
    const sim = new WaterSim(W, W, elev, undefined, { edgeDrain: false, sleep: true });
    sim.setPorts([[1, 32, 2]], [[62, 32, 4]]);
    for (let k = 0; k < 1200; k++) sim.step(1 / 60);
    // The channel chunks carry flow: none of them sleeps.
    for (let cx = 0; cx < sim.chunksX; cx++) expect(sim.calm[2 * sim.chunksX + cx]).toBeLessThan(60);
    expect(sim.totalWater()).toBeGreaterThan(1);
  });
});
