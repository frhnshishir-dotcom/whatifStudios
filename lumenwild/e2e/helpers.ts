import type { Page } from '@playwright/test';

/** Wait until the app has booted and rendered at least a few frames. */
export async function ready(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => {
    const L = (window as any).__lumenwild;
    return !!L?.useUI.getState().stats;
  }, null, { timeout: 30_000 });
}

export const engineState = (page: Page) => page.evaluate(() => {
  const e = (window as any).__lumenwild.getEngine();
  return { camX: e.cam.x, camY: e.cam.y, cellW: e.cam.cellW, paused: e.clock.paused, steps: e.clock.steps, cols: e.composer.buf.cols, rows: e.composer.buf.rows };
});

/** Pixel statistics of the world canvas: distinct colours and luminance spread (a blank canvas has ~1 colour). */
export const canvasStats = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid=world-canvas]') as HTMLCanvasElement;
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const seen = new Set<number>();
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; sum2 += l * l; n++;
    if (seen.size < 5000) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  const mean = sum / n;
  return { colors: seen.size, mean, std: Math.sqrt(sum2 / n - mean * mean), w: c.width, h: c.height };
});
