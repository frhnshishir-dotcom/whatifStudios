import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain, WK_RIVER, WK_LAKE, WK_SEA, type RegionData } from '../src/world/terrain';
import { Navigator, Traveller } from '../src/world/navigation';
import { createContinentEngine } from '../src/boot';

let bp: Blueprint, nav: Navigator;
beforeAll(() => { bp = buildBlueprint(WORLD); nav = new Navigator(bp); }, 60_000);
const MPU = 100, S = 256;

describe('navigation across the continent', { timeout: 180_000 }, () => {
  it('every pair of villages is connected by a route that follows the land', () => {
    const vs = WORLD.settlements;
    for (let a = 0; a < vs.length; a++) for (let b = a + 1; b < vs.length; b++) {
      const r = nav.route(vs[a].at, vs[b].at);
      expect(r, `${vs[a].id}-${vs[b].id}`).not.toBeNull();
      const straight = Math.hypot(vs[b].at[0] - vs[a].at[0], vs[b].at[1] - vs[a].at[1]) * MPU;
      const L = nav.lengthOf(r!);
      expect(L, `${vs[a].id}-${vs[b].id}`).toBeGreaterThanOrEqual(straight * 0.999);
      expect(L, `${vs[a].id}-${vs[b].id}`).toBeLessThan(straight * 1.8);
    }
  });

  it('walking Lumenfall to Greenhaven at 1 m: walkable grades, rivers crossed only at bridges, no lakes or sea', () => {
    const ct = new ContinentTerrain(bp);
    const cache = new Map<string, RegionData>();
    const at = (xm: number, ym: number) => {
      const rx = Math.floor(xm / S), ry = Math.floor(ym / S), k = `${rx},${ry}`;
      if (!cache.has(k)) cache.set(k, ct.generateRegion(rx, ry));
      const r = cache.get(k)!, i = (Math.floor(ym) - r.oy) * S + Math.floor(xm) - r.ox;
      return { e: r.elev[i], w: r.waterKind[i] };
    };
    const route = nav.route(WORLD.settlements[0].at, WORLD.settlements[1].at)!;
    const t = new Traveller(route, 1, MPU);
    const bridges = bp.roads.flatMap((r) => r.bridges.map((b) => [b.at[0] * MPU, b.at[1] * MPU]));
    let prev = at(...(t.position().map((v) => v * MPU) as [number, number])), steep = 0, n = 0, wetAway = 0;
    while (!t.done) {
      t.progress += 10;
      const p = t.position(), xm = p[0] * MPU, ym = p[1] * MPU, q = at(xm, ym);
      expect([WK_LAKE, WK_SEA]).not.toContain(q.w);
      if (q.w === WK_RIVER && !bridges.some(([bx, by]) => Math.hypot(bx - xm, by - ym) < 400)) wetAway++;
      if (q.w === 0 && prev.w === 0) { n++; if (Math.abs(q.e - prev.e) / 10 > 0.35) steep++; }
      prev = q;
    }
    console.log(`Lumenfall to Greenhaven: ${(t.length / 1000).toFixed(1)} km, ${cache.size} regions generated, ${(100 * steep / n).toFixed(2)}% of 10 m steps steeper than 35%`);
    expect(steep / n).toBeLessThan(0.02);
    expect(wetAway).toBe(0);
  });

  it('the engine follows a journey: the window streams along, the camera stays on the traveller', () => {
    const { engine, session } = createContinentEngine({ worker: false });
    session.prefetchRing = false; // no worker here: generate only what the moves need
    engine.cam.setViewport(1440, 900);
    engine.focus(...engine.home!);
    const L = session.startTravel(engine, WORLD.settlements[1].at, 600, 'Greenhaven');
    expect(L).toBeGreaterThan(20_000);
    let f = 0;
    // 6 km of the journey at 600 m/s (10 m per frame).
    while (session.travel && session.travel.progress < 6000) engine.frame(f++ * 1000 / 60);
    const target = session.travel!.position();
    const [fx, fy] = session.focusCell(engine), here = session.mapOf(fx, fy);
    expect(Math.hypot(here[0] - target[0], here[1] - target[1]) * MPU).toBeLessThan(60); // the view is on the traveller
    expect(session.stats.shifts).toBeGreaterThanOrEqual(15);
    expect(session.stats.maxShiftMs).toBeLessThan(400); // includes generating the strip on this thread (no worker)
    console.log(`journey: ${session.stats.shifts} window moves, slowest ${session.stats.maxShiftMs.toFixed(0)} ms, ${session.cache.stats.generated} regions generated`);
    expect(engine.world.w).toBe(768);
  });
});
