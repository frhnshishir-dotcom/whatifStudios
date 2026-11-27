import { describe, it, expect } from 'vitest';
import { createContinentEngine } from '../../src/boot';

/**
 * Region streaming: window moves are quick (run alone: `npm run test:accept`; CI runs it as its own step).
 *
 * The same pan as tests/world-stream.test.ts (east about 1.3 km, then south 600 m). There is no worker here, so a
 * move also generates its new regions on this thread (with villages and places): about 90 ms when nothing else is
 * running. In the browser the worker generates them and moves take 23–25 ms. The limit is 150 ms, as it was in the
 * unit test; it moved here because, sharing the CPU with three other test files, a slow CI runner measured 157 ms
 * (run 11, with every other test file also running about 1.75 times slower than usual).
 */
describe('region streaming, timed', () => {
  it('a window move takes under 150 ms, including generating its new regions on this thread', () => {
    const { engine, session } = createContinentEngine({ worker: false, life: false });
    engine.cam.setViewport(1440, 900);
    engine.focus(...engine.home!);
    let f = 0, moves = 0;
    session.onShift = () => { moves++; };
    for (let k = 0; k < 1300; k++) { engine.cam.x += 1; engine.frame(f++ * 1000 / 60); }
    for (let k = 0; k < 600; k++) { engine.cam.y += 1; engine.frame(f++ * 1000 / 60); }
    console.log(`window moves: ${moves}, slowest ${session.stats.maxShiftMs.toFixed(0)} ms, last ${session.stats.lastShiftMs.toFixed(0)} ms; region generation max ${session.cache.stats.maxMs.toFixed(0)} ms`);
    expect(moves).toBeGreaterThanOrEqual(6);
    expect(session.stats.maxShiftMs).toBeLessThan(150);
  });
});
