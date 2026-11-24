import { describe, it, expect } from 'vitest';
import { Rng, hash2, seedOf } from '../src/engine/core/rng';
import { fbm, valueNoise } from '../src/engine/core/noise';
import { pack, unpack, Gradient, hex } from '../src/engine/core/color';
import { Clock } from '../src/engine/world/Clock';

describe('rng', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = new Rng('x', 1), b = new Rng('x', 1), c = new Rng('x', 2);
    const sa = Array.from({ length: 5 }, () => a.float()), sb = Array.from({ length: 5 }, () => b.float());
    expect(sa).toEqual(sb);
    expect(Array.from({ length: 5 }, () => c.float())).not.toEqual(sa);
    expect(seedOf('a', 1)).not.toBe(seedOf('a', 2));
  });
  it('hash2 is stable and in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = hash2(i * 7 - 300, i * 13 - 500, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(hash2(i * 7 - 300, i * 13 - 500, 3)).toBe(v);
    }
  });
});

describe('noise', () => {
  it('fbm stays in [0, 1] and is smooth', () => {
    let maxStep = 0;
    for (let i = 0; i < 2000; i++) {
      const v = fbm(i * 0.05, 3.3, 4, 9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (i) maxStep = Math.max(maxStep, Math.abs(v - fbm((i - 1) * 0.05, 3.3, 4, 9)));
    }
    expect(maxStep).toBeLessThan(0.2);
    expect(valueNoise(1.5, 2.5, 1)).toBe(valueNoise(1.5, 2.5, 1));
  });
});

describe('color', () => {
  it('packs to little-endian RGBA and back', () => {
    const p = pack(10, 200, 33);
    expect(unpack(p)).toEqual([10, 200, 33]);
    expect(p >>> 24).toBe(255);
    expect(pack(-5, 300, 12.7)).toBe(pack(0, 255, 12));
  });
  it('gradient hits its stops', () => {
    const g = new Gradient([[0, '#000000'], [1, '#ffffff']]);
    expect(g.sampleInto([0, 0, 0], 0)).toEqual([0, 0, 0]);
    expect(g.sampleInto([0, 0, 0], 1)).toEqual([255, 255, 255]);
    expect(hex('#ff8000')).toEqual([255, 128, 0]);
  });
});

describe('clock', () => {
  it('runs whole fixed steps and keeps the remainder', () => {
    const c = new Clock(60);
    expect(c.advance(1 / 60 * 2.5)).toBe(2);
    expect(c.advance(1 / 60 * 0.6)).toBe(1); // 0.5 + 0.6 carried
    expect(c.steps).toBe(3);
  });
  it('caps steps after a stall and does nothing when paused', () => {
    const c = new Clock(60);
    expect(c.advance(5)).toBe(c.maxStepsPerFrame);
    c.paused = true;
    expect(c.advance(1)).toBe(0);
  });
});
