import { test, expect, type Page } from '@playwright/test';
import { ready } from './helpers';

const dragon = (page: Page) => page.evaluate(() => {
  const e = (window as any).__lumenwild.getEngine(), d = e.dragon.e, L = e.dragonLayer;
  return { x: d.x, y: d.y, z: d.z, state: d.state, flap: d.flap, frame: L.stats.frame, cells: L.stats.cells, shadow: L.stats.shadow, name: d.name, heading: d.heading };
});

/** CSS position of a cell drawn by the dragon (its body), or null. */
const dragonCell = (page: Page) => page.evaluate(() => {
  const e = (window as any).__lumenwild.getEngine(), b = e.composer.buf, cam = e.cam, c = e.renderer.canvas, r = c.getBoundingClientRect(), s = r.width / c.width;
  const ox = (cam.x - Math.floor(cam.x)) * cam.cellW, oy = (cam.y - Math.floor(cam.y)) * cam.cellH;
  const cells: number[] = [];
  for (let k = 0; k < b.n; k++) if (b.kind[k] === 7) cells.push(k);
  if (!cells.length) return null;
  const k = cells[Math.floor(cells.length / 2)], col = k % b.cols, row = Math.floor(k / b.cols);
  return [r.left + ((col + 0.5) * cam.cellW - ox) * s, r.top + ((row + 0.5) * cam.cellH - oy) * s];
});

test('a dragon lives in the world: drawn with a shadow, moving, wings beating, no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page, '?seed=7');
  await page.evaluate(() => { (window as any).__lumenwild.getEngine().dragon.follow = true; });
  await expect.poll(async () => (await dragon(page)).cells, { timeout: 10_000 }).toBeGreaterThan(80);
  const a = await dragon(page);
  expect(a.shadow).toBeGreaterThan(10);
  const frames = new Set<number>();
  for (let k = 0; k < 10; k++) { frames.add((await dragon(page)).frame); await page.waitForTimeout(120); }
  const b = await dragon(page);
  expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(2); // it flies on its own
  if (b.state !== 'GLIDING') expect(frames.size).toBeGreaterThan(2); // wing frames change while flapping
  expect(errors).toEqual([]);
});

test('clicking the dragon opens its panel; follow, pause and autonomy controls work', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); e.dragon.follow = true; e.env.set({ time: 13, cycle: false }); e.env.settle(); });
  await page.waitForTimeout(1500);
  const pos = (await dragonCell(page))!;
  await page.mouse.click(pos[0], pos[1]);
  const panel = page.getByTestId('dragon-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText((await dragon(page)).name);
  await expect(page.getByTestId('dragon-alt')).toContainText(' m');
  // Pause freezes it.
  await page.getByTestId('dragon-pause').click();
  const p0 = await dragon(page);
  await page.waitForTimeout(700);
  const p1 = await dragon(page);
  expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeLessThan(0.01);
  await page.getByTestId('dragon-pause').click();
  // Holding: it circles where it is instead of travelling.
  await page.getByTestId('dragon-auto').click();
  await expect.poll(async () => (await dragon(page)).state, { timeout: 8_000 }).toMatch(/CIRCLING|RESTING|IDLE|SLEEPING|DRINKING|WALKING|TAKING_OFF|DESCENDING|LANDING/);
  await page.getByTestId('dragon-auto').click();
  // Follow off: the camera stays put.
  await page.getByTestId('dragon-follow').click();
  const c0 = await page.evaluate(() => (window as any).__lumenwild.getEngine().cam.x);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).__lumenwild.getEngine().cam.x)).toBeCloseTo(c0, 5);
});

test('investigate: the dragon flies to a clicked place', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); e.dragon.follow = false; e.setSpeed(4); });
  await page.getByTestId('open-dragon').click();
  await page.getByTestId('dragon-investigate').click();
  const box = (await page.getByTestId('world-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
  const target = await page.evaluate(() => { const d = (window as any).__lumenwild.getEngine().dragon.e; return d.disturbance ? [d.disturbance.x, d.disturbance.y] : null; });
  expect(target).not.toBeNull();
  await expect.poll(async () => { const d = await dragon(page); return Math.hypot(d.x - target![0], d.y - target![1]); }, { timeout: 25_000 }).toBeLessThan(25);
});

test('the dragon survives saving and loading the world', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.evaluate(() => { (window as any).__lumenwild.getEngine().setSpeed(4); });
  await page.waitForTimeout(3000);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  const saved = await page.evaluate(() => { const d = (window as any).__lumenwild.getEngine().snapshot().dragon; return { x: d.x, y: d.y, name: d.name, landmarks: d.memory.landmarks.length, energy: d.needs.energy }; });
  // Move the dragon far away, then load the slot.
  await page.evaluate(() => { const d = (window as any).__lumenwild.getEngine().dragon; d.reset([30, 220]); });
  await page.getByTestId('open-worlds').click();
  const load = page.getByTestId('load-slot').first();
  await load.click();
  // A second click confirms when there were unsaved changes; otherwise the dialog has already closed.
  if ((await page.getByTestId('world-dialog').count()) && (await load.textContent())?.includes('Discard')) await load.click();
  await expect(page.getByTestId('world-dialog')).toHaveCount(0);
  const back = await page.evaluate(() => { const d = (window as any).__lumenwild.getEngine().dragon.e; return { x: d.x, y: d.y, name: d.name, landmarks: d.memory.landmarks.length, energy: d.needs.energy }; });
  expect(back.name).toBe(saved.name);
  expect(Math.hypot(back.x - saved.x, back.y - saved.y)).toBeLessThan(3);
  expect(back.landmarks).toBe(saved.landmarks);
  expect(Math.abs(back.energy - saved.energy)).toBeLessThan(0.05);
});
