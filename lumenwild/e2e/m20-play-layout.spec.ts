import { test, expect, type Page } from '@playwright/test';

/**
 * RPG interface step 2: the continent opens in Play (the world, the game bar and the HUD; no editing tools), and B
 * switches to the Sandbox and back. Only the interface changes: the canvas, the engine, the world and the character
 * are the same objects, carrying on. Editing is off in Play. The Valley is unchanged.
 */
const ready = (page: Page) => page.waitForFunction(() => !!(window as any).__lumenwild?.getEngine()?.streamer?.life && !!document.querySelector('[data-testid="hud"]'), null, { timeout: 90_000 });
const state = (page: Page) => page.evaluate(() => {
  const e = (window as any).__lumenwild.getEngine(), lw = e.streamer.life;
  return { engineSame: (window as any).__engine0 === e, canvasMark: (document.querySelector('[data-testid="world-canvas"]') as HTMLElement).dataset.mark ?? null,
    hero: JSON.stringify({ level: lw.player.hero.level, xp: lw.player.hero.xp, coins: lw.player.hero.coins, inv: lw.player.hero.inv, equip: lw.player.hero.equip }),
    x: lw.player.x, y: lw.player.y, t: lw.sim.clock.t, tool: (window as any).__lumenwild.useUI.getState().tool };
});

test('the continent opens in Play; B switches to the Sandbox and back with the same world', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/?scene=continent');
  await ready(page);
  // Play: the game bar and the HUD; none of the editor's chrome.
  await expect(page.getByTestId('playbar')).toBeVisible();
  await expect(page.getByTestId('play-where')).toContainText('Heartlands');
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.locator('.toolbar')).toHaveCount(0);
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(page.locator('.bottombar')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__engine0 = (window as any).__lumenwild.getEngine(); (document.querySelector('[data-testid="world-canvas"]') as HTMLElement).dataset.mark = 'same'; });
  const a = await state(page);
  expect(a.tool).toBe('select');

  // Editing is off in Play: tool keys do nothing, and a click on the ground edits nothing.
  await page.keyboard.press('2'); // "raise terrain" in the Sandbox
  expect((await state(page)).tool).toBe('select');
  const box = (await page.getByTestId('world-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
  expect(await page.evaluate(() => (window as any).__lumenwild.getEngine().editor.history.canUndo)).toBe(false);

  // B: the Sandbox, with the same canvas, engine and character.
  await page.keyboard.press('b');
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.getByTestId('playbar')).toHaveCount(0);
  await expect(page.getByTestId('layout-play')).toBeVisible();
  const b = await state(page);
  expect(b.engineSame).toBe(true);
  expect(b.canvasMark).toBe('same'); // not remounted
  expect(b.hero).toBe(a.hero);
  expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(0.5);
  expect(b.t).toBeGreaterThan(a.t); // the world kept running
  // The Sandbox's tools work again; the tool chosen there comes back after a visit to Play.
  await page.keyboard.press('2');
  expect((await state(page)).tool).toBe('raise');
  await page.getByTestId('layout-play').click();
  await expect(page.getByTestId('playbar')).toBeVisible();
  expect((await state(page)).tool).toBe('select');
  await page.keyboard.press('b');
  expect((await state(page)).tool).toBe('raise');
  await page.keyboard.press('b');
  const c = await state(page);
  expect(c.canvasMark).toBe('same');
  expect(c.engineSame).toBe(true);
  expect(c.hero).toBe(a.hero);
  expect(errors).toEqual([]);
});

test('Play at 820 px and on a phone: the game bar and HUD fit; the Sandbox is reachable', async ({ page }) => {
  test.setTimeout(180_000);
  for (const [w, h] of [[820, 1180], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?scene=continent');
    await ready(page);
    await expect(page.getByTestId('playbar')).toBeVisible();
    await expect(page.getByTestId('hud-level')).toBeVisible();
    await expect(page.getByTestId('layout-sandbox')).toBeVisible();
    // Nothing spills sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByTestId('layout-sandbox').click();
    await expect(page.getByTestId('layout-play')).toBeVisible();
  }
});

test('the Valley is unchanged: no game bar, and B is still the bridge tool', async ({ page }) => {
  await page.goto('/?seed=7');
  await page.waitForFunction(() => !!(window as any).__lumenwild?.getEngine(), null, { timeout: 60_000 });
  await expect(page.getByTestId('playbar')).toHaveCount(0);
  await expect(page.locator('.toolbar')).toBeVisible();
  await page.keyboard.press('b');
  expect(await page.evaluate(() => (window as any).__lumenwild.useUI.getState().tool)).toBe('bridge');
});
