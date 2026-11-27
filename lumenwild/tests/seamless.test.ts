import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain } from '../src/world/terrain';
import { LifeSim } from '../src/world/life/LifeSim';
import type { TerrainQuery } from '../src/world/life/core';
import { NEARBY_R, type Creature } from '../src/world/life/wildlife';
import { RegionStore } from '../server/regionStore';
import { masksOf } from '../server/regionMasks';
import { WorldServer } from '../server/WorldServer';

/**
 * M2 (seamless server world): regions made on worker threads, a demand-sized cache that never drops a region in use,
 * the wildlife region index, and the faster coarse water test. The 18-player acceptance run is
 * tests/acceptance/m2-seamless.test.ts (`npm run test:accept`, alone, because it measures time).
 */
let bp: Blueprint, ct: ContinentTerrain;
beforeAll(() => { bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp); }, 60_000);

const S = 256;
const square = (i: number) => ct.village(bp.data.settlements[i].id)!.square;

describe('the coarse water test (256 m river buckets)', () => {
  it('never misses a river: wherever a river segment wets a point, the test says wet', () => {
    type Seg = { ax: number; ay: number; bx: number; by: number; ha: number; hb: number };
    const segs = (ct as unknown as { segs: Seg[] }).segs, site = ct.siteQuery();
    const wetBy = (s: Seg, x: number, y: number, m: number) => {
      const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2));
      return Math.hypot(s.ax + dx * t - x, s.ay + dy * t - y) < s.ha + (s.hb - s.ha) * t + m;
    };
    let r = 12345;
    const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
    let checked = 0, wet = 0;
    for (let k = 0; k < 4000; k++) {
      // Points across and around the banks of random segments, including cell corners (all margins callers use).
      const s = segs[Math.floor(rnd() * segs.length)], t = rnd(), a = rnd() * Math.PI * 2, d = rnd() * (Math.max(s.ha, s.hb) + 24);
      const x = s.ax + (s.bx - s.ax) * t + Math.cos(a) * d, y = s.ay + (s.by - s.ay) * t + Math.sin(a) * d;
      for (const m of [0, 4, 6, 7, 14, 16]) {
        const truth = segs.some((q) => wetBy(q, x, y, m));
        checked++;
        if (truth) { wet++; expect(site.wet(x, y, m)).toBe(true); }
      }
    }
    expect(checked).toBe(24_000);
    expect(wet).toBeGreaterThan(2000);
  });
});

describe('the server region store', { timeout: 120_000 }, () => {
  it('regions made on worker threads are identical to regions made here', async () => {
    const store = new RegionStore(ct);
    const p = square(0);
    store.request([p]);
    await store.settle();
    expect(store.stats.syncFallback).toBe(0); // the worker bundle was found (tests/setup/buildWorker.ts)
    expect(store.stats.workerStarts).toBeGreaterThan(0);
    expect(store.cache.size).toBe(9);
    const rx = Math.floor(p.x / S), ry = Math.floor(p.y / S);
    for (const [dx, dy] of [[0, 0], [1, -1], [-1, 1]]) {
      const got = store.get(rx + dx, ry + dy)!, want = ct.generateRegion(rx + dx, ry + dy), masks = masksOf(want);
      expect(Buffer.from(got.r.elev.buffer).equals(Buffer.from(want.elev.buffer))).toBe(true);
      expect(Buffer.from(got.r.mat.buffer).equals(Buffer.from(want.mat.buffer))).toBe(true);
      expect(Buffer.from(got.r.waterKind.buffer).equals(Buffer.from(want.waterKind.buffer))).toBe(true);
      expect(Buffer.from(got.r.biome.buffer).equals(Buffer.from(want.biome.buffer))).toBe(true);
      expect(got.r.objects).toEqual(want.objects);
      expect(Buffer.from(got.solid).equals(Buffer.from(masks.solid))).toBe(true);
      expect(Buffer.from(got.deck).equals(Buffer.from(masks.deck))).toBe(true);
    }
    await store.close();
  });

  it('never evicts a region in use, stays within its capacity, and sizes it by demand', async () => {
    const store = new RegionStore(ct, { minRegions: 16, margin: 4, maxRegions: 30 });
    const home = square(0), far = [square(1), square(2), square(3)];
    store.pin([home]);
    expect(store.stats.capacity).toBe(16); // 9 pinned + 4, raised to the floor
    store.request(far); // 27 more regions nobody stands in
    await store.settle();
    expect(store.cache.size).toBeLessThanOrEqual(16);
    expect(store.stats.evicted).toBeGreaterThanOrEqual(36 - 16);
    const hrx = Math.floor(home.x / S), hry = Math.floor(home.y / S);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      expect(store.isPinned(hrx + dx, hry + dy)).toBe(true);
      expect(store.get(hrx + dx, hry + dy)).toBeDefined(); // the pinned ones survived every eviction
    }
    // Four players in four places: 36 pinned regions, more than maxRegions: capacity follows demand, nothing pinned goes.
    store.pin([home, ...far]);
    await store.settle();
    expect(store.stats.capacity).toBe(36);
    expect(store.cache.size).toBe(36);
    for (const p of [home, ...far]) expect(store.get(Math.floor(p.x / S), Math.floor(p.y / S))).toBeDefined();
    // Back to one player: the cache shrinks to the demand again at the next eviction.
    store.pin([home]);
    store.request([home]);
    expect(store.cache.size).toBeLessThanOrEqual(16);
    await store.close();
  });

  it('stops idle workers and starts them again when regions are wanted', async () => {
    const store = new RegionStore(ct, { idleMs: 200 });
    store.pin([square(0)]);
    await store.settle();
    expect(store.stats.workers).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    store.pin([square(0)]);
    expect(store.stats.workers).toBe(0);
    expect(store.stats.workersStopped).toBeGreaterThan(0);
    const starts = store.stats.workerStarts;
    store.pin([square(4)]);
    await store.settle();
    expect(store.stats.workerStarts).toBeGreaterThan(starts);
    expect(store.get(Math.floor(square(4).x / S), Math.floor(square(4).y / S))).toBeDefined();
    await store.close();
  });

  it('a world server never generates a region on its update loop', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    let onMain = 0;
    const gen = server.terrain.generateRegion.bind(server.terrain);
    server.terrain.generateRegion = (rx: number, ry: number) => { onMain++; return gen(rx, ry); };
    const port = await server.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => { ws.onopen = r; });
    let id = '';
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'welcome') id = m.id; };
    ws.send(JSON.stringify({ type: 'hello', name: 'Walker', v: 2 }));
    for (let k = 0; k < 100 && !id; k++) await new Promise((r) => setTimeout(r, 20));
    await server.q.store.settle();
    // Arrive in another village (as a fast traveller would): its regions are queued and made off the loop.
    const p = server.sim.players.get(id)!, v = square(5);
    p.x = v.x; p.y = v.y;
    expect(server.q.detailed(v.x, v.y)).toBe(false); // not here yet: answers are coarse meanwhile
    await new Promise((r) => setTimeout(r, 1200)); // the next pin (once a second)
    await server.q.store.settle();
    expect(server.q.detailed(v.x, v.y)).toBe(true);
    expect(onMain).toBe(0);
    expect(server.q.store.stats.syncFallback).toBe(0);
    ws.close();
    await server.stop();
  });
});

describe('the wildlife region index', { timeout: 120_000 }, () => {
  /** The browser's view: exact inside the 3 x 3 regions around the player, coarse outside. */
  function windowQuery(sim: () => LifeSim): TerrainQuery {
    const site = ct.siteQuery();
    const inside = (x: number, y: number) => { const p = sim().players.get('a'); return !!p && Math.abs(Math.floor(x / S) - Math.floor(p.x / S)) <= 1 && Math.abs(Math.floor(y / S) - Math.floor(p.y / S)) <= 1; };
    return { height: (x, y) => site.z(x, y), water: (x, y) => site.wet(x, y, 0), walkable: (x, y) => !site.wet(x, y, 0), biome: () => 'heartlands', detailed: inside };
  }
  const run = (s: LifeSim, secs: number) => { for (let t = 0; t < secs; t += 0.1) s.update(0.1, { hour: 11, rain: 0 }); };

  it('keeps every creature listed once, where it is; tiers are what they were before the index', () => {
    let s!: LifeSim;
    const q = windowQuery(() => s);
    s = new LifeSim(bp, ct, q);
    const home = square(0);
    s.addPlayer('a', 'Ada', home.x, home.y);
    run(s, 3);
    const w = s.wildlife;
    expect(w.creatures.size).toBeGreaterThan(100);
    expect(w.checkIndex()).toEqual([]);
    run(s, 10);
    expect(w.checkIndex()).toEqual([]); // creatures walked across region borders and were re-listed
    // One step by hand: every living creature's tier is the pre-index rule, from where it stood.
    const focus = [...s.players.values()], before = new Map([...w.creatures.values()].map((c) => [c, [c.x, c.y] as const]));
    w.update(0.1, focus, (s as unknown as { wctx: Parameters<typeof w.update>[2] }).wctx);
    for (const c of w.creatures.values()) {
      if (!c.alive) continue;
      const [x, y] = before.get(c)!, dmin = Math.min(...focus.map((f) => Math.hypot(f.x - x, f.y - y)));
      expect(c.tier).toBe(q.detailed(x, y) ? 0 : dmin < NEARBY_R ? 1 : 2);
    }
    // Queries by region answer as a scan of the whole map would.
    for (let k = 0; k < 40; k++) {
      const x = home.x + (k % 8 - 4) * 300, y = home.y + (Math.floor(k / 8) - 2) * 300, r = 50 + k * 15;
      const scan = [...w.creatures.values()].filter((c) => Math.hypot(c.x - x, c.y - y) < r).map((c) => c.id).sort();
      expect(w.near(x, y, r).map((c) => c.id).sort()).toEqual(scan);
    }
  });

  it('dormant regions are not visited: their creatures wait, and wake when a player returns', () => {
    let s!: LifeSim;
    s = new LifeSim(bp, ct, windowQuery(() => s));
    const home = square(0);
    const p = s.addPlayer('a', 'Ada', home.x, home.y);
    run(s, 3);
    const w = s.wildlife, nearHome = [...w.creatures.values()].filter((c) => c.alive && Math.hypot(c.x - home.x, c.y - home.y) < 1500);
    expect(nearHome.length).toBeGreaterThan(20);
    // The player goes far away (another village, more than NEARBY_R): home's animals become dormant.
    const away = bp.data.settlements.map((_, i) => square(i)).find((v) => Math.hypot(v.x - home.x, v.y - home.y) > NEARBY_R + 3000)!;
    p.x = away.x; p.y = away.y;
    run(s, 3);
    expect(w.stats.dormant).toBeGreaterThan(0);
    expect(w.stats.visited).toBeLessThan(w.creatures.size);
    const frozen = nearHome.map((c) => [c.x, c.y, c.hunger, c.tier]);
    run(s, 5);
    expect(nearHome.map((c) => [c.x, c.y, c.hunger, c.tier])).toEqual(frozen);
    for (const c of nearHome) expect(c.tier).toBe(2);
    // Back home: they move again.
    p.x = home.x; p.y = home.y;
    run(s, 8);
    expect(nearHome.some((c, i) => c.x !== frozen[i][0] || c.y !== frozen[i][1])).toBe(true);
    expect(nearHome.filter((c) => c.alive).every((c) => c.tier < 2)).toBe(true);
    expect(w.checkIndex()).toEqual([]);
  });

  it('follows creatures added, replaced and removed directly, and a reloaded world', () => {
    let s!: LifeSim;
    s = new LifeSim(bp, ct, windowQuery(() => s));
    const home = square(0);
    s.addPlayer('a', 'Ada', home.x, home.y);
    run(s, 3);
    const w = s.wildlife, any = [...w.creatures.values()][0];
    const extra: Creature = { ...any, id: 'test-extra', group: 'test-extra', x: home.x + 5, y: home.y + 5 };
    w.creatures.set(extra.id, extra);
    expect(w.near(home.x + 5, home.y + 5, 1).map((c) => c.id)).toEqual(['test-extra']);
    const moved: Creature = { ...extra, x: home.x + 900, y: home.y };
    w.creatures.set(extra.id, moved); // replaced
    expect(w.near(home.x + 5, home.y + 5, 1)).toEqual([]);
    expect(w.near(home.x + 900, home.y, 1).map((c) => c.id)).toEqual(['test-extra']);
    w.creatures.delete(extra.id);
    expect(w.checkIndex()).toEqual([]);
    run(s, 2);
    const saved = JSON.parse(JSON.stringify(s.toJSON()));
    let s2!: LifeSim;
    s2 = new LifeSim(bp, ct, windowQuery(() => s2));
    s2.addPlayer('a', 'Ada', home.x, home.y);
    s2.load(saved);
    expect(s2.wildlife.creatures.size).toBe(w.creatures.size);
    expect(s2.wildlife.checkIndex()).toEqual([]);
    run(s2, 2);
    expect(s2.wildlife.checkIndex()).toEqual([]);
  });
});
