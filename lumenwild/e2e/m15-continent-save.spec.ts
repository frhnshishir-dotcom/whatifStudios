import { test, expect, type Page } from '@playwright/test';

/** Make changes in the centre region at a known map point; returns that point. */
const edit = (page: Page) => page.evaluate(() => {
  const L = (window as any).__lumenwild, e = L.getEngine(), s = e.streamer, W = s.win.W, S = s.win.S;
  const x = S + 100, y = S + 120, at = s.mapOf(x, y);
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) { const i = (y + dy) * W + x + dx; e.world.mat[i] = 4; e.world.elev[i] += 3; }
  e.world.markTerrainDirty(x - 1, y - 1, x + 4, y + 4);
  // A tree in the loaded window (the start region around the village is kept clear).
  const tree = [...e.objects.objects.values()].find((o: any) => o.kind === 'tree' && o.x > 8 && o.y > 8 && o.x < W - 8 && o.y < W - 8);
  e.objects.remove(tree.id);
  L.useUI.getState().markUnsaved();
  return { at, tree: { x: tree.x, y: tree.y, kind: tree.kind, variant: tree.variant }, objects: e.objects.objects.size };
});

/** The material and height at a map point, and whether a tree stands at window cell offset of the removed one. */
const probe = (page: Page, at: number[], tree: { x: number; y: number }) => page.evaluate(([ax, ay, tx, ty]) => {
  const e = (window as any).__lumenwild.getEngine(), s = e.streamer, [x, y] = s.windowCellOf([ax, ay]), i = y * s.win.W + x;
  const treeThere = [...e.objects.objects.values()].some((o: any) => o.kind === 'tree' && o.x === tx && o.y === ty);
  return { mat: e.world.mat[i], origin: s.win.origin, treeThere, objects: e.objects.objects.size };
}, [at[0], at[1], tree.x, tree.y]);

test('continent: changes are saved to continent slots, survive a reload, and never appear among Valley saves', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?scene=continent');
  await page.waitForFunction(() => !!(window as any).__lumenwild?.useUI.getState().stats, null, { timeout: 90_000 });
  const before = await probe(page, [0, 0], { x: -1, y: -1 });
  const ed = await edit(page);
  const after = await probe(page, ed.at, ed.tree);
  expect(after.mat).toBe(4);
  expect(after.treeThere).toBe(false);

  // Save into a continent slot.
  await page.getByTestId('open-worlds').click();
  await page.getByTestId('save-current').click();
  await expect(page.getByText(/^Saved “/)).toBeVisible();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('generate')).toHaveCount(0); // no "New world" on the continent
  await page.keyboard.press('Escape');

  // Reload: a fresh continent (generated ground), then load the slot.
  await page.goto('/?scene=continent');
  await page.waitForFunction(() => !!(window as any).__lumenwild?.useUI.getState().stats, null, { timeout: 90_000 });
  const fresh = await probe(page, ed.at, ed.tree);
  expect(fresh.mat).not.toBe(4);
  expect(fresh.treeThere).toBe(true);
  await page.getByTestId('open-worlds').click();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(1);
  const load = page.getByTestId('load-slot').first();
  await load.click();
  if (await load.isVisible() && (await load.textContent())?.includes('Discard')) await load.click(); // confirm when unsaved
  await expect(page.getByTestId('world-dialog')).toHaveCount(0);
  const loaded = await probe(page, ed.at, ed.tree);
  expect(loaded.mat).toBe(4);
  expect(loaded.treeThere).toBe(false);
  expect(loaded.objects).toBe(ed.objects);
  expect(loaded.origin).toEqual(after.origin);

  // The Valley lists only its own saves.
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__lumenwild?.useUI.getState().stats, null, { timeout: 60_000 });
  await page.getByTestId('open-worlds').click();
  await expect(page.getByTestId('slot-list').locator('li')).toHaveCount(0);
  expect(before.origin.length).toBe(2);
  expect(errors).toEqual([]);
});
