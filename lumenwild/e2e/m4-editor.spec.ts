import { test, expect, type Page } from '@playwright/test';
import { ready } from './helpers';

/** CSS position of a world cell's visible top surface (terrain or water), or null if it isn't on screen. */
const screenOf = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => {
  const e = (window as any).__lumenwild.getEngine(), b = e.composer.buf, cam = e.cam;
  const target = y * e.world.w + x;
  // Prefer the ground or water surface; fall back to whatever stands on the cell (a tree trunk, a building).
  let best = -1;
  for (let k = 0; k < b.n; k++) {
    if (b.pick[k] !== target || b.kind[k] === 6) continue;
    if (b.kind[k] === 1 || b.kind[k] === 3) { best = k; break; }
    if (best < 0) best = k;
  }
  for (let k = best; k >= 0; k = -1) {
    const col = k % b.cols, row = Math.floor(k / b.cols);
    const ox = (cam.x - Math.floor(cam.x)) * cam.cellW, oy = (cam.y - Math.floor(cam.y)) * cam.cellH;
    const c = e.renderer.canvas as HTMLCanvasElement, r = c.getBoundingClientRect();
    const s = r.width / c.width;
    return [r.left + ((col + 0.5) * cam.cellW - ox) * s, r.top + ((row + 0.5) * cam.cellH - oy) * s];
  }
  return null;
}, [x, y]);

/** A dry, flat, empty grass/meadow cell well away from water and objects; the view is focused on it. */
const findDrySpot = (page: Page) => page.evaluate(() => {
  const e = (window as any).__lumenwild.getEngine(), w = e.world, d = e.water.view.depth, occ = e.objects.occ;
  for (let y = 60; y < w.h - 40; y += 3) for (let x = 40; x < w.w - 40; x += 3) {
    let ok = true;
    for (let yy = y - 6; yy <= y + 6 && ok; yy++) for (let xx = x - 6; xx <= x + 6 && ok; xx++) {
      const i = yy * w.w + xx;
      if (d[i] > 0.01 || occ[i] || Math.abs(w.elev[i] - w.elev[y * w.w + x]) > 1.2 || (w.mat[i] !== 0 && w.mat[i] !== 1)) ok = false;
    }
    if (ok) { e.focus(x, y); return [x, y]; }
  }
  return null;
});

const objCount = (page: Page, kind?: string) => page.evaluate((k) => (window as any).__lumenwild.getEngine().objects.count(k), kind);
const elevAt = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => (window as any).__lumenwild.getEngine().world.elev[y * 256 + x], [x, y]);

test('all 18 tools are enabled and selectable by button and hotkey', async ({ page }) => {
  await ready(page, '?seed=7');
  const buttons = page.locator('[data-tool]');
  await expect(buttons).toHaveCount(18);
  for (const id of await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')))) {
    await page.locator(`[data-tool="${id}"]`).click();
    await expect(page.locator(`[data-tool="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as any).__lumenwild.getEngine().tool)).toBe(id);
  }
  await page.keyboard.press('2');
  await expect(page.getByTestId('tool-panel')).toContainText('Raise terrain');
  await page.keyboard.press('t');
  await expect(page.getByTestId('tool-panel')).toContainText('Tree');
  // [ and ] resize the brush.
  const before = Number(await page.getByTestId('brush-size').inputValue());
  await page.keyboard.press(']');
  await expect(page.getByTestId('brush-size')).toHaveValue(String(before + 1));
});

test('raise with a held click, then Ctrl+Z and Ctrl+Y', async ({ page }) => {
  await ready(page, '?seed=7');
  const [x, y] = (await findDrySpot(page))!;
  await page.waitForTimeout(300);
  const e0 = await elevAt(page, x, y);
  const pos = (await screenOf(page, x, y))!;
  await page.keyboard.press('2');
  await page.mouse.move(pos[0], pos[1]);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const e1 = await elevAt(page, x, y);
  expect(e1).toBeGreaterThan(e0 + 0.5);
  await expect(page.getByTestId('undo')).toBeEnabled();
  await page.keyboard.press('Control+z');
  await expect.poll(() => elevAt(page, x, y)).toBe(e0);
  await expect(page.getByTestId('redo')).toBeEnabled();
  await page.keyboard.press('Control+y');
  await expect.poll(() => elevAt(page, x, y)).toBe(e1);
});

test('place a cottage, select it, delete it with the Delete key, undo brings it back', async ({ page }) => {
  await ready(page, '?seed=7');
  const [x, y] = (await findDrySpot(page))!;
  await page.waitForTimeout(300);
  const n0 = await objCount(page, 'cottage');
  await page.keyboard.press('c');
  let pos = (await screenOf(page, x, y))!;
  await page.mouse.click(pos[0], pos[1]);
  await expect.poll(() => objCount(page, 'cottage')).toBe(n0 + 1);
  // Select it: click on its wall (an object cell whose ground cell is in the footprint).
  await page.keyboard.press('v');
  await page.waitForTimeout(200);
  pos = (await page.evaluate(([x, y]) => {
    const e = (window as any).__lumenwild.getEngine(), b = e.composer.buf, cam = e.cam, W = e.world.w;
    const id = e.objects.occ[y * W + x];
    for (let k = 0; k < b.n; k++) {
      if (b.kind[k] !== 5 || e.objects.occ[b.pick[k]] !== id) continue;
      const col = k % b.cols, row = Math.floor(k / b.cols), c = e.renderer.canvas, r = c.getBoundingClientRect(), s = r.width / c.width;
      return [r.left + ((col + 0.5) * cam.cellW - (cam.x - Math.floor(cam.x)) * cam.cellW) * s, r.top + ((row + 0.5) * cam.cellH - (cam.y - Math.floor(cam.y)) * cam.cellH) * s];
    }
    return null;
  }, [x, y]))!;
  await page.mouse.click(pos[0], pos[1]);
  await expect(page.getByTestId('selection-panel')).toContainText('Cottage');
  await page.keyboard.press('Delete');
  await expect.poll(() => objCount(page, 'cottage')).toBe(n0);
  await expect(page.getByTestId('selection-panel')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect.poll(() => objCount(page, 'cottage')).toBe(n0 + 1);
});

test('blocked placement explains why', async ({ page }) => {
  await ready(page, '?seed=7');
  // Click the cottage tool onto the river: needs dry ground.
  const spot = await page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine(), br = e.gen.features.find((f: any) => f.kind === 'bridge');
    const d = e.water.view.depth;
    for (let y = br.y + 8; y < br.y + 30; y++) for (let x = br.x - 6; x <= br.x + 6; x++) if (d[y * 256 + x] > 0.4) { e.focus(x, y); return [x, y]; }
    return null;
  });
  await page.waitForTimeout(300);
  const pos = (await screenOf(page, spot![0], spot![1]))!;
  await page.keyboard.press('c');
  await page.mouse.click(pos[0], pos[1]);
  await expect(page.getByTestId('toast')).toContainText(/dry ground|occupied/);
});

test('scatter trees by dragging, then erase them', async ({ page }) => {
  await ready(page, '?seed=7');
  const [x, y] = (await findDrySpot(page))!;
  await page.waitForTimeout(300);
  const n0 = await objCount(page, 'tree');
  await page.keyboard.press('t');
  const a = (await screenOf(page, x - 5, y))!, b = (await screenOf(page, x + 5, y))!;
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  for (let k = 1; k <= 20; k++) await page.mouse.move(a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20);
  await page.mouse.up();
  const n1 = await objCount(page, 'tree');
  expect(n1).toBeGreaterThan(n0 + 1);
  await page.keyboard.press('e');
  await page.getByTestId('brush-size').fill('8');
  // The camera hasn't moved: erase at the middle of the stroke (the trees now hide the ground cell itself).
  await page.mouse.click((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  await expect.poll(() => objCount(page, 'tree')).toBeLessThanOrEqual(n0);
});

test('water brush pours water and a spring placed with the source tool shows a marker', async ({ page }) => {
  await ready(page, '?seed=7');
  const [x, y] = (await findDrySpot(page))!;
  await page.waitForTimeout(300);
  const pos = (await screenOf(page, x, y))!;
  await page.keyboard.press('4');
  await page.mouse.move(pos[0], pos[1]);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(([x, y]) => (window as any).__lumenwild.getEngine().water.view.depth[y * 256 + x], [x, y])).toBeGreaterThan(0.05);
  await page.keyboard.press('5');
  const p2 = (await screenOf(page, x + 8, y))!;
  await page.mouse.click(p2[0], p2[1]);
  await expect.poll(() => page.evaluate(() => (window as any).__lumenwild.getEngine().editor.sources.size)).toBe(2);
  await expect.poll(() => page.evaluate(() => {
    const b = (window as any).__lumenwild.getEngine().composer.buf;
    let n = 0;
    for (let k = 0; k < b.n; k++) if (b.glyph[k] === 0) continue; else if (b.kind[k] !== 6 && b.pick[k] >= 0 && (window as any).__lumenwild.getEngine().editor.sources.has(b.pick[k])) n++;
    return n;
  })).toBeGreaterThan(0);
});

test('waterfall tool on the river lowers the bed downstream', async ({ page }) => {
  await ready(page, '?seed=7');
  const spot = await page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine(), br = e.gen.features.find((f: any) => f.kind === 'bridge');
    const d = e.water.view.depth;
    for (let y = br.y + 8; y < br.y + 30; y++) for (let x = br.x - 6; x <= br.x + 6; x++) if (d[y * 256 + x] > 0.4) { e.focus(x, y); return [x, y]; }
    return null;
  });
  const [x, y] = spot!;
  await page.waitForTimeout(300);
  const path = await page.evaluate(([x, y]) => (window as any).__lumenwild.getEngine().editor.traceDownstream(x, y, 12), [x, y]);
  const probe = path[8] as number;
  const before = await page.evaluate((i) => (window as any).__lumenwild.getEngine().world.elev[i], probe);
  await page.keyboard.press('8');
  const pos = (await screenOf(page, x, y))!;
  await page.mouse.click(pos[0], pos[1]);
  await expect.poll(() => page.evaluate((i) => (window as any).__lumenwild.getEngine().world.elev[i], probe)).toBeLessThan(before - 2);
});
