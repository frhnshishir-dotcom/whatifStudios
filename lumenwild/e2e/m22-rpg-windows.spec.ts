import { test, expect, type Page } from '@playwright/test';

/**
 * RPG interface step 4: the Character, Inventory, Journal and Crafting windows. Every action is the game's own
 * command through the window's buttons, and the character changes as the rules say. The traveller's name is saved
 * with the continent and comes back after a reload.
 */
const ready = (page: Page) => page.waitForFunction(() => !!document.querySelector('[data-testid="rpg-hud"]') && (window as any).__lumenwild?.getEngine()?.streamer?.life?.sim.villages.people.size > 0, null, { timeout: 90_000 });
const lw = <T,>(page: Page, f: string) => page.evaluate((f) => new Function('lw', `return (${f})`)((window as any).__lumenwild.getEngine().streamer.life), f) as Promise<T>;

test('windows open and close; inventory, equipment, attributes, quests and crafting act through the game', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/?scene=continent');
  await ready(page);
  await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); e.env.set({ time: 10 }); e.env.settle(); });

  // Keys and the dock open the windows; Esc and the close button shut them.
  for (const [key, id] of [['KeyC', 'character'], ['KeyI', 'inventory'], ['KeyJ', 'journal'], ['KeyK', 'craft']] as const) {
    await page.keyboard.press(key);
    await expect(page.getByTestId(`window-${id}`)).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId(`window-${id}`)).toHaveCount(0);
  }
  await page.getByTestId('open-journal').click();
  await expect(page.getByTestId('window-journal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('window-journal')).toHaveCount(0);

  // Inventory: the real pack (3 bread, the coins) and equipment.
  await page.keyboard.press('KeyI');
  await expect(page.getByTestId('item-bread')).toContainText('3');
  await expect(page.getByTestId('inv-coins')).toHaveText(String(await lw<number>(page, 'lw.player.hero.coins')));
  await expect(page.getByTestId('slot-weapon')).toContainText('dmg'); // the knife's numbers
  // Equipment changes the character: take the weapon off (attack falls), put it back (attack returns).
  await page.keyboard.press('KeyC');
  const atk0 = await page.getByTestId('char-attack').textContent();
  await page.keyboard.press('KeyI');
  await page.getByTestId('unequip-weapon').click();
  expect(await lw<boolean>(page, '!lw.player.hero.equip.weapon')).toBe(true);
  await expect(page.getByTestId('slot-weapon')).toContainText('—');
  await page.keyboard.press('KeyC');
  await expect(page.getByTestId('char-attack')).not.toHaveText(atk0!);
  await page.keyboard.press('KeyI');
  await page.getByTestId('item-knife').click();
  await page.getByTestId('item-equip').click();
  expect(await lw<string>(page, 'lw.player.hero.equip.weapon.id')).toBe('knife');
  await page.keyboard.press('KeyC');
  await expect(page.getByTestId('char-attack')).toHaveText(atk0!);

  // Eating heals (the rules' own amounts) and uses one bread.
  await lw(page, 'lw.player.hero.hp = 30');
  await page.keyboard.press('KeyI');
  await page.getByTestId('item-bread').click();
  await page.getByTestId('item-use').click();
  expect(await lw<number>(page, 'lw.player.hero.hp')).toBeGreaterThan(30);
  await expect(page.getByTestId('item-bread')).toContainText('2');
  await expect(page.getByTestId('hud-hp')).toHaveText(new RegExp(`^${await lw<number>(page, 'Math.ceil(lw.player.hero.hp)')} / `));

  // Attributes: points from a level (the rules' experience) are spent in the Character window.
  await lw(page, '(() => { lw.sim.rpg.xp(lw.player, 140); lw.processEvents(); })()');
  await page.getByTestId('hud-points').click(); // the plate's badge opens the Character window
  await expect(page.getByTestId('window-character')).toBeVisible();
  const str0 = await lw<number>(page, 'lw.player.hero.attrs.str'), pts0 = await lw<number>(page, 'lw.player.hero.points');
  expect(pts0).toBeGreaterThan(0);
  await page.getByTestId('spend-str').click();
  expect(await lw<number>(page, 'lw.player.hero.attrs.str')).toBe(str0 + 1);
  await expect(page.getByTestId('attr-str')).toHaveText(String(str0 + 1));
  await expect(page.getByTestId('hud-level')).toHaveText(`Lv ${await lw<number>(page, 'lw.player.hero.level')}`);

  // Journal: a quest accepted from a real giver is listed with its progress; abandoning removes it.
  await lw(page, `(() => { const p = lw.player, v = [...lw.sim.villages.people.values()].filter((v) => v.out && lw.sim.rpg.isGiver(v)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]; p.x = v.x + 1; p.y = v.y; lw.command({ t: 'talk', vid: v.id }); })()`);
  await page.keyboard.press('KeyJ');
  await expect(page.getByTestId('journal-offer')).toBeVisible();
  await page.getByTestId('journal-accept').click();
  const q = await lw<{ id: string; title: string }>(page, '({ id: lw.player.hero.quests[0].id, title: lw.player.hero.quests[0].title })');
  await expect(page.getByTestId('journal-quests')).toContainText(q.title);
  await expect(page.getByTestId('tracker-quest').first()).toContainText(q.title);
  await page.getByTestId(`abandon-${q.id}`).click();
  expect(await lw<number>(page, 'lw.player.hero.quests.length')).toBe(0);
  await expect(page.getByTestId('journal-quests')).toHaveCount(0);

  // Crafting: the club (3 wood, made anywhere) cannot be made without wood; with wood in the pack the window's
  // Make button makes it (the rules' craft: the wood is used, the club is in the pack).
  await page.keyboard.press('KeyK');
  await expect(page.getByTestId('craft-recipes')).toBeVisible();
  await expect(page.getByTestId('craft-club')).toBeDisabled();
  await lw(page, `lw.player.hero.inv.push({ uid: 'test-wood', id: 'wood', n: 3, r: 0 })`); // test setup: three pieces of wood
  await expect(page.getByTestId('craft-club')).toBeEnabled();
  await page.getByTestId('craft-club').click();
  await expect.poll(() => lw<boolean>(page, `lw.player.hero.inv.some((i) => i.id === 'club') && !lw.player.hero.inv.some((i) => i.id === 'wood')`)).toBe(true);
  await expect(page.getByTestId('craft-club')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('the traveller is named in the Character window, and the name survives save and reload', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/?scene=continent');
  await ready(page);
  await page.keyboard.press('KeyC');
  const input = page.getByTestId('char-name-input');
  await input.fill('x<bad>');
  await page.getByTestId('char-name-save').click();
  await expect(page.getByTestId('window-character')).toContainText('1–24 letters');
  expect(await lw<string>(page, 'lw.player.name')).toBe('Traveller');
  await input.fill('Elowen');
  await page.getByTestId('char-name-save').click();
  await expect(page.getByTestId('hud-name')).toHaveText('Elowen');
  expect(await lw<string>(page, 'lw.player.name')).toBe('Elowen');
  // Save, reload (a fresh traveller), load: Elowen again.
  await page.keyboard.press('Escape');
  await page.getByTestId('open-worlds').click();
  await page.getByTestId('save-current').click();
  await expect(page.getByText(/^Saved “/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/?scene=continent');
  await ready(page);
  await expect(page.getByTestId('hud-name')).toHaveText('Traveller');
  await page.getByTestId('open-worlds').click();
  const load = page.getByTestId('load-slot').first();
  await load.click();
  if (await load.isVisible() && (await load.textContent())?.includes('Discard')) await load.click();
  await expect(page.getByTestId('world-dialog')).toHaveCount(0);
  await expect(page.getByTestId('hud-name')).toHaveText('Elowen');
});
