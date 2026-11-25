import { test, expect } from '@playwright/test';
import { ready } from './helpers';
import { writeFileSync } from 'node:fs';

/** Save the whole canvas (not the visible part of the dialog) as a PNG. */
async function saveCanvas(page: import('@playwright/test').Page, path: string): Promise<void> {
  const url = await page.evaluate(() => (document.querySelector('[data-testid=continent-canvas]') as HTMLCanvasElement).toDataURL('image/png'));
  writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'));
}

const SHOTS = process.env.CONTINENT_SHOTS; // set to a folder to save review screenshots

test('continent preview: map, five village close-ups and land-use figures', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page, '?seed=7');
  const before = await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); return { w: e.world.w, objects: e.objects.objects.size }; });
  await page.getByTestId('open-continent').click();
  await expect(page.getByTestId('continent-dialog')).toBeVisible();
  await expect(page.getByTestId('continent-canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('continent-stats')).toContainText('wilderness');
  const s = await page.evaluate(() => (window as any).__lumenwild.continent.stats);
  expect(s.wilderness).toBeGreaterThanOrEqual(85);
  expect(s.wilderness).toBeLessThanOrEqual(90);
  // The map is painted (many distinct colours), not blank.
  const colours = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=continent-canvas]') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data, set = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  });
  expect(colours).toBeGreaterThan(300);
  if (SHOTS) await saveCanvas(page, `${SHOTS}/continent-map.png`);
  for (const id of ['greenhaven', 'frostwatch', 'windmere', 'marshlight', 'moonrest']) {
    await page.getByTestId(`continent-tab-${id}`).click();
    await expect(page.getByTestId('village-info')).toBeVisible();
    await expect(page.getByTestId('village-info')).toContainText('villagers');
    if (SHOTS) await saveCanvas(page, `${SHOTS}/village-${id}.png`);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('continent-dialog')).toHaveCount(0);
  // The playable world is untouched by the preview.
  const after = await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); return { w: e.world.w, objects: e.objects.objects.size }; });
  expect(after).toEqual(before);
  expect(errors).toEqual([]);
});
