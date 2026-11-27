import { test, expect, type Page } from '@playwright/test';

/**
 * The RPG in the browser, single player: fight a wolf with Space (chasing it), see the HUD, pick up its loot with E,
 * equip from the Pack tab, take a quest from a villager, buy from a shop, level up and spend a point, then save the
 * continent, reload, load the save, and find the character as it was.
 */
const lw = <T,>(page: Page, f: string) => page.evaluate((f) => new Function('lw', `return (${f})`)((window as any).__lumenwild.getEngine().streamer.life), f) as Promise<T>;

test('fight, loot, equip, quest, shop, level up; the character survives save and reload', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?scene=continent&layout=sandbox');
  await page.waitForFunction(() => (window as any).__lumenwild?.getEngine()?.streamer?.life?.sim.villages.people.size > 0, null, { timeout: 90_000 });
  await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); e.env.set({ time: 11 }); e.env.settle(); });
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('hud-level')).toHaveText('Lv 1');

  // A wolf turns on the traveller; hold Space and keep after it until it falls.
  await lw(page, `(() => { const p = lw.player; lw.sim.wildlife.raiseGuardian('e2e-wolf', 'wolf', p.x + 4, p.y, p, lw.sim.clock); })()`);
  await page.keyboard.down('Space');
  for (let k = 0; k < 120; k++) {
    const d = await lw<number | null>(page, `(() => { const c = lw.sim.wildlife.creatures.get('e2e-wolf'), p = lw.player; if (!c.alive) { lw.input = null; return null; } const dx = c.x - p.x, dy = c.y - p.y, d = Math.hypot(dx, dy); lw.input = d > 1.5 ? { dx: dx / d, dy: dy / d, run: true } : { dx: 0, dy: 0, run: false }; p.hero.hp = Math.max(p.hero.hp, 30); return d; })()`);
    if (d === null) break;
    await page.waitForTimeout(150);
  }
  await page.keyboard.up('Space');
  expect(await lw<boolean>(page, `lw.sim.wildlife.creatures.get('e2e-wolf').alive`)).toBe(false);
  expect(await lw<number>(page, `lw.player.hero.stats.kills.wolf`)).toBe(1);
  expect(await lw<number>(page, `lw.player.hero.stats.dmgDealt`)).toBeGreaterThanOrEqual(55);

  // Loot: walk onto the bag and press E.
  await lw(page, `(() => { const g = [...lw.sim.rpg.loot.values()].find((q) => q.owner === 'local'); lw.player.x = g.x; lw.player.y = g.y; })()`);
  await expect(page.getByTestId('life-prompt')).toContainText('Pick up', { timeout: 10_000 });
  await page.keyboard.press('e');
  await expect(page.getByTestId('life-inventory')).toContainText(/wolf pelt|fang/i, { timeout: 10_000 });

  // Equip from the Pack tab (I opens it): a spear bought below goes into the hand.
  await lw(page, `lw.player.hero.coins = 200`);
  // A shop: stand by Lumenfall's blacksmith and talk (E): the Shop tab opens.
  const smith = await lw<string>(page, `(() => { const v = [...lw.sim.villages.people.values()].find((q) => q.village === 'lumenfall' && q.tag === 'blacksmith'); v.out = true; lw.player.x = v.x + 1; lw.player.y = v.y; return v.id; })()`);
  await expect(page.getByTestId('life-prompt')).toContainText('Talk to', { timeout: 10_000 });
  void smith;
  await page.keyboard.press('e');
  await expect(page.getByTestId('shop-tab')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('buy-iron-dagger').click();
  await expect(page.getByTestId('rpg-message')).toContainText('Bought');
  await page.getByTestId('tab-pack').click();
  await page.getByTestId('equip-iron-dagger').click();
  expect(await lw<string>(page, `lw.player.hero.equip.weapon.id`)).toBe('iron-dagger');

  // A quest from a villager with work (a yellow "!").
  await lw(page, `(() => { const p = lw.player; for (const v of lw.sim.villages.people.values()) { if (v.village === 'lumenfall' && lw.sim.rpg.isGiver(v) && lw.sim.rpg.questFrom(p, v)) { v.out = true; p.x = v.x + 1; p.y = v.y; return v.id; } } })()`);
  await expect(page.getByTestId('hud-prompt')).toContainText('Talk to', { timeout: 10_000 });
  await page.keyboard.press('e');
  await page.getByTestId('tab-quests').click();
  await expect(page.getByTestId('quest-offer')).toBeVisible();
  await page.getByTestId('quest-accept').click();
  await expect(page.getByTestId('quest-list')).toContainText('/');
  const quest = await lw<string>(page, `lw.player.hero.quests[0].title`);

  // Level up and spend a point (Hero tab).
  await lw(page, `(() => { lw.sim.rpg['xp'](lw.player, 500); lw.processEvents(); })()`);
  await expect(page.getByTestId('hud-level')).not.toHaveText('Lv 1', { timeout: 5_000 });
  await page.getByTestId('tab-hero').click();
  const str0 = await lw<number>(page, `lw.player.hero.attrs.str`);
  await page.getByTestId('spend-str').click();
  expect(await lw<number>(page, `lw.player.hero.attrs.str`)).toBe(str0 + 1);
  const snap = await lw<{ level: number; coins: number; weapon: string; quest: string; kills: number }>(page, `({ level: lw.player.hero.level, coins: lw.player.hero.coins, weapon: lw.player.hero.equip.weapon.id, quest: lw.player.hero.quests[0].title, kills: lw.player.hero.stats.kills.wolf })`);
  expect(snap.quest).toBe(quest);

  // Save, reload, load: the character is back as it was.
  await page.getByTestId('open-worlds').click();
  await page.getByTestId('save-current').click();
  await expect(page.getByText(/^Saved “/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/?scene=continent&layout=sandbox');
  await page.waitForFunction(() => (window as any).__lumenwild?.getEngine()?.streamer?.life?.sim.villages.people.size > 0, null, { timeout: 90_000 });
  expect(await lw<number>(page, `lw.player.hero.level`)).toBe(1);
  await page.getByTestId('open-worlds').click();
  const load = page.getByTestId('load-slot').first();
  await load.click();
  if (await load.isVisible() && (await load.textContent())?.includes('Discard')) await load.click();
  await expect(page.getByTestId('world-dialog')).toHaveCount(0);
  const back = await lw<typeof snap>(page, `({ level: lw.player.hero.level, coins: lw.player.hero.coins, weapon: lw.player.hero.equip.weapon.id, quest: lw.player.hero.quests[0] && lw.player.hero.quests[0].title, kills: lw.player.hero.stats.kills.wolf })`);
  expect(back).toEqual(snap);
  expect(errors).toEqual([]);
});
