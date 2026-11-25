import { test, expect } from '@playwright/test';
import { ready, canvasStats } from './helpers';

const kindOf = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__lumenwild.getEngine().renderer.kind as string);

test('WebGL2 unavailable: ?presenter=webgl falls back to Canvas 2D and still renders', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : (orig as any).call(this, type, ...rest);
    };
  });
  await ready(page, '?seed=7&presenter=webgl');
  expect(await kindOf(page)).toBe('canvas2d');
  expect(await page.evaluate(() => (window as any).__lumenwild.getEngine().presenterFallback)).toContain('WebGL2');
  await expect(page.getByText(/WebGL2 unavailable, using Canvas 2D/)).toBeVisible();
  const s = await canvasStats(page);
  expect(s.colors).toBeGreaterThan(50);
});

test('switching presenter at runtime keeps the world, camera, simulation and picking', async ({ page }) => {
  await ready(page, '?seed=7');
  expect(await kindOf(page)).toBe('canvas2d');
  const before = await page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine();
    return { x: e.cam.x, y: e.cam.y, zoom: e.cam.zoomIndex, pick: e.pickAt(400, 300), objects: e.objects.objects.size, steps: e.water.stats.steps };
  });
  await page.getByTestId('presenter-select').selectOption('webgl2');
  await page.waitForFunction(() => (window as any).__lumenwild.useUI.getState().stats?.presenter === 'webgl2');
  await expect(page.locator('canvas[data-presenter=webgl2]')).toHaveCount(1);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine();
    return { x: e.cam.x, y: e.cam.y, zoom: e.cam.zoomIndex, pick: e.pickAt(400, 300), objects: e.objects.objects.size, steps: e.water.stats.steps };
  });
  expect(after.zoom).toBe(before.zoom);
  expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
  expect(after.pick).toBe(before.pick);
  expect(after.objects).toBe(before.objects);
  expect(after.steps).toBeGreaterThan(before.steps); // the simulation kept running
  // The GPU canvas shows the world (compositor screenshot; a WebGL canvas cannot be read back with a 2D context).
  const shot = await page.getByTestId('world-canvas').screenshot();
  expect(shot.length).toBeGreaterThan(20_000);
  await page.getByTestId('presenter-select').selectOption('canvas2d');
  await page.waitForFunction(() => (window as any).__lumenwild.useUI.getState().stats?.presenter === 'canvas2d');
  expect((await canvasStats(page)).colors).toBeGreaterThan(50);
});

test('WebGL2 context loss and restore: no errors, rendering resumes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page, '?seed=7&presenter=webgl');
  expect(await kindOf(page)).toBe('webgl2');
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid=world-canvas]') as HTMLCanvasElement;
    (window as any).__ext = (c.getContext('webgl2') as WebGL2RenderingContext).getExtension('WEBGL_lose_context');
    (window as any).__ext.loseContext();
  });
  await page.waitForFunction(() => (window as any).__lumenwild.getEngine().renderer.lost === true);
  const steps0 = await page.evaluate(() => (window as any).__lumenwild.getEngine().water.stats.steps);
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__ext.restoreContext());
  await page.waitForFunction(() => (window as any).__lumenwild.getEngine().renderer.lost === false);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).__lumenwild.getEngine().water.stats.steps)).toBeGreaterThan(steps0);
  const shot = await page.getByTestId('world-canvas').screenshot();
  expect(shot.length).toBeGreaterThan(20_000);
  expect(errors).toEqual([]);
});

test('presenter cost while the camera pans (measured, both presenters)', async ({ page }) => {
  const measure = async (q: string) => {
    await page.goto(`/?seed=7&worker=0&manual=1${q}`);
    await page.waitForFunction(() => { const e = (window as any).__lumenwild?.getEngine(); return !!e?.renderer && e.cam.viewW > 0; });
    return page.evaluate(() => {
      const e = (window as any).__lumenwild.getEngine();
      e.focus(...e.home);
      for (let i = 0; i < 30; i++) e.frame(i * 1000 / 60); // warm-up (atlas bake, texture allocation)
      let present = 0, frame = 0;
      const n = 240;
      for (let i = 30; i < 30 + n; i++) {
        e.cam.x += 0.13; // a pan every frame: the CPU blitter must redraw every cell
        const t0 = performance.now();
        e.frame(i * 1000 / 60);
        frame += performance.now() - t0;
        present += e.renderer.stats.blitMs + e.renderer.stats.putMs;
      }
      return { kind: e.renderer.kind, presentMs: present / n, frameMs: frame / n, cols: e.composer.buf.cols, rows: e.composer.buf.rows, w: e.renderer.canvas.width, h: e.renderer.canvas.height };
    });
  };
  const cpu = await measure('');
  const gpu = await measure('&presenter=webgl');
  console.log(`presenter cost while panning (${cpu.cols}x${cpu.rows} cells, ${cpu.w}x${cpu.h} px): ` +
    `canvas2d present ${cpu.presentMs.toFixed(2)} ms, frame ${cpu.frameMs.toFixed(2)} ms; ` +
    `webgl2 present ${gpu.presentMs.toFixed(2)} ms, frame ${gpu.frameMs.toFixed(2)} ms`);
  expect(cpu.kind).toBe('canvas2d');
  expect(gpu.kind).toBe('webgl2');
  expect(gpu.presentMs).toBeGreaterThan(0);
  expect(cpu.presentMs).toBeGreaterThan(0);
});
