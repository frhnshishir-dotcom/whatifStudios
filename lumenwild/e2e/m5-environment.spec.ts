import { test, expect, type Page } from '@playwright/test';
import { ready, canvasStats } from './helpers';

const particleKinds = (page: Page) => page.evaluate(() => {
  const P = (window as any).__lumenwild.getEngine().particles;
  const k: Record<number, number> = {};
  for (let j = 0; j < P.n; j++) k[P.kind[j]] = (k[P.kind[j]] ?? 0) + 1;
  return k;
});

test('the time slider turns day into night: darker frame, fireflies, lit windows', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.getByTestId('cycle').uncheck();
  await page.getByTestId('time-slider').fill('12');
  await page.waitForTimeout(600);
  const day = await canvasStats(page);
  await page.getByTestId('time-slider').fill('23');
  await expect(page.getByTestId('clock')).toHaveText('23:00');
  await page.waitForTimeout(600);
  const night = await canvasStats(page);
  expect(night.mean).toBeLessThan(day.mean * 0.6);
  // Fireflies gather (kind 3) within a few seconds.
  await expect.poll(async () => (await particleKinds(page))[3] ?? 0, { timeout: 10_000 }).toBeGreaterThan(10);
  // Emissive cells (windows, glowing mushrooms, fireflies) are on screen.
  const emissive = await page.evaluate(() => {
    const b = (window as any).__lumenwild.getEngine().composer.buf;
    let n = 0;
    for (let k = 0; k < b.n; k++) if (b.light[k] > 0) n++;
    return n;
  });
  expect(emissive).toBeGreaterThan(3);
  await expect(page.getByTestId('bottom-clock')).toContainText('23:');
});

test('the day-night cycle advances the clock', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.evaluate(() => (window as any).__lumenwild.getEngine().env.set({ dayLength: 24, time: 8 })); // 1 s per hour
  await page.getByTestId('cycle').check();
  await page.waitForTimeout(2500);
  const h = await page.evaluate(() => (window as any).__lumenwild.getEngine().env.time);
  expect(h).toBeGreaterThan(9.5);
});

test('rain and storm presets: rain streaks fall and the river gets rings', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.locator('[data-weather="storm"]').click();
  await expect.poll(async () => (await particleKinds(page))[4] ?? 0, { timeout: 10_000 }).toBeGreaterThan(80);
  const drawn = await page.evaluate(() => {
    const b = (window as any).__lumenwild.getEngine().composer.buf;
    let n = 0;
    for (let k = 0; k < b.n; k++) if (b.kind[k] === 6) n++;
    return n;
  });
  expect(drawn).toBeGreaterThan(40);
  // Ripple rings show on the river (water cells with ring glyphs).
  await expect.poll(() => page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine(), b = e.composer.buf, rip = e.water.view.ripple;
    let n = 0;
    for (let k = 0; k < b.n; k++) if (b.kind[k] === 3 && Math.abs(rip[b.pick[k]]) > 0.07) n++;
    return n;
  }), { timeout: 10_000 }).toBeGreaterThan(5);
  await page.locator('[data-weather="clear"]').click();
  await expect.poll(async () => (await particleKinds(page))[4] ?? 0, { timeout: 15_000 }).toBeLessThan(20);
});

test('wind bends the grass; fog veils the view', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.getByTestId('wind').fill('1');
  await expect.poll(() => page.evaluate(() => (window as any).__lumenwild.getEngine().atmosphere.stats.swayed), { timeout: 10_000 }).toBeGreaterThan(30);
  await page.getByTestId('wind').fill('0');
  await expect.poll(() => page.evaluate(() => (window as any).__lumenwild.getEngine().atmosphere.stats.swayed), { timeout: 15_000 }).toBe(0);
  const clear = await canvasStats(page);
  await page.getByTestId('fog').fill('0.9');
  await expect.poll(() => page.evaluate(() => (window as any).__lumenwild.getEngine().atmosphere.stats.fogged), { timeout: 15_000 }).toBeGreaterThan(3000);
  const foggy = await canvasStats(page);
  expect(foggy.std).toBeLessThan(clear.std); // a veil flattens contrast
});

test('leaves fall from trees in a breeze', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.locator('[data-weather="breezy"]').click();
  await expect.poll(async () => { const k = await particleKinds(page); return (k[2] ?? 0) + (k[7] ?? 0); }, { timeout: 10_000 }).toBeGreaterThan(5);
});
