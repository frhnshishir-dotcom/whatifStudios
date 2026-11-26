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
    const { engine, session } = createContinentEngine({ worker: false, life: false }) // drives the camera itself;
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

  it('water, flow and settled pools move with the window: nothing restarts except the new strip', () => {
    const { engine, session } = createContinentEngine({ worker: false, at: [493, 515] });
    engine.cam.setViewport(1440, 900);
    engine.focus(...engine.home!);
    const sim = (engine.water as unknown as { sim: { depth: Float32Array; velX: Float32Array; velY: Float32Array; fR: Float32Array; calm: Uint16Array; chunksX: number; sleepingChunks: number; totalWater(): number } }).sim;
    const W = session.win.W, S = session.win.S, kind = session.win.waterKind;
    let f = 0;
    for (let k = 0; k < 600; k++) engine.frame(f++ * 1000 / 60);
    const flow = () => { let v = 0, n = 0; for (let i = 0; i < W * W; i++) if (kind[i] === WK_RIVER && sim.depth[i] > 0.05) { v += Math.hypot(sim.velX[i], sim.velY[i]); n++; } return v / n; };
    const d0 = sim.depth.slice(), vx0 = sim.velX.slice(), f0 = sim.fR.slice(), calm0 = sim.calm.slice(), flow0 = flow(), asleep0 = sim.sleepingChunks;
    session.moveWindow(engine, 0, 1);
    // Rows that stayed in the window: depth, velocity and flux are carried exactly (no restart).
    let same = 0, diff = 0;
    for (let y = 0; y < W - S; y++) for (let x = 0; x < W; x++) {
      const a = y * W + x, b = (y + S) * W + x;
      if (engine.world.solid[a]) continue; // water inside rocks is displaced when the obstacles are rebuilt
      if (sim.depth[a] === d0[b] && sim.velX[a] === vx0[b] && sim.fR[a] === f0[b]) same++; else diff++;
    }
    expect(diff, `${diff} cells changed`).toBe(0);
    // Settled chunks stay asleep where they were (away from the old and new edges).
    const CX = sim.chunksX, cs = S / 16;
    for (let j = 1; j < CX - cs - 1; j++) for (let i = 1; i < CX - 1; i++) expect(sim.calm[j * CX + i], `chunk ${i},${j}`).toBe(calm0[(j + cs) * CX + i]);
    // The river keeps flowing through the move.
    for (let k = 0; k < 120; k++) engine.frame(f++ * 1000 / 60);
    const flow1 = flow();
    console.log(`water through a move: ${same} cells carried exactly; river speed ${flow0.toFixed(2)} -> ${flow1.toFixed(2)} m/s two seconds later; sleeping chunks ${asleep0} before`);
    expect(flow1 / flow0).toBeGreaterThan(0.7);
    expect(flow1 / flow0).toBeLessThan(1.4);
  });

  it('the worker gets one region at a time, and a region a move is waiting for jumps the queue', () => {
    const posted: Array<[number, number]> = [];
    const fake = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage(m: { rx: number; ry: number }) { posted.push([m.rx, m.ry]); }, terminate() {} };
    const cache = new RegionCache(ct, { worker: fake as unknown as Worker });
    for (let k = 0; k < 5; k++) cache.request(100 + k, 100);
    cache.request(103, 100, true); // already queued: moves to the front
    cache.request(200, 200, true); // new and urgent: in front of that
    expect(posted).toEqual([[100, 100]]);
    expect(cache.queued).toBe(5);
    const reply = (rx: number, ry: number) => fake.onmessage!({ data: { region: ct.generateRegion(rx, ry) } } as MessageEvent);
    reply(100, 100);
    reply(200, 200);
    expect(posted).toEqual([[100, 100], [200, 200], [103, 100]]);
    expect(cache.has(100, 100) && cache.has(200, 200)).toBe(true);
  });
});
