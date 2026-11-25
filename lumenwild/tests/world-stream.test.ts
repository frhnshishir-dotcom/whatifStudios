import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain } from '../src/world/terrain';
import { RegionCache, WorldWindow } from '../src/world/stream';
import { createContinentEngine } from '../src/boot';
import { WK_RIVER } from '../src/world/terrain';

let bp: Blueprint, ct: ContinentTerrain;
beforeAll(() => { bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp); }, 60_000);

describe('region streaming', { timeout: 120_000 }, () => {
  it('after any sequence of moves the window equals a fresh load of the same regions', () => {
    const cache = new RegionCache(ct, { capacity: 40 });
    const win = new WorldWindow(256);
    win.load([195, 199], (x, y) => cache.ensure(x, y));
    for (const [dx, dy] of [[1, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [0, -1]]) win.shift(dx, dy, (x, y) => cache.ensure(x, y));
    const fresh = new WorldWindow(256);
    fresh.load(win.centre, (x, y) => cache.ensure(x, y), win.datum);
    expect(win.origin).toEqual([195, 197]);
    const w = win.world, f = fresh.world;
    for (const [a, b] of [[w.elev, f.elev], [w.mat, f.mat], [w.cover, f.cover], [w.coverVar, f.coverVar], [w.moisture, f.moisture], [win.waterKind, fresh.waterKind], [win.biome, fresh.biome]] as const) {
      expect(Array.from(a as ArrayLike<number>)).toEqual(Array.from(b as ArrayLike<number>));
    }
    const lv = (x: Float32Array) => Array.from(x, (v) => (Number.isNaN(v) ? -9999 : v));
    expect(lv(win.waterLevel)).toEqual(lv(fresh.waterLevel));
    expect(win.allObjects()).toEqual(fresh.allObjects());
  });

  it('the engine follows the view: seamless camera, bounded memory, quick moves, re-shaded strips', () => {
    const { engine, session } = createContinentEngine({ worker: false });
    engine.cam.setViewport(1440, 900);
    engine.focus(...engine.home!);
    const continentX = () => engine.cam.x + session.win.origin[0] * session.win.S;
    const objectsBefore = engine.objects.objects.size;
    let f = 0, moves = 0;
    session.onShift = () => { moves++; };
    // Pan east about 1.3 km, then south 600 m.
    for (let k = 0; k < 1300; k++) {
      const before = continentX();
      engine.cam.x += 1; engine.frame(f++ * 1000 / 60);
      expect(continentX() - before).toBeCloseTo(1, 6); // the view never jumps, even across a move
    }
    for (let k = 0; k < 600; k++) { engine.cam.y += 1; engine.frame(f++ * 1000 / 60); }
    expect(moves).toBeGreaterThanOrEqual(6);
    expect(session.cache.size).toBeLessThanOrEqual(session.cache.capacity);
    expect(engine.world.w).toBe(768);
    expect(engine.objects.objects.size).toBeLessThan(30_000);
    expect(engine.objects.objects.size).toBeGreaterThan(objectsBefore * 0.2);
    console.log(`window moves: ${moves}, slowest ${session.stats.maxShiftMs.toFixed(0)} ms, last ${session.stats.lastShiftMs.toFixed(0)} ms; region generation max ${session.cache.stats.maxMs.toFixed(0)} ms`);
    expect(session.stats.maxShiftMs).toBeLessThan(100);
    // Newly loaded strips are re-shaded within a few frames (4 ms of shading per frame; headless, so drive it directly).
    for (let k = 0; k < 400 && engine.world.terrainDirty.some((d) => d === 1); k++) engine.shader.update(engine.composer.shadeBudgetMs);
    expect(Array.from(engine.world.terrainDirty).every((d) => d === 0)).toBe(true);
  });

  it('rivers keep flowing through the window and through a move', () => {
    const { engine, session } = createContinentEngine({ worker: false, at: [493, 515] });
    engine.cam.setViewport(1440, 900);
    engine.focus(...engine.home!);
    const W = session.win.W, kind = session.win.waterKind, depth = engine.water!.view.depth;
    const river = () => { let v = 0, n = 0; for (let i = 0; i < W * W; i++) if (kind[i] === WK_RIVER) { v += depth[i]; n++; } return [v, n]; };
    const [v0, n0] = river();
    expect(n0).toBeGreaterThan(10_000);
    let f = 0;
    for (let k = 0; k < 600; k++) engine.frame(f++ * 1000 / 60); // 10 s
    expect(session.stats.shifts).toBe(0); // the view stayed in the central region
    const [v1] = river();
    expect(v1 / v0).toBeGreaterThan(0.75);
    expect(v1 / v0).toBeLessThan(1.25);
    // No flooding: dry land stays (almost entirely) dry.
    let wetLand = 0, land = 0;
    for (let i = 0; i < W * W; i++) if (kind[i] === 0) { land++; if (depth[i] > 0.3) wetLand++; }
    expect(wetLand / land).toBeLessThan(0.02);
    // Move the window south along the river: the new strip arrives with its water.
    session.moveWindow(engine, 0, 1);
    const [v2, n2] = river();
    expect(n2).toBeGreaterThan(5_000);
    expect(v2 / n2).toBeGreaterThan(0.5); // metres of water per river cell on average
  });
});
