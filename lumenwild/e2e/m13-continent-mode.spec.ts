import { test, expect } from '@playwright/test';
import { canvasStats } from './helpers';

const SHOTS = process.env.WORLD_SHOTS;

test('continent mode: starts at Lumenfall, streams while travelling, and the valley is one click away', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?scene=continent');
  await page.waitForFunction(() => !!(window as any).__lumenwild?.useUI.getState().stats, null, { timeout: 90_000 });
  await expect(page.getByTestId('continent-panel')).toBeVisible();
  await expect(page.getByTestId('continent-where')).toContainText('Lumenfall Village');
  await expect(page.getByTestId('continent-where')).toContainText('Heartlands');
  const s0 = await canvasStats(page);
  expect(s0.colors).toBeGreaterThan(40);
  if (SHOTS) await page.getByTestId('world-canvas').screenshot({ path: `${SHOTS}/continent-start.png` });
  // Saving is off in continent mode (valley slots stay untouched).
  await page.getByTestId('quick-save').click();
  await expect(page.getByText(/does not save yet/)).toBeVisible();

  // Travel toward Greenhaven at the fast test speed and watch the window move.
  await page.getByTestId('travel-dest').selectOption('greenhaven');
  await page.getByTestId('travel-speed').selectOption('300');
  await page.getByTestId('travel-go').click();
  await expect(page.getByTestId('travel-progress')).toBeVisible();
  await page.waitForFunction(() => (window as any).__lumenwild.getEngine().streamer.stats.shifts >= 4, null, { timeout: 90_000 });
  const m = await page.evaluate(() => {
    const L = (window as any).__lumenwild, e = L.getEngine(), st = L.useUI.getState().stats, s = e.streamer;
    return { shifts: s.stats.shifts, maxShiftMs: s.stats.maxShiftMs, fps: st.fps, compose: st.composeMs, sim: st.simMs, mode: st.simMode, gen: s.cache.stats.maxMs, received: s.cache.stats.received, w: e.world.w };
  });
  console.log(`continent (this machine, SwiftShader): ${m.shifts} window moves, slowest ${m.maxShiftMs.toFixed(0)} ms; fps ${m.fps.toFixed(0)}, compose ${m.compose.toFixed(1)} ms, water ${m.sim.toFixed(1)} ms (${m.mode}); regions from the worker ${m.received}, slowest ${m.gen.toFixed(0)} ms`);
  expect(m.w).toBe(768);
  expect(m.received).toBeGreaterThan(0); // generation ran in the worker
  const s1 = await canvasStats(page);
  expect(s1.colors).toBeGreaterThan(40);
  if (SHOTS) await page.getByTestId('world-canvas').screenshot({ path: `${SHOTS}/continent-travel.png` });
  await page.getByTestId('travel-stop').click();
  expect(errors).toEqual([]);

  // Back to the valley: the sandbox world, unchanged.
  await page.getByTestId('mode-switch').click();
  await page.waitForURL((u) => !u.search.includes('continent'));
  await page.waitForFunction(() => !!(window as any).__lumenwild?.useUI.getState().stats, null, { timeout: 60_000 });
  const v = await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); return { w: e.world.w, streamer: e.streamer, dragon: !!e.dragon }; });
  expect(v).toEqual({ w: 256, streamer: null, dragon: true });
});
