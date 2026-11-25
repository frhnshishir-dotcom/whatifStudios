import { test, expect, type Page } from '@playwright/test';

const SHOTS = process.env.WORLD_SHOTS;
const kinds = (page: Page) => page.evaluate(() => {
  const k: Record<string, number> = {};
  for (const o of (window as any).__lumenwild.getEngine().objects.objects.values()) k[o.kind] = (k[o.kind] ?? 0) + 1;
  return k;
});
const boot = async (page: Page, at: string) => {
  await page.goto(`/?scene=continent&at=${at}`);
  await page.waitForFunction(() => !!(window as any).__lumenwild?.useUI.getState().stats, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
};

test('continent: villages are built (buildings, mill, lanes) and the King’s Road crosses the Lumen on a bridge', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await boot(page, '500,510');
  const k = await kinds(page);
  expect(k.building ?? 0).toBeGreaterThan(20);
  expect(k.mill ?? 0).toBe(1);
  // The village square and lanes are paved.
  const paved = await page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine(), [x, y] = e.home;
    let n = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (e.world.mat[(y + dy) * e.world.w + x + dx] === 3) n++; // Mat.Path
    return n;
  });
  expect(paved).toBeGreaterThan(60);
  if (SHOTS) await page.getByTestId('world-canvas').screenshot({ path: `${SHOTS}/village-lumenfall.png` });

  await boot(page, '509.3,555.1');
  const b = await kinds(page);
  expect(b.span ?? 0).toBeGreaterThanOrEqual(1);
  // The deck is drawn: some screen cells show the bridge object.
  const drawn = await page.evaluate(() => (window as any).__lumenwild.getEngine().objectLayer?.drawn ?? -1);
  expect(drawn).not.toBe(0);
  if (SHOTS) await page.getByTestId('world-canvas').screenshot({ path: `${SHOTS}/bridge-lumen.png` });
  expect(errors).toEqual([]);
});
