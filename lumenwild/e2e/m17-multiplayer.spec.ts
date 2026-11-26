import { test, expect, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';

/**
 * Two independent browser clients (separate contexts: separate storage, tokens, engines) play in one world served by
 * the local authoritative server process. Each sees the other walk; both see the same dragons; an edit by one reaches
 * the other; a reload resumes the same player.
 */
const PORT = 8798;
let server: ChildProcess;

test.beforeAll(async () => {
  execSync('npm run server:build', { stdio: 'ignore' });
  server = spawn(process.execPath, ['dist-server/main.js', '--port', String(PORT), '--data', 'none'], { stdio: 'ignore' });
  for (let k = 0; k < 100; k++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('server did not start');
});
test.afterAll(() => { server?.kill('SIGTERM'); });

const open = async (page: Page, name: string) => {
  await page.goto(`/?scene=continent&server=ws://127.0.0.1:${PORT}&name=${name}`);
  await page.waitForFunction(() => !!(window as any).__lumenwild?.getEngine()?.streamer?.life?.net?.connected, null, { timeout: 90_000 });
};
const me = (page: Page) => page.evaluate(() => { const lw = (window as any).__lumenwild.getEngine().streamer.life; return { id: lw.net.id, x: lw.player.x, y: lw.player.y, others: [...lw.sim.players.values()].filter((p: any) => p.id !== 'local').map((p: any) => ({ id: p.id, x: p.x, y: p.y })), dragons: lw.sim.dragons.dragons.map((d: any) => [d.id, Math.round(d.x), Math.round(d.y)] as [string, number, number]), creatures: lw.sim.wildlife.creatures.size, snaps: lw.net.stats.snaps }; });

test('two browser clients share one server world', async ({ browser }) => {
  test.setTimeout(240_000);
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const errors: string[] = [];
  for (const p of [a, b]) p.on('pageerror', (e) => errors.push(String(e)));
  await open(a, 'Ada'); await open(b, 'Bram');
  const A0 = await me(a), B0 = await me(b);
  expect(A0.id).not.toBe(B0.id);
  // Both start in Lumenfall: its villagers are on both screens, placed by the server.
  for (const p of [a, b]) await expect.poll(() => p.evaluate(() => (window as any).__lumenwild.getEngine().streamer.life.net.stats.villagers), { timeout: 10_000 }).toBeGreaterThan(10);
  // Ada walks east for a few seconds; Bram sees her move.
  await a.evaluate(() => { (window as any).__lumenwild.getEngine().streamer.life.input = { dx: 1, dy: 0, run: false }; });
  await a.waitForTimeout(3000);
  await a.evaluate(() => { (window as any).__lumenwild.getEngine().streamer.life.input = { dx: 0, dy: 0, run: false }; });
  const A1 = await me(a);
  expect(A1.x - A0.x).toBeGreaterThan(5);
  await expect.poll(async () => { const B = await me(b); const ada = B.others.find((o) => o.id === A1.id); return ada ? Math.abs(ada.x - A1.x) : 1e9; }, { timeout: 10_000 }).toBeLessThan(1.5);
  // The same dragons (positions from the same server; snapshots may be one tick apart).
  const [Da, Db]: Array<Array<[string, number, number]>> = [(await me(a)).dragons, (await me(b)).dragons];
  expect(Da.map((d) => d[0])).toEqual(Db.map((d) => d[0]));
  for (let k = 0; k < Da.length; k++) expect(Math.hypot(Da[k][1] - Db[k][1], Da[k][2] - Db[k][2])).toBeLessThan(60);
  // An edit by Ada (paving a few cells) reaches Bram's world.
  const cell = await a.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine(), s = e.streamer, lw = s.life, [wx, wy] = s.win.toWindow(lw.player.x + 4, lw.player.y + 4);
    const i = Math.floor(wy) * s.win.W + Math.floor(wx);
    e.world.mat[i] = 15; // scree: unmistakable
    return { cx: lw.player.x + 4, cy: lw.player.y + 4 };
  });
  await expect.poll(async () => b.evaluate(({ cx, cy }) => {
    const e = (window as any).__lumenwild.getEngine(), s = e.streamer, [wx, wy] = s.win.toWindow(cx, cy);
    return e.world.mat[Math.floor(wy) * s.win.W + Math.floor(wx)];
  }, cell), { timeout: 20_000 }).toBe(15);
  // Bram reloads: the same player comes back (token in his browser).
  await b.reload();
  await b.waitForFunction(() => !!(window as any).__lumenwild?.getEngine()?.streamer?.life?.net?.connected, null, { timeout: 90_000 });
  expect((await me(b)).id).toBe(B0.id);
  console.log(`multiplayer: ${A1.others.length + 1} players; Ada walked ${(A1.x - A0.x).toFixed(1)} m; Ada snapshots ${A1.snaps}; creatures from the server ${A1.creatures}`);
  expect(errors).toEqual([]);
  await ca.close(); await cb.close();
});
