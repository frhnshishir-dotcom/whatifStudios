// Continent browser benchmark (reproducible): `npm run bench:continent [-- --headed --presenter webgl2 --no-build]`
//
// Builds the app, serves it with Vite's preview server (with the isolation headers), opens the continent in
// Chromium (Playwright) and runs fixed scenarios at Lumenfall. On the target laptop use --headed so the real GPU
// and display are used; headless Chromium may fall back to software rendering.
//   village        Lumenfall at 11:00, default zoom
//   village-wide   the same, zoomed out (about twice the cells)
//   night-storm    23:00, rain, fog and wind
//   travel         travelling east at 30 m/s for 25 s (crosses several region edges)
//   dragons        all five dragons on screen (time stopped; wings keep beating)
// Per scenario: fps, frame interval p50/p95/max, CPU frame p50/p95 (simulation + compose + present), compose,
// present, living-world frame, the largest layers, JS heap, window moves and the slowest one. JSON report in
// bench-results/.
import { build, preview } from 'vite';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const has = (k) => process.argv.includes(`--${k}`);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 4190)), PRESENTER = arg('presenter', 'canvas2d'), HEADED = has('headed');

if (!has('no-build')) { console.log('Building the app…'); await build({ root, logLevel: 'warn' }); }
const server = await preview({ root, logLevel: 'warn', preview: { port: PORT, strictPort: true, host: '127.0.0.1' } });
const browser = await chromium.launch({ headless: !HEADED, args: ['--enable-precise-memory-info', ...(HEADED ? [] : ['--enable-unsafe-swiftshader'])] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?scene=continent${PRESENTER === 'webgl2' ? '&presenter=webgl2' : ''}`);
await page.waitForFunction(() => window.__lumenwild?.getEngine()?.streamer?.life?.sim.villages.people.size > 0, null, { timeout: 180000 });
const startupS = (Date.now() - t0) / 1000;
const gpu = await page.evaluate(() => { try { const c = document.createElement('canvas').getContext('webgl'); const d = c?.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch { return 'unknown'; } });
await page.evaluate(() => {
  const e = window.__lumenwild.getEngine();
  window.__bench = { on: false, s: [], prof: {} };
  e.composer.profile = new Map();
  const tick = () => {
    const B = window.__bench;
    if (B.on) {
      const lf = e.lastFrame, lw = e.streamer.life;
      B.s.push([performance.now(), lf.cpuMs, lf.composeMs, lf.presentMs, lw.stats.frameMs]);
      for (const [k, v] of e.composer.profile) B.prof[k] = (B.prof[k] ?? 0) + v;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const q = (a, f) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * f))] * 100) / 100; };
const heap = () => page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));

async function measure(name, secs, setup) {
  await page.evaluate(setup);
  await page.waitForTimeout(1500);
  const heap0 = await heap();
  await page.evaluate(() => { const B = window.__bench; B.s = []; B.prof = {}; B.on = true; });
  await page.waitForTimeout(secs * 1000);
  const r = await page.evaluate(() => {
    const B = window.__bench; B.on = false;
    const e = window.__lumenwild.getEngine(), s = e.streamer;
    return { s: B.s, prof: B.prof, cells: e.composer.buf.cols * e.composer.buf.rows, moves: s.stats.shifts, maxMove: s.stats.maxShiftMs, regions: s.cache.size, objects: e.objects.objects.size, creatures: s.life.sim.wildlife.creatures.size, puppets: s.life.stats.puppets };
  });
  const S = r.s, n = S.length, dt = S.slice(1).map((x, k) => x[0] - S[k][0]);
  const layers = Object.fromEntries(Object.entries(r.prof).map(([k, v]) => [k, Math.round((v / n) * 100) / 100]).sort((a, b) => b[1] - a[1]).slice(0, 6));
  return {
    scenario: name, frames: n, fps: Math.round((1000 / (dt.reduce((a, c) => a + c, 0) / Math.max(1, dt.length))) * 10) / 10,
    frameMs: { p50: q(dt, 0.5), p95: q(dt, 0.95), max: q(dt, 1) }, cpuMs: { p50: q(S.map((x) => x[1]), 0.5), p95: q(S.map((x) => x[1]), 0.95) },
    composeMs: q(S.map((x) => x[2]), 0.5), presentMs: q(S.map((x) => x[3]), 0.5), lifeMs: { p50: q(S.map((x) => x[4]), 0.5), p95: q(S.map((x) => x[4]), 0.95) },
    layersMs: layers, heapMB: { start: heap0, end: await heap() }, cells: r.cells, windowMoves: r.moves, slowestMoveMs: Math.round(r.maxMove * 10) / 10,
    regionsCached: r.regions, objects: r.objects, creatures: r.creatures, dragonPuppets: r.puppets,
  };
}

const results = [];
results.push(await measure('village', 8, () => { const e = window.__lumenwild.getEngine(); e.env.set({ time: 11, rain: 0, fog: 0, wind: 0.3 }); e.env.settle(); }));
results.push(await measure('village-wide', 8, () => { const e = window.__lumenwild.getEngine(), r = e.renderer.canvas.getBoundingClientRect(); e.cam.zoomIndex = 1; e.resize(r.width, r.height, 1); }));
results.push(await measure('night-storm', 8, () => { const e = window.__lumenwild.getEngine(), r = e.renderer.canvas.getBoundingClientRect(); e.cam.zoomIndex = 4; e.resize(r.width, r.height, 1); e.env.set({ time: 23, rain: 1, fog: 0.25, wind: 0.95 }); }));
results.push(await measure('travel', 25, () => { const e = window.__lumenwild.getEngine(), s = e.streamer; e.env.set({ time: 11, rain: 0, fog: 0, wind: 0.3 }); const v = s.bp.data.settlements.find((x) => x.id !== 'lumenfall'); s.startTravel(e, v.at, 30, v.name); }));
results.push(await measure('dragons', 8, () => {
  const e = window.__lumenwild.getEngine(), s = e.streamer, lw = s.life, pl = lw.player;
  s.stopTravel(); e.setPaused(true); lw.follow = null;
  lw.sim.dragons.dragons.forEach((d, k) => { d.x = pl.x + (k - 2) * 30; d.y = pl.y + 60; d.alt = 14; d.st = 'patrol'; d.h = 0.2 + k * 0.35; d.z = lw.q.height(d.x, d.y) + 14; });
  const [wx, wy] = s.win.toWindow(pl.x, pl.y + 60), W = s.win.W;
  e.cam.centerOn(wx, wy, W, W, e.world.elevAt(Math.round(wx), Math.round(wy)) + 14);
}));
await browser.close();
await new Promise((r) => server.httpServer.close(r));

const report = { kind: 'lumenwild-continent-benchmark', version: 1, at: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, headed: HEADED, presenter: PRESENTER, gpu, startupS, errors, results };
mkdirSync(join(root, 'bench-results'), { recursive: true });
const name = join(root, 'bench-results', `continent-${report.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(name, JSON.stringify(report, null, 2));
console.log(`\nContinent benchmark (${HEADED ? 'headed' : 'headless'}, ${PRESENTER}, GPU: ${gpu}); startup ${startupS.toFixed(1)} s`);
for (const r of results) console.log(`  ${r.scenario.padEnd(12)} ${String(r.fps).padStart(5)} fps · frame p95 ${r.frameMs.p95} max ${r.frameMs.max} ms · CPU p50 ${r.cpuMs.p50} p95 ${r.cpuMs.p95} ms · compose ${r.composeMs} · present ${r.presentMs} · life ${r.lifeMs.p50}/${r.lifeMs.p95} · heap ${r.heapMB.start}->${r.heapMB.end} MB · moves ${r.windowMoves} (slowest ${r.slowestMoveMs} ms)`);
if (errors.length) console.log('Page errors:', errors);
console.log(`Report: ${name}`);
process.exit(errors.length ? 1 : 0);
