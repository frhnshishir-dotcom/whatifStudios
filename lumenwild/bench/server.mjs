// Server benchmark (reproducible): `npm run bench:server [-- --secs 20 --scenario all]`
//
// Builds the world server from source (Vite SSR -> dist-bench/), starts it in this process on a free port and
// connects seeded bot clients over real WebSockets. Scenarios:
//   together-16  16 bots walking around Lumenfall's square
//   spread-18    18 bots, three in each of the six villages (several active areas at once)
//   travel-18    spread-18, and every 5 s one bot per village travels 400 m into new ground (region generation
//                throughout; the time until each traveller's ground is exact is measured)
// The same script runs on older checkouts (no region worker there): before/after numbers come from one script.
// Every server tick is timed (wrapped), as is main-thread region work (GenQuery.ensureAround and region generation).
// Also measured: snapshot cost, living-world cost per tick, traffic per client, creatures, regions cached, heap and
// RSS, save time and size, load time. A JSON report goes to bench-results/.
import { build } from 'vite';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const SECS = Number(arg('secs', 20)), WARM = Number(arg('warm', 3)), ONLY = arg('scenario', 'all');

/** Mulberry32: the same bot walks every run. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const q = (a, f) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
const r2 = (v) => Math.round(v * 100) / 100;

console.log('Building the server for benchmarking…');
await build({ root, logLevel: 'warn', build: { ssr: join(root, 'server/WorldServer.ts'), outDir: join(root, 'dist-bench'), emptyOutDir: true, sourcemap: false } });
if (existsSync(join(root, 'server/regionWorker.ts'))) await build({ root, logLevel: 'warn', build: { ssr: join(root, 'server/regionWorker.ts'), outDir: join(root, 'dist-bench'), emptyOutDir: false, sourcemap: false } });
const { WorldServer } = await import(pathToFileURL(join(root, 'dist-bench/WorldServer.js')).href);

async function scenario(name, bots, spread, travel = false) {
  const server = new WorldServer({ port: 0, dataFile: null });
  const port = await server.listen();
  // Instrumentation (wrapping only; the server code is unchanged).
  const ticks = [], regionWork = { ms: 0, max: 0, calls: 0 }, gen = { n: 0, ms: 0, max: 0 }, snaps = { n: 0, ms: 0 };
  const life = { w: 0, v: 0, d: 0, n: 0 };
  const tick0 = server.tick.bind(server);
  server.tick = (dt) => { const t = performance.now(); tick0(dt); ticks.push(performance.now() - t); const st = server.sim.stats; life.w += st.wildlifeMs; life.v += st.villagerMs; life.d += st.dragonMs; life.n++; };
  const ens0 = server.q.ensureAround.bind(server.q);
  server.q.ensureAround = (x, y) => { const t = performance.now(); ens0(x, y); const d = performance.now() - t; regionWork.ms += d; regionWork.max = Math.max(regionWork.max, d); regionWork.calls++; };
  const gen0 = server.terrain.generateRegion.bind(server.terrain);
  server.terrain.generateRegion = (rx, ry) => { const t = performance.now(); const r = gen0(rx, ry); const d = performance.now() - t; gen.n++; gen.ms += d; gen.max = Math.max(gen.max, d); return r; };
  const snap0 = server.snapshots.bind(server);
  server.snapshots = () => { const t = performance.now(); snap0(); snaps.n++; snaps.ms += performance.now() - t; };

  const squares = server.bp.data.settlements.map((s) => server.terrain.village(s.id).square);
  const R = rng(1234), cs = [];
  for (let k = 0; k < bots; k++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = { ws, id: '', x: 0, y: 0, h: R() * Math.PI * 2, snaps: 0, bytes: 0, r: rng(100 + k) };
    ws.onmessage = (e) => { const t = String(e.data); c.bytes += t.length; const m = JSON.parse(t); if (m.type === 'welcome') c.id = m.id; else if (m.type === 'snap') c.snaps++; else if (m.type === 'correct') { c.x = m.x; c.y = m.y; } };
    await new Promise((res) => { ws.onopen = res; });
    ws.send(JSON.stringify({ type: 'hello', name: `Bot${k}`, v: 2 }));
    cs.push(c);
  }
  for (let k = 0; k < 200 && cs.some((c) => !c.id); k++) await new Promise((r) => setTimeout(r, 25));
  // Place the bots (server side): all on Lumenfall's square, or three to a village.
  cs.forEach((c, k) => {
    const p = server.sim.players.get(c.id), v = spread ? squares[k % squares.length] : squares[0];
    p.x = v.x + (k % 5) - 2; p.y = v.y + (Math.floor(k / 5) % 3) - 1; c.x = p.x; c.y = p.y;
  });
  await new Promise((r) => setTimeout(r, WARM * 1000));
  if (server.q.store?.settle) await server.q.store.settle(60_000); // M2 and later: the villages' ground is made off the loop
  ticks.length = 0; regionWork.ms = regionWork.max = regionWork.calls = 0; gen.n = gen.ms = gen.max = 0; snaps.n = snaps.ms = 0; life.w = life.v = life.d = life.n = 0;
  server.stats.maxTickMs = 0;
  const b0 = server.stats.bytesOut, heap0 = process.memoryUsage().heapUsed, t0 = Date.now();
  let heapMax = 0, rssMax = 0;
  const mem = setInterval(() => { const m = process.memoryUsage(); heapMax = Math.max(heapMax, m.heapUsed); rssMax = Math.max(rssMax, m.rss); }, 250);
  const walk = setInterval(() => {
    for (const c of cs) {
      for (let t = 0; t < 6; t++) {
        const nx = c.x + Math.cos(c.h) * 0.4, ny = c.y + Math.sin(c.h) * 0.4;
        if (server.q.walkable(nx, ny)) { c.x = nx; c.y = ny; break; }
        c.h += 1 + c.r();
      }
      if (c.r() < 0.05) c.h += (c.r() - 0.5) * 2;
      c.ws.send(JSON.stringify({ type: 'move', x: c.x, y: c.y, h: c.h, run: false }));
      if (c.r() < 0.15) c.ws.send(JSON.stringify({ type: 'cmd', cmd: { t: 'attack', h: c.h } }));
    }
  }, 100);
  // Travellers (travel-18): bot k (k < villages) goes 400 m further every 5 s, outward from its village.
  const arrivals = [];
  let legs = 0;
  const travelT = travel ? setInterval(() => {
    legs++;
    for (let k = 0; k < squares.length; k++) {
      const c = cs[k], p = server.sim.players.get(c.id), a = (k / squares.length) * Math.PI * 2;
      p.x += Math.cos(a) * 400; p.y += Math.sin(a) * 400; c.x = p.x; c.y = p.y;
      const at = performance.now(), x = p.x, y = p.y;
      const wait = setInterval(() => { if (server.q.detailed(x, y)) { arrivals.push(performance.now() - at); clearInterval(wait); } else if (performance.now() - at > 20_000) { arrivals.push(Infinity); clearInterval(wait); } }, 20);
    }
  }, 5000) : null;
  await new Promise((r) => setTimeout(r, SECS * 1000));
  clearInterval(walk); clearInterval(mem); if (travelT) clearInterval(travelT);
  if (travel) await new Promise((r) => setTimeout(r, 3000)); // the last legs' ground
  const secs = (Date.now() - t0) / 1000;
  const out = {
    scenario: name, bots, seconds: r2(secs),
    tickMs: { mean: r2(ticks.reduce((a, b) => a + b, 0) / Math.max(1, ticks.length)), p50: r2(q(ticks, 0.5)), p95: r2(q(ticks, 0.95)), p99: r2(q(ticks, 0.99)), max: r2(Math.max(0, ...ticks)), over15ms: ticks.filter((t) => t > 15).length, over50ms: ticks.filter((t) => t > 50).length, ticks: ticks.length },
    ...(travel ? { travel: { legs: legs * squares.length, arrivals: arrivals.length, arrivalMsP50: r2(q(arrivals, 0.5)), arrivalMsMax: r2(Math.max(0, ...arrivals)) } } : {}),
    mainThreadRegionMs: { total: r2(regionWork.ms), max: r2(regionWork.max), perSecond: r2(regionWork.ms / secs) },
    regionGenerationsOnMainThread: { count: gen.n, totalMs: r2(gen.ms), maxMs: r2(gen.max) },
    snapshotMsPerRound: r2(snaps.ms / Math.max(1, snaps.n)),
    lifeMsPerTick: { wildlife: r2(life.w / Math.max(1, life.n)), villagers: r2(life.v / Math.max(1, life.n)), dragons: r2(life.d / Math.max(1, life.n)) },
    kbPerClientPerSecond: r2((server.stats.bytesOut - b0) / secs / bots / 1024),
    snapshotsPerBot: { min: Math.min(...cs.map((c) => c.snaps)), max: Math.max(...cs.map((c) => c.snaps)) },
    creatures: server.sim.wildlife.creatures.size, villagers: server.sim.villages.people.size, regionsCached: server.q.cache?.size ?? null,
    memoryMB: { heapStart: r2(heap0 / 1048576), heapMax: r2(heapMax / 1048576), rssMax: r2(rssMax / 1048576) },
  };
  const file = join(mkdtempSync(join(tmpdir(), 'lw-bench-')), 'world.json');
  let t = performance.now(); server.save(file); out.saveMs = r2(performance.now() - t); out.saveKB = r2(statSync(file).size / 1024);
  for (const c of cs) c.ws.close();
  await server.stop();
  t = performance.now(); const s2 = new WorldServer({ port: 0, dataFile: file }); out.loadMs = r2(performance.now() - t); out.loadedSessions = s2.sessions.size;
  return out;
}

const results = [];
if (ONLY === 'all' || ONLY === 'together-16') results.push(await scenario('together-16', 16, false));
if (ONLY === 'all' || ONLY === 'spread-18') results.push(await scenario('spread-18', 18, true));
if (ONLY === 'all' || ONLY === 'travel-18') results.push(await scenario('travel-18', 18, true, true));
const report = { kind: 'lumenwild-server-benchmark', version: 1, at: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, secs: SECS, results };
mkdirSync(join(root, 'bench-results'), { recursive: true });
const name = join(root, 'bench-results', `server-${report.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(name, JSON.stringify(report, null, 2));
for (const r of results) {
  console.log(`\n${r.scenario} (${r.bots} bots, ${r.seconds} s)`);
  console.log(`  tick ms: mean ${r.tickMs.mean}, p50 ${r.tickMs.p50}, p95 ${r.tickMs.p95}, p99 ${r.tickMs.p99}, max ${r.tickMs.max}, ticks over 15 ms ${r.tickMs.over15ms}, over 50 ms ${r.tickMs.over50ms}/${r.tickMs.ticks}`);
  if (r.travel) console.log(`  travel: ${r.travel.legs} legs, ground exact after p50 ${r.travel.arrivalMsP50} ms, max ${r.travel.arrivalMsMax} ms`);
  console.log(`  main-thread region work ${r.mainThreadRegionMs.total} ms (max ${r.mainThreadRegionMs.max}); generations on the main thread ${r.regionGenerationsOnMainThread.count} (${r.regionGenerationsOnMainThread.totalMs} ms, max ${r.regionGenerationsOnMainThread.maxMs})`);
  console.log(`  per tick: wildlife ${r.lifeMsPerTick.wildlife} ms, villagers ${r.lifeMsPerTick.villagers}, dragons ${r.lifeMsPerTick.dragons}; snapshot round ${r.snapshotMsPerRound} ms; ${r.kbPerClientPerSecond} KB/s per client`);
  console.log(`  creatures ${r.creatures}, villagers ${r.villagers}, regions cached ${r.regionsCached}; heap ${r.memoryMB.heapStart} -> max ${r.memoryMB.heapMax} MB, RSS max ${r.memoryMB.rssMax} MB; save ${r.saveMs} ms (${r.saveKB} KB), load ${r.loadMs} ms`);
}
console.log(`\nReport: ${name}`);
process.exit(0);
