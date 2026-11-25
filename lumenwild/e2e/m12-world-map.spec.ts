import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { ready } from './helpers';

const SHOTS = process.env.WORLD_SHOTS; // folder for review images

async function saveCanvas(page: Page, path: string): Promise<void> {
  const url = await page.evaluate(() => (document.querySelector('[data-testid=blueprint-canvas]') as HTMLCanvasElement).toDataURL('image/png'));
  writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'));
}

test('world map: blueprint with all geography checks passing, and the player start view with fog of war', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page, '?seed=7');
  await page.getByTestId('open-continent').click();
  await expect(page.getByTestId('blueprint-canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('blueprint-checks')).toContainText('Geography checks');
  const bp = await page.evaluate(() => {
    const b = (window as any).__lumenwild.blueprint;
    return { checks: b.checks.length, failed: b.checks.filter((c: any) => !c.ok).map((c: any) => c.id), roads: b.roads.length, rivers: b.rivers.length };
  });
  expect(bp.failed).toEqual([]);
  expect(bp.checks).toBeGreaterThan(30);
  const colours = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=blueprint-canvas]') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data, set = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 89) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  });
  expect(colours).toBeGreaterThan(500);
  if (SHOTS) await saveCanvas(page, `${SHOTS}/world-blueprint.png`);
  await page.getByTestId('map-mode-player').click();
  await expect(page.getByTestId('blueprint-explored')).toContainText('Heartlands');
  // Most of the map is still hidden for a new player.
  const dark = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=blueprint-canvas]') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0, t = 0;
    for (let i = 0; i < d.length; i += 4 * 53) { t++; if (d[i] + d[i + 1] + d[i + 2] < 90) n++; }
    return n / t;
  });
  expect(dark).toBeGreaterThan(0.7);
  if (SHOTS) await saveCanvas(page, `${SHOTS}/world-player-start.png`);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
