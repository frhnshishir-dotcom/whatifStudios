import { test, expect, type Page } from '@playwright/test';
import { ready } from './helpers';

/** Count cell kinds in the current composed frame (5 = object, 4 = waterfall, 3 = water). */
const kinds = (page: Page) => page.evaluate(() => {
  const b = (window as any).__lumenwild.getEngine().composer.buf;
  const k = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < b.n; i++) k[b.kind[i]]++;
  return k;
});

const focusOn = (page: Page, what: string) => page.evaluate((what) => {
  const e = (window as any).__lumenwild.getEngine();
  const f = what === 'big fall' ? e.gen.falls.find((f: any) => f.big) : e.gen.features.find((f: any) => f.kind === what);
  e.focus(f.x, f.y);
  return [f.x, f.y];
}, what);

test('generated vale opens on the river with objects, water and every landmark', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page, '?seed=7');
  const gen = await page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine();
    return { features: e.gen.features.map((f: any) => f.kind), objects: e.objects.objects.size };
  });
  for (const k of ['large waterfall', 'lake', 'bridge', 'cottage', 'water mill', 'glowing glade']) expect(gen.features).toContain(k);
  expect(gen.objects).toBeGreaterThan(1000);
  await expect.poll(async () => (await kinds(page))[5]).toBeGreaterThan(200); // trees, rocks, bridge, cottage on screen
  expect((await kinds(page))[3]).toBeGreaterThan(150); // river water on screen
  expect(errors).toEqual([]);
});

test('the large waterfall pours (animated fall glyphs) into its pool', async ({ page }) => {
  await ready(page, '?seed=7');
  await focusOn(page, 'big fall');
  await expect.poll(async () => (await kinds(page))[4], { timeout: 15_000 }).toBeGreaterThan(20);
  // The fall face animates: glyphs in waterfall cells change between frames.
  const snap = () => page.evaluate(() => {
    const b = (window as any).__lumenwild.getEngine().composer.buf;
    const out: number[] = [];
    for (let i = 0; i < b.n; i++) if (b.kind[i] === 4) out.push(i * 1000 + b.glyph[i]);
    return out;
  });
  const a = await snap();
  await page.waitForTimeout(400);
  const b = await snap();
  const setA = new Set(a);
  expect(b.filter((v) => !setA.has(v)).length).toBeGreaterThan(3);
});

test('the mill wheel turns', async ({ page }) => {
  await ready(page, '?seed=7');
  const wheel = await page.evaluate(() => {
    const e = (window as any).__lumenwild.getEngine();
    const m = [...e.objects.objects.values()].find((o: any) => o.kind === 'mill');
    e.cam.zoomIndex = 10;
    e.focus(m.x + 2, m.y + 1);
    return { x: m.x + (m.props.wheelSide > 0 ? 5 : -2), y: m.y + 2 };
  });
  // Glyphs of the wheel's cells (object cells whose pick index is a wheel ground cell) over time.
  const wheelGlyphs = () => page.evaluate(({ x, y }) => {
    const e = (window as any).__lumenwild.getEngine(), b = e.composer.buf, W = e.world.w;
    const out: number[] = [];
    for (let i = 0; i < b.n; i++) {
      if (b.kind[i] !== 5) continue;
      const p = b.pick[i], px = p % W, py = Math.floor(p / W);
      if (py === y && Math.abs(px - x) <= 1) out.push(b.glyph[i]);
    }
    return out.join(',');
  }, wheel);
  await expect.poll(wheelGlyphs).not.toBe('');
  const seen = new Set<string>();
  for (let k = 0; k < 8; k++) { seen.add(await wheelGlyphs()); await page.waitForTimeout(150); }
  expect(seen.size).toBeGreaterThan(1);
});

test('different seeds generate different worlds', async ({ page }) => {
  await ready(page, '?seed=7');
  const a = await page.evaluate(() => (window as any).__lumenwild.getEngine().gen.features.map((f: any) => `${f.kind}@${f.x},${f.y}`).join(';'));
  await ready(page, '?seed=8');
  const b = await page.evaluate(() => (window as any).__lumenwild.getEngine().gen.features.map((f: any) => `${f.kind}@${f.x},${f.y}`).join(';'));
  expect(a).not.toBe(b);
});
