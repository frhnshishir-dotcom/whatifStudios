import { test, expect } from '@playwright/test';

const SHOTS = process.env.WORLD_SHOTS;

/** One place well inside each region (map units). */
const PLACES: Array<[string, string, number, number]> = [
  ['heartlands', 'Heartlands', 560, 560], ['dragon-peaks', 'Dragon Peaks', 560, 160], ['elderwood', 'Elderwood', 160, 380],
  ['golden-plains', 'Golden Plains', 250, 860], ['whispering-marshes', 'Whispering Marshes', 740, 790], ['hollow-lands', 'Hollow Lands', 850, 400],
];

test('continent biomes: each of the six regions renders with its own look', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const means: Record<string, [number, number, number]> = {};
  for (const [id, name, x, y] of PLACES) {
    await page.goto(`/?scene=continent&layout=sandbox&at=${x},${y}`);
    await page.waitForFunction(() => !!(window as any).__lumenwild?.useUI.getState().stats, null, { timeout: 90_000 });
    await expect(page.getByTestId('continent-where')).toContainText(name);
    await page.waitForTimeout(1500); // shading of the window settles
    means[id] = await page.evaluate(() => {
      const c = document.querySelector('[data-testid=world-canvas]') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 5) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      return [r / n, g / n, b / n] as [number, number, number];
    });
    if (SHOTS) await page.getByTestId('world-canvas').screenshot({ path: `${SHOTS}/biome-${id}.png` });
  }
  const ids = PLACES.map((p) => p[0]);
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const A = means[ids[a]], B = means[ids[b]], d = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
    console.log(`rendered colour ${ids[a]} vs ${ids[b]}: ${d.toFixed(0)}`);
    expect(d, `${ids[a]} vs ${ids[b]}`).toBeGreaterThan(12);
  }
  expect(errors).toEqual([]);
});
