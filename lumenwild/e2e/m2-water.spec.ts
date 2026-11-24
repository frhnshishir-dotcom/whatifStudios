import { test, expect, type Page } from '@playwright/test';
import { ready } from './helpers';

const PX = 128 + 14 * Math.sin(70 / 22); // pond centre x in the water test scene

const probe = (page: Page) => page.evaluate(() => {
  const e = (window as any).__lumenwild.getEngine();
  const v = e.water.view;
  let moving = 0, falls = 0;
  for (let i = 0; i < v.n; i++) {
    if (v.depth[i] > 0.02 && Math.hypot(v.velX[i], v.velY[i]) > 0.3) moving++;
    if (v.fall[i] > 0.1) falls++;
  }
  return { moving, falls, particles: e.particles.n, total: e.water.stats.total, steps: e.water.stats.steps, mode: e.water.mode };
});

/** Client coordinates of the screen cell showing world cell (x, y) as water (or terrain), or null. */
const screenOf = (page: Page, x: number, y: number) => page.evaluate(([wx, wy]) => {
  const e = (window as any).__lumenwild.getEngine();
  const b = e.composer.buf, target = wy * e.world.w + wx;
  for (let o = 0; o < b.n; o++) {
    if (b.pick[o] !== target || (b.kind[o] !== 3 && b.kind[o] !== 1)) continue;
    const c = o % b.cols, r = Math.floor(o / b.cols);
    const cv = e.renderer.canvas as HTMLCanvasElement, rect = cv.getBoundingClientRect();
    const sx = rect.width / cv.width, sy = rect.height / cv.height;
    const ox = (e.cam.x - Math.floor(e.cam.x)) * e.cam.cellW, oy = (e.cam.y - Math.floor(e.cam.y)) * e.cam.cellH;
    return { x: rect.left + (c * e.cam.cellW - ox + e.cam.cellW / 2) * sx, y: rect.top + (r * e.cam.cellH - oy + e.cam.cellH / 2) * sy };
  }
  return null;
}, [x, y]);

const rippleNear = (page: Page, x: number, y: number, r0: number, r1: number) => page.evaluate(([cx, cy, a, b]) => {
  const e = (window as any).__lumenwild.getEngine();
  const v = e.water.view, rip = v.ripple, w = e.world.w;
  let s = 0;
  for (let yy = cy - b; yy <= cy + b; yy++) for (let xx = cx - b; xx <= cx + b; xx++) {
    const d = Math.hypot(xx - cx, yy - cy);
    if (d >= a && d <= b) s += Math.abs(rip[yy * w + xx]);
  }
  return s;
}, [x, y, r0, r1]);

test('water flows through the channel and the waterfall cascades with splashes', async ({ page }) => {
  await ready(page, '?scene=watertest');
  await expect.poll(async () => (await probe(page)).falls, { timeout: 40_000 }).toBeGreaterThan(0);
  const p = await probe(page);
  expect(p.mode).toBe('worker');
  expect(p.moving).toBeGreaterThan(40);
  await expect.poll(async () => (await probe(page)).particles, { timeout: 10_000 }).toBeGreaterThan(0);
  // Rendered: the canvas shows water and waterfall cells (kinds 3 and 4) once the camera looks at the cliff.
  await page.evaluate((px) => { const e = (window as any).__lumenwild.getEngine(); e.cam.centerOn(px, 72, 256, 256); }, PX);
  await expect.poll(() => page.evaluate(() => { const b = (window as any).__lumenwild.getEngine().composer.buf; let w = 0, f = 0; for (let o = 0; o < b.n; o++) { if (b.kind[o] === 3) w++; if (b.kind[o] === 4) f++; } return Math.min(w, f * 100); }), { timeout: 10_000 }).toBeGreaterThan(50);
});

test('clicking a pond with the ripple tool makes expanding ripples; two clicks combine', async ({ page }) => {
  await ready(page, '?scene=watertest');
  await page.evaluate((px) => { const e = (window as any).__lumenwild.getEngine(); e.cam.centerOn(px, 86, 256, 256); }, PX);
  await page.locator('[data-tool=ripple]').click();
  await page.waitForTimeout(300);
  const x = Math.round(PX) - 2, y = 85;
  const at = await screenOf(page, x, y);
  expect(at).not.toBeNull();
  const quiet = await rippleNear(page, x, y, 4, 7);
  await page.mouse.click(at!.x, at!.y);
  // The disturbance spreads: energy appears in a ring 4..7 cells away a moment later.
  await expect.poll(() => rippleNear(page, x, y, 4, 7), { timeout: 5_000 }).toBeGreaterThan(quiet + 0.3);
  const at2 = await screenOf(page, x + 5, y + 4);
  await page.mouse.click(at2!.x, at2!.y);
  await expect.poll(() => rippleNear(page, x + 5, y + 4, 0, 3), { timeout: 5_000 }).toBeGreaterThan(0.2);
});

test('main-thread fallback simulates water without a worker', async ({ page }) => {
  await ready(page, '?scene=watertest&worker=0');
  const p0 = await probe(page);
  expect(p0.mode).toBe('main');
  await expect.poll(async () => (await probe(page)).steps, { timeout: 10_000 }).toBeGreaterThan(p0.steps + 60);
  expect((await probe(page)).falls).toBeGreaterThan(0);
});
