import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ready } from './helpers';

test('benchmark: runs every scenario on both presenters, restores the view, exports a report', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page, '?seed=7&benchframes=40');
  const state = () => page.evaluate(() => {
    const L = (window as any).__lumenwild, e = L.getEngine();
    return { x: e.cam.x, y: e.cam.y, zoom: e.cam.zoomIndex, rain: e.env.target.rain, cycle: e.env.target.cycle,
      presenter: e.renderer.kind, setting: L.useUI.getState().settings.presenter, profile: e.composer.profile, onFrame: e.onFrame };
  });
  const before = await state();
  await page.getByTestId('bench-run').click();
  await expect(page.getByTestId('bench-progress')).toBeVisible();
  await expect(page.getByTestId('bench-result')).toBeVisible({ timeout: 100_000 });
  const r = await page.evaluate(() => (window as any).__lumenwild.lastBenchmark);

  expect(r.format).toBe('lumenwild-benchmark');
  expect(r.capabilities.webgl2).toBe(true);
  expect(r.capabilities.webgl2Problem).toBeNull();
  expect(typeof r.capabilities.gpuRenderer).toBe('string');
  expect(r.capabilities.maxTextureSize).toBeGreaterThanOrEqual(2048);
  expect(r.results).toHaveLength(8);
  for (const kind of ['canvas2d', 'webgl2']) {
    for (const sc of ['day', 'night-storm', 'zoomed-out-storm', 'pan']) {
      const x = r.results.find((q: any) => q.presenter === kind && q.scenario === sc);
      expect(x, `${kind}/${sc}`).toBeTruthy();
      expect(x.frames).toBe(40);
      expect(x.fps).toBeGreaterThan(0);
      expect(x.frameMs.p95).toBeGreaterThan(0);
      expect(Object.keys(x.layers)).toEqual(expect.arrayContaining(['terrain', 'water', 'objects', 'particles', 'atmosphere', 'overlay']));
    }
  }
  // Zoomed out shows more cells than the default view.
  const day = r.results.find((q: any) => q.presenter === 'canvas2d' && q.scenario === 'day');
  const far = r.results.find((q: any) => q.presenter === 'canvas2d' && q.scenario === 'zoomed-out-storm');
  expect(far.cols * far.rows).toBeGreaterThan(day.cols * day.rows);
  expect(r.budgets.map((b: any) => b.presenter)).toEqual(['canvas2d', 'webgl2']);
  console.log(r.results.map((q: any) => `${q.presenter}/${q.scenario}: ${q.fps} fps, p95 ${q.frameMs.p95} ms, cpu ${q.cpuMs.mean} ms (compose ${q.composeMs}, present ${q.presentMs})`).join('\n'));

  // The user's view is back as it was, and nothing is left hooked into the engine.
  const after = await state();
  expect(after.zoom).toBe(before.zoom);
  expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
  expect(after.rain).toBe(before.rain);
  expect(after.cycle).toBe(before.cycle);
  expect(after.presenter).toBe('canvas2d');
  expect(after.setting).toBe('canvas2d');
  expect(after.profile).toBeNull();
  expect(after.onFrame).toBeNull();

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('bench-download').click()]);
  expect(dl.suggestedFilename()).toMatch(/^lumenwild-benchmark-\d{12}\.json$/);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.results).toHaveLength(8);
  expect(errors).toEqual([]);
});
