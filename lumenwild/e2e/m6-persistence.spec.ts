import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { ready } from './helpers';

const objCount = (page: Page, kind?: string) => page.evaluate((k) => (window as any).__lumenwild.getEngine().objects.count(k), kind);

/** Place a cottage through the editor API on a dry flat spot (input paths are covered by the M4 tests). */
const placeCottage = (page: Page) => page.evaluate(() => {
  const e = (window as any).__lumenwild.getEngine(), w = e.world, d = e.water.view.depth, occ = e.objects.occ;
  for (let y = 60; y < w.h - 40; y += 3) for (let x = 40; x < w.w - 40; x += 3) {
    let ok = true;
    for (let yy = y - 4; yy <= y + 4 && ok; yy++) for (let xx = x - 4; xx <= x + 4 && ok; xx++) {
      const i = yy * w.w + xx;
      if (d[i] > 0.01 || occ[i] || Math.abs(w.elev[i] - w.elev[y * w.w + x]) > 1) ok = false;
    }
    if (ok) { e.editor.begin('cottage', y * w.w + x); e.editor.end(); return [x, y]; }
  }
  return null;
});

async function clearSlots(page: Page) {
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases?.();
    for (const d of dbs ?? []) if (d.name) indexedDB.deleteDatabase(d.name);
  });
}

test('Ctrl+S saves to a slot; edits mark the world unsaved; loading the slot restores it; slots survive a reload', async ({ page }) => {
  await ready(page, '?seed=7');
  await clearSlots(page);
  await page.reload();
  await ready(page, '?seed=7');
  await expect(page.getByTestId('save-state')).toHaveText('Unsaved changes');
  const before = await objCount(page, 'cottage');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  await expect(page.getByTestId('toast')).toContainText('Saved');
  expect(await placeCottage(page)).not.toBeNull();
  expect(await objCount(page, 'cottage')).toBe(before + 1);
  await expect(page.getByTestId('save-state')).toHaveText('Unsaved changes');
  // Load the slot back (two clicks: it discards the unsaved cottage).
  await page.getByTestId('open-worlds').click();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(1);
  const load = page.getByTestId('load-slot').first();
  await load.click();
  await expect(load).toHaveText('Discard changes?');
  await load.click();
  await expect(page.getByTestId('world-dialog')).toHaveCount(0);
  await expect.poll(() => objCount(page, 'cottage')).toBe(before);
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  // After a reload the slot is still there (IndexedDB) and loads the same world.
  await page.reload();
  await ready(page, '?seed=7');
  await page.getByTestId('open-worlds').click();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('slot-list')).toContainText('seed 7');
});

test('rename, save as new slot, delete a slot with confirmation', async ({ page }) => {
  await ready(page, '?seed=7');
  await clearSlots(page);
  await page.reload();
  await ready(page, '?seed=7');
  await page.getByTestId('open-worlds').click();
  await page.getByTestId('world-name').fill('Moonlit Vale');
  await page.getByTestId('world-name').press('Enter');
  await page.getByTestId('save-current').click();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(1);
  await page.getByTestId('save-new').click();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('slot-list')).toContainText('Moonlit Vale');
  await expect(page.locator('.topbar')).toContainText('Moonlit Vale');
  const del = page.getByTestId('delete-slot').first();
  await del.click();
  await expect(del).toHaveText('Delete?');
  await del.click();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(1);
});

test('export JSON downloads a valid world file; importing it restores the world; a bad file is explained', async ({ page }, info) => {
  await ready(page, '?seed=7');
  expect(await placeCottage(page)).not.toBeNull();
  const cottages = await objCount(page, 'cottage');
  await page.getByTestId('open-worlds').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  expect(download.suggestedFilename()).toMatch(/seed7\.lumenwild\.json$/);
  const path = info.outputPath('world.json');
  await download.saveAs(path);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  expect(data.format).toBe('lumenwild-world');
  expect(data.seed).toBe(7);
  expect(data.w).toBe(256);
  // Generate a different world, then import the file: the cottage count and seed come back.
  await page.getByTestId('new-seed').fill('99');
  await page.getByTestId('generate').click();
  await page.getByTestId('generate').click().catch(() => {}); // second click confirms if the world was unsaved
  await expect.poll(() => page.evaluate(() => (window as any).__lumenwild.getEngine().world.seed)).toBe(99);
  await page.getByTestId('open-worlds').click();
  await page.getByTestId('import-file').setInputFiles(path);
  await expect.poll(() => page.evaluate(() => (window as any).__lumenwild.getEngine().world.seed)).toBe(7);
  expect(await objCount(page, 'cottage')).toBe(cottages);
  // An invalid file shows a report and leaves the world alone.
  await page.getByTestId('open-worlds').click();
  const bad = info.outputPath('bad.json');
  writeFileSync(bad, JSON.stringify({ format: 'lumenwild-world', version: 1, w: 256, h: 256, seed: 1, terrain: { elev: 'AAAA' }, objects: [] }));
  await page.getByTestId('import-file').setInputFiles(bad);
  await expect(page.getByTestId('import-report')).toContainText('Could not import');
  await expect(page.getByTestId('import-report')).toContainText('Grid "elev"');
  expect(await page.evaluate(() => (window as any).__lumenwild.getEngine().world.seed)).toBe(7);
  const notWorld = info.outputPath('notes.json');
  writeFileSync(notWorld, '{"hello": "world"}');
  await page.getByTestId('import-file').setInputFiles(notWorld);
  await expect(page.getByTestId('import-report')).toContainText('not a Lumenwild world');
});

test('new world from a seed', async ({ page }) => {
  await ready(page, '?seed=7');
  const a = await page.evaluate(() => (window as any).__lumenwild.getEngine().gen.features.map((f: any) => `${f.kind}@${f.x},${f.y}`).join(';'));
  await page.getByTestId('open-worlds').click();
  await page.getByTestId('new-seed').fill('42');
  await page.getByTestId('generate').click();
  await page.getByTestId('generate').click().catch(() => {});
  await expect(page.locator('.topbar')).toContainText('Vale 42');
  const b = await page.evaluate(() => (window as any).__lumenwild.getEngine().gen.features.map((f: any) => `${f.kind}@${f.x},${f.y}`).join(';'));
  expect(b).not.toBe(a);
  expect(b).toContain('large waterfall');
  // Water flows in the new world: the river is wet near its source.
  await expect.poll(() => page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine(), [x, y] = e.gen.source;
    return e.water.view.depth[y * 256 + x];
  })).toBeGreaterThan(0.05);
});

test('low-performance mode caps the frame rate', async ({ page }) => {
  await ready(page, '?seed=7');
  await page.getByTestId('low-perf').check();
  await page.waitForTimeout(2500);
  const fps = await page.evaluate(() => (window as any).__lumenwild.useUI.getState().stats.fps);
  expect(fps).toBeLessThan(40);
  expect(fps).toBeGreaterThan(15);
  const res = await page.evaluate(() => (window as any).__lumenwild.getEngine().renderer.resolutionScale);
  expect(res).toBe(0.75);
});
