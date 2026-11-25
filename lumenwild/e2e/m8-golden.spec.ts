import { test, expect, type Page } from '@playwright/test';

/**
 * Golden images of the nine review views (seed 7). The app runs with `manual=1` (no animation loop) and `worker=0`
 * (water on the main thread), and every frame is driven here with fixed 1/60 s timestamps, so the whole pipeline
 * (generation, water, dragon, particles, atmosphere, composition, presentation) is deterministic and the images must
 * match exactly. Baselines are per platform (font rasterisation differs): on a new machine run
 * `npx playwright test e2e/m8-golden.spec.ts --update-snapshots` once, before making changes.
 */
test.use({ viewport: { width: 960, height: 600 } });

const SETUP = `
  const e = __lumenwild.getEngine(); const r = e.renderer.canvas.getBoundingClientRect();
  const zoom = (z) => { e.cam.zoomIndex = z; e.resize(r.width, r.height, 1); };
  const env = (s) => { e.env.set({ cycle: false, rain: 0, fog: 0, wind: 0.35, ...s }); e.env.settle(); };
  const step = (n) => { for (let i = 0; i < n; i++) { e.frame(window.__gt * 1000 / 60); window.__gt++; } };
`;

type View = [name: string, js: string];
const VIEWS: View[] = [
  ['1-day-landscape', `env({ time: 11 }); zoom(4); e.focus(...e.home); step(150);`],
  ['2-waterfall', `env({ time: 11.5 }); zoom(8); const f = e.gen.falls.find(f => f.big); e.focus(f.x, f.y - 2); step(180);`],
  ['3-pond-ripples', `env({ time: 12, wind: 0.1 }); zoom(9); const f = e.gen.features.filter(f => f.kind === 'pond')[0]; e.focus(f.x, f.y);
     step(54); e.water.disturb(f.x, f.y, 1.6, 1.4); e.water.disturb(f.x + 3, f.y + 1, 1.6, 1.2); step(48);`],
  ['4-river-rocks', `env({ time: 10 }); zoom(9); const d = e.water.view.depth; let best = null;
     for (const o of e.objects.objects.values()) { if (o.kind !== 'rock') continue; let wet = 0;
       for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (d[(o.y + dy) * 256 + o.x + dx] > 0.3) wet++;
       if (!best || wet > best[0]) best = [wet, o]; }
     e.focus(best[1].x, best[1].y); step(150);`],
  ['5-dense-forest', `env({ time: 13 }); zoom(7); let best = [0, 128, 128];
     for (let y = 40; y < 216; y += 8) for (let x = 40; x < 216; x += 8) {
       const n = e.objects.inRect(x - 10, y - 6, x + 10, y + 6, []).filter(o => o.kind === 'tree').length; if (n > best[0]) best = [n, x, y]; }
     e.focus(best[1], best[2]); step(150);`],
  ['6-sunset', `env({ time: 17.4 }); zoom(5); e.focus(...e.home); step(150);`],
  ['7-night-fireflies', `env({ time: 23 }); zoom(7); const m = [...e.objects.objects.values()].find(o => o.kind === 'cottage'); e.focus(m.x + 2, m.y + 2); step(420);`],
  ['8-rain', `env({ time: 15, rain: 1, wind: 0.8, fog: 0.2 }); zoom(6); e.focus(...e.home); step(210);`],
];

async function boot(page: Page): Promise<void> {
  await page.goto('/?seed=7&worker=0&manual=1');
  await page.waitForFunction(() => {
    const e = (window as any).__lumenwild?.getEngine();
    return !!e?.renderer && e.cam.viewW > 0 && e.water?.mode === 'main';
  }, null, { timeout: 30_000 });
  await page.evaluate(() => { (window as any).__gt = 0; });
}

const canvas = (page: Page) => page.getByTestId('world-canvas');
const exact = { maxDiffPixels: 0, threshold: 0 } as const;

for (const [name, js] of VIEWS) {
  test(`golden: ${name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await boot(page);
    await page.evaluate(`(() => { ${SETUP} ${js} })()`);
    await expect(canvas(page)).toHaveScreenshot(`${name}.png`, exact);
    expect(errors).toEqual([]);
  });
}

test('golden: 9-fullscreen (UI hidden)', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('h');
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid=world-canvas]') as HTMLCanvasElement;
    return c.width >= window.innerWidth - 1;
  });
  await page.evaluate(`(() => { ${SETUP} const r2 = e.renderer.canvas.getBoundingClientRect(); e.resize(r2.width, r2.height, 1);
    env({ time: 9.5 }); e.cam.zoomIndex = 5; e.resize(r2.width, r2.height, 1); e.focus(...e.home); step(150); })()`);
  await expect(canvas(page)).toHaveScreenshot('9-fullscreen.png', exact);
});

test('golden: the same frame sequence renders identical pixels twice', async ({ page }) => {
  await boot(page);
  const hash = () => page.evaluate(`(() => { ${SETUP}
    const c = e.renderer.canvas, g = document.createElement('canvas'); g.width = c.width; g.height = c.height;
    const x = g.getContext('2d'); x.drawImage(c, 0, 0); const d = x.getImageData(0, 0, g.width, g.height).data;
    let h = 2166136261; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); } return h >>> 0; })()`);
  await page.evaluate(`(() => { ${SETUP} env({ time: 11 }); zoom(6); e.focus(...e.home); step(120); })()`);
  const a = await hash();
  await boot(page);
  await page.evaluate(`(() => { ${SETUP} env({ time: 11 }); zoom(6); e.focus(...e.home); step(120); })()`);
  const b = await hash();
  expect(a).toBe(b);
});
