import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../../server/WorldServer';
import { PROTOCOL, type ServerMsg } from '../../src/world/net/protocol';

/**
 * M2 acceptance (run alone: `npm run test:accept`, so other tests do not share the CPU).
 *
 * 18 players over real WebSockets, three in each of the six villages, walking and fighting. Every 5 s one player per
 * village travels 400 m into new ground (as a fast traveller arriving would), so regions are generated throughout.
 * Required:
 * - server update p95 < 15 ms and worst update < 50 ms;
 * - no region generated on the server loop, and every traveller's ground arrives (no repeated generation stalls);
 * - bounded memory (the region cache within its demand-sized capacity; heap growth bounded);
 * - consistent creature and world state: every player gets snapshots; players in the same place see the same
 *   creatures and dragons; snapshots hold only what is near; the wildlife index is intact; the world saves and loads.
 * The seeded walk makes runs comparable. Results also go to bench-results/m2-acceptance-<time>.json.
 */
const SECS = Number(process.env.LUMENWILD_ACCEPT_SECS ?? 30), WARM = 4, PER_VILLAGE = 3;

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pct = (a: number[], f: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };

interface Bot { ws: WebSocket; id: string; x: number; y: number; h: number; r: () => number; village: number; snaps: number; errors: number; last: Extract<ServerMsg, { type: 'snap' }> | null; byT: Map<number, Extract<ServerMsg, { type: 'snap' }>> }

describe('M2 acceptance: 18 players across the six villages', () => {
  it('keeps the server loop fast, generates regions off the loop, and keeps one consistent world', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const ticks: number[] = [];
    const tick0 = server.tick.bind(server);
    server.tick = (dt: number) => { const t = performance.now(); tick0(dt); ticks.push(performance.now() - t); };
    let onMain = 0;
    const gen0 = server.terrain.generateRegion.bind(server.terrain);
    server.terrain.generateRegion = (rx: number, ry: number) => { onMain++; return gen0(rx, ry); };
    const port = await server.listen();
    const villages = server.bp.data.settlements.map((s) => server.terrain.village(s.id)!.square);
    expect(villages.length).toBe(6);

    const bots: Bot[] = [];
    for (let k = 0; k < villages.length * PER_VILLAGE; k++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const b: Bot = { ws, id: '', x: 0, y: 0, h: (k * 2.4) % 6.28, r: rng(100 + k), village: k % villages.length, snaps: 0, errors: 0, last: null, byT: new Map() };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as ServerMsg;
        if (m.type === 'welcome') b.id = m.id;
        else if (m.type === 'snap') { b.snaps++; b.last = m; b.byT.set(m.t, m); if (b.byT.size > 40) b.byT.delete(b.byT.keys().next().value!); }
        else if (m.type === 'correct') { b.x = m.x; b.y = m.y; }
      };
      ws.onerror = () => { b.errors++; };
      await new Promise((res) => { ws.onopen = res; });
      ws.send(JSON.stringify({ type: 'hello', name: `Player${k}`, v: PROTOCOL }));
      bots.push(b);
    }
    for (let k = 0; k < 200 && bots.some((b) => !b.id); k++) await new Promise((r) => setTimeout(r, 25));
    expect(bots.every((b) => b.id)).toBe(true);
    // Three to a village (placed by the server, as a teleport or a saved position would).
    bots.forEach((b, k) => {
      const v = villages[b.village], p = server.sim.players.get(b.id)!;
      p.x = v.x + (Math.floor(k / villages.length) - 1) * 3; p.y = v.y + 1; b.x = p.x; b.y = p.y;
    });
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1100)); // the next pin
    await server.q.store.settle(60_000);
    const settleMs = Date.now() - t0;
    await new Promise((r) => setTimeout(r, WARM * 1000));

    // Measured run.
    ticks.length = 0; onMain = 0;
    const heap0 = process.memoryUsage().heapUsed;
    let heapMax = heap0, rssMax = 0, capMax = 0, cacheMax = 0, overCapacity = 0;
    const gen0Count = server.q.store.stats.generated;
    const mem = setInterval(() => {
      const m = process.memoryUsage(); heapMax = Math.max(heapMax, m.heapUsed); rssMax = Math.max(rssMax, m.rss);
      capMax = Math.max(capMax, server.q.store.stats.capacity); cacheMax = Math.max(cacheMax, server.q.store.cache.size);
      if (server.q.store.cache.size > server.q.store.stats.capacity + 9) overCapacity++; // + one pin's worth in flight
    }, 250);
    const walk = setInterval(() => {
      for (const b of bots) {
        for (let t = 0; t < 6; t++) {
          const nx = b.x + Math.cos(b.h) * 0.4, ny = b.y + Math.sin(b.h) * 0.4;
          if (server.q.walkable(nx, ny)) { b.x = nx; b.y = ny; break; }
          b.h += 1 + b.r();
        }
        if (b.r() < 0.05) b.h += (b.r() - 0.5) * 2;
        b.ws.send(JSON.stringify({ type: 'move', x: b.x, y: b.y, h: b.h, run: false }));
        if (b.r() < 0.15) b.ws.send(JSON.stringify({ type: 'cmd', cmd: { t: 'attack', h: b.h } }));
      }
    }, 100);
    // Travellers: the first player of each village goes 400 m further every 5 s; time until its ground arrives.
    const arrivals: number[] = [];
    let legs = 0;
    const travel = setInterval(() => {
      legs++;
      for (const b of bots.slice(0, villages.length)) {
        const p = server.sim.players.get(b.id)!, a = (b.village / villages.length) * Math.PI * 2;
        p.x += Math.cos(a) * 400; p.y += Math.sin(a) * 400; b.x = p.x; b.y = p.y;
        const at = Date.now(), x = p.x, y = p.y;
        const wait = setInterval(() => { if (server.q.detailed(x, y)) { arrivals.push(Date.now() - at); clearInterval(wait); } else if (Date.now() - at > 20_000) { arrivals.push(Infinity); clearInterval(wait); } }, 50);
      }
    }, 5000);
    await new Promise((r) => setTimeout(r, SECS * 1000));
    clearInterval(walk); clearInterval(travel); clearInterval(mem);
    await new Promise((r) => setTimeout(r, 2500)); // the last legs' ground

    const p95 = pct(ticks, 0.95), max = Math.max(...ticks), mean = ticks.reduce((a, b) => a + b, 0) / ticks.length;
    const w = server.sim.wildlife;
    const result = {
      kind: 'lumenwild-m2-acceptance', at: new Date().toISOString(), node: process.version, players: bots.length, seconds: SECS,
      tickMs: { mean: +mean.toFixed(2), p50: +pct(ticks, 0.5).toFixed(2), p95: +p95.toFixed(2), p99: +pct(ticks, 0.99).toFixed(2), max: +max.toFixed(2), over50: ticks.filter((t) => t > 50).length, ticks: ticks.length },
      regions: { generatedDuringRun: server.q.store.stats.generated - gen0Count, onMainThread: onMain, travelLegs: legs * villages.length, arrivalMsMax: Math.max(...arrivals), arrivalMsP50: pct(arrivals, 0.5), cacheMax, capacityMax: capMax, evicted: server.q.store.stats.evicted, workerStarts: server.q.store.stats.workerStarts, settleAtStartMs: settleMs },
      memoryMB: { heapStart: +(heap0 / 1048576).toFixed(1), heapMax: +(heapMax / 1048576).toFixed(1), rssMax: +(rssMax / 1048576).toFixed(1) },
      creatures: w.creatures.size, visitedPerStep: w.stats.visited, dormant: w.stats.dormant, snapshotsPerPlayer: [Math.min(...bots.map((b) => b.snaps)), Math.max(...bots.map((b) => b.snaps))],
    };
    console.log(`M2 acceptance: ${JSON.stringify(result)}`);
    mkdirSync(join(__dirname, '..', '..', 'bench-results'), { recursive: true });
    writeFileSync(join(__dirname, '..', '..', 'bench-results', `m2-acceptance-${result.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(result, null, 2));

    // Performance.
    expect(ticks.length).toBeGreaterThan(SECS * 10 * 0.8);
    expect(p95).toBeLessThan(15);
    expect(max).toBeLessThan(50);
    // Regions: never on the loop; every traveller's ground arrived.
    expect(onMain).toBe(0);
    expect(server.q.store.stats.syncFallback).toBe(0);
    expect(result.regions.generatedDuringRun).toBeGreaterThan(20);
    expect(arrivals.length).toBe(legs * villages.length);
    expect(Math.max(...arrivals)).toBeLessThan(10_000);
    // Bounded memory.
    expect(overCapacity).toBe(0);
    expect(cacheMax).toBeLessThanOrEqual(Math.max(192, 9 * bots.length) + 9);
    expect(heapMax - heap0).toBeLessThan(200 * 1048576);
    // One consistent world.
    for (const b of bots) {
      expect(b.errors).toBe(0);
      expect(b.snaps).toBeGreaterThan(SECS * 4 * 0.8);
      const p = server.sim.players.get(b.id)!, s = b.last!;
      expect(s.players.length).toBe(bots.length);
      for (const c of s.creatures) expect(Math.hypot(c[2] - p.x, c[3] - p.y)).toBeLessThan(600 + 60); // near (it moved since)
    }
    const nearest = bots.map((b) => { const p = server.sim.players.get(b.id)!; return villages.map((v) => Math.hypot(v.x - p.x, v.y - p.y)).reduce((bi, d, i, a) => (d < a[bi] ? i : bi), 0); });
    expect(new Set(nearest.slice(villages.length)).size).toBe(6); // all six villages still have players
    for (let v = 0; v < villages.length; v++) {
      // Two players of the same village, the same snapshot time: the same creatures and dragons.
      const [a, b] = bots.filter((q) => q.village === v).slice(1);
      const t = [...a.byT.keys()].reverse().find((k) => b.byT.has(k))!;
      expect(t).toBeDefined();
      const sa = a.byT.get(t)!, sb = b.byT.get(t)!;
      expect(sb.dragons).toEqual(sa.dragons);
      const common = sa.creatures.filter((c) => sb.creatures.some((d) => d[0] === c[0]));
      expect(common.length).toBeGreaterThan(0);
      for (const c of common) expect(sb.creatures.find((d) => d[0] === c[0])).toEqual(c);
    }
    expect(w.checkIndex()).toEqual([]);
    // The world saves and loads with everyone and everything in it.
    const file = join(mkdtempSync(join(tmpdir(), 'lw-accept-')), 'world.json');
    server.save(file);
    for (const b of bots) b.ws.close();
    await server.stop();
    const again = new WorldServer({ port: 0, dataFile: file });
    expect(again.sessions.size).toBe(bots.length);
    expect(again.sim.wildlife.creatures.size).toBe(w.creatures.size);
    expect(again.sim.wildlife.checkIndex()).toEqual([]);
    await again.q.store.close();
  }, 240_000);
});
