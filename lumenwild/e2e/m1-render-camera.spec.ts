import { test, expect } from '@playwright/test';
import { ready, engineState, canvasStats } from './helpers';

test('canvas renders a character landscape', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page);
  const s = await canvasStats(page);
  expect(s.w).toBeGreaterThan(600);
  expect(s.colors).toBeGreaterThan(300); // many coloured glyphs, not a flat fill
  expect(s.std).toBeGreaterThan(8);
  const st = await engineState(page);
  expect(st.cols).toBeGreaterThan(100); // ~120 x 60 characters at the default zoom
  expect(errors).toEqual([]);
});

test('mouse wheel zooms and middle-drag pans', async ({ page }) => {
  await ready(page);
  const canvas = page.getByTestId('world-canvas');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const before = await engineState(page);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await engineState(page)).cellW).toBeGreaterThan(before.cellW);
  const z = await engineState(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx - 200, cy - 120, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const after = await engineState(page);
  expect(after.camX).toBeGreaterThan(z.camX + 5);
  expect(after.camY).toBeGreaterThan(z.camY + 2);
});

test('hover shows cell details and Space toggles pause', async ({ page }) => {
  await ready(page);
  const box = (await page.getByTestId('world-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await expect(page.getByTestId('hover-info')).toContainText('Elevation');
  const s0 = await engineState(page);
  expect(s0.paused).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await engineState(page)).paused).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await engineState(page)).paused).toBe(false);
});

test('responsive: narrow screens keep the canvas and drop the inspector', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 700 });
  await ready(page);
  await expect(page.locator('.inspector')).toBeHidden();
  const box = (await page.getByTestId('world-canvas').boundingBox())!;
  expect(box.width).toBeGreaterThan(700);
  await page.keyboard.press('h');
  await expect(page.locator('.toolbar')).toHaveCount(0);
  const full = (await page.getByTestId('world-canvas').boundingBox())!;
  expect(full.width).toBeGreaterThanOrEqual(819);
});
