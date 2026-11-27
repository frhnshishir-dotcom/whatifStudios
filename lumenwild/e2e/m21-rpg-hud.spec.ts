import { test, expect, devices, type Page } from '@playwright/test';

/**
 * RPG interface step 3: the HUD shows the real character and fights, and changes with them at once.
 * Actions go through the game itself (commands, the rules, the client's attack); the HUD is read back against the
 * character's own numbers.
 */
const ready = (page: Page) => page.waitForFunction(() => !!document.querySelector('[data-testid="rpg-hud"]') && (window as any).__lumenwild?.getEngine()?.streamer?.life?.sim.villages.people.size > 0, null, { timeout: 90_000 });
const lw = <T,>(page: Page, f: string) => page.evaluate((f) => new Function('lw', `return (${f})`)((window as any).__lumenwild.getEngine().streamer.life), f) as Promise<T>;

test('the HUD shows the character, the fight, quests, notices and level-ups from the game', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/?scene=continent');
  await ready(page);
  await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); e.env.set({ time: 10 }); e.env.settle(); });

  // The plate: the character's name, level, health and experience.
  await expect(page.getByTestId('hud-name')).toHaveText(await lw<string>(page, 'lw.player.name'));
  await expect(page.getByTestId('hud-level')).toHaveText('Lv 1');
  const plateHp = () => page.getByTestId('hud-hp').textContent();
  const heroHp = () => lw<number>(page, 'Math.max(0, Math.ceil(lw.player.hero.hp))');
  expect((await plateHp())!.split(' / ')[0]).toBe(String(await heroHp()));

  // A notice for a message from the rules (dropping bread), and the pack changes.
  await lw(page, `lw.command({ t: 'drop', uid: lw.player.hero.inv.find((i) => i.id === 'bread').uid })`);
  await expect(page.getByTestId('notice').filter({ hasText: 'Dropped' })).toBeVisible();

  // A fight: a wolf goes for the traveller; the traveller swings (the client's own attack). The target frame shows
  // the wolf's real health; damage taken shows on the plate.
  await lw(page, `(() => { const p = lw.player; lw.sim.wildlife.raiseGuardian('hud-wolf', 'wolf', p.x + 2, p.y, p, lw.sim.clock); })()`);
  await expect.poll(async () => { await lw(page, 'lw.attack()'); return lw<boolean>(page, `lw.sim.wildlife.creatures.get('hud-wolf').hp < 55`); }, { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId('target-name')).toHaveText('Wolf');
  await expect.poll(async () => (await page.getByTestId('target-hp').textContent())!.split(' / ')[0], { timeout: 3_000 })
    .toBe(String(Math.ceil(await lw<number>(page, `Math.max(0, lw.sim.wildlife.creatures.get('hud-wolf').hp)`))));
  await expect.poll(() => lw<boolean>(page, 'lw.player.hero.hp < 78'), { timeout: 20_000 }).toBe(true); // bitten
  await expect.poll(async () => (await plateHp())!.split(' / ')[0], { timeout: 3_000 }).toBe(String(await heroHp()));
  // Finish it: the frame says slain; experience reaches the plate.
  const progress = () => lw<number>(page, 'lw.player.hero.level * 1e6 + lw.player.hero.xp'); // xp restarts at each level
  const xp0 = await progress();
  await expect.poll(async () => { await lw(page, `(() => { const c = lw.sim.wildlife.creatures.get('hud-wolf'); lw.player.x = c.x - 1.2; lw.player.y = c.y; lw.player.hero.hp = Math.max(lw.player.hero.hp, 40); lw.attack(); })()`); return lw<boolean>(page, `!lw.sim.wildlife.creatures.get('hud-wolf').alive`); }, { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId('target-frame')).toContainText('slain');
  expect(await progress()).toBeGreaterThan(xp0);
  await expect(page.getByTestId('hud-level')).toHaveText(`Lv ${await lw<number>(page, 'lw.player.hero.level')}`);
  await expect.poll(async () => (await page.getByTestId('hud-xp').textContent())!.split(' / ')[0]).toBe(String(await lw<number>(page, 'lw.player.hero.xp')));

  // A quest from a real giver: talk, accept; the tracker shows it with its progress.
  await lw(page, `(() => { const p = lw.player, v = [...lw.sim.villages.people.values()].filter((v) => v.out && lw.sim.rpg.isGiver(v)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]; p.x = v.x + 1; p.y = v.y; lw.command({ t: 'talk', vid: v.id }); lw.command({ t: 'accept' }); })()`);
  const title = await lw<string>(page, 'lw.player.hero.quests[0].title');
  await expect(page.getByTestId('tracker-quest').first()).toContainText(title);

  // A level-up (the rules' experience): the banner, the level and the points on the plate.
  await lw(page, '(() => { lw.sim.rpg.xp(lw.player, 400); lw.processEvents(); })()');
  await expect(page.getByTestId('level-banner')).toBeVisible();
  const level = await lw<number>(page, 'lw.player.hero.level');
  expect(level).toBeGreaterThan(1);
  await expect(page.getByTestId('hud-level')).toHaveText(`Lv ${level}`);
  await expect(page.getByTestId('hud-points')).toHaveText(`+${await lw<number>(page, 'lw.player.hero.points')}`);

  // The interaction prompt: next to a villager it says so, and clicking it talks to them (as E does).
  await lw(page, `(() => { const p = lw.player, v = [...lw.sim.villages.people.values()].find((v) => v.out); p.x = v.x + 1; p.y = v.y; })()`);
  await expect(page.getByTestId('hud-prompt')).toContainText('Talk to', { timeout: 5_000 });
  const before = await lw<number>(page, 'lw.recent.length ? lw.recent.at(-1).seq : 0');
  await page.getByTestId('hud-prompt').click();
  await expect.poll(() => lw<boolean>(page, `lw.recent.some((r) => r.seq > ${before} && r.ev.e === 'msg')`)).toBe(true);
  expect(errors).toEqual([]);
});

// A phone's screen, touch and pointer (in Chromium, the browser these tests use).
const { defaultBrowserType: _browser, ...phone } = devices['iPhone 13'];
void _browser;

test.describe('on a phone', () => {
  test.use(phone);
  test('touch controls: the stick walks the traveller, Dodge dodges', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/?scene=continent');
    await ready(page);
    await expect(page.getByTestId('touch-controls')).toBeVisible();
    await expect(page.getByTestId('hud-level')).toBeVisible();
    // Find an open direction (the server-free single player checks walls too), then push the stick that way.
    const dir = await lw<[number, number]>(page, `[[1,0],[0,1],[-1,0],[0,-1]].find(([dx, dy]) => Array.from({ length: 8 }, (_, k) => k + 1).every((k) => lw.q.walkable(lw.player.x + dx * k, lw.player.y + dy * k)))`);
    const x0 = await lw<number>(page, 'lw.player.x'), y0 = await lw<number>(page, 'lw.player.y');
    const box = (await page.locator('.rpg-stick').boundingBox())!, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.locator('.rpg-stick').dispatchEvent('pointerdown', { clientX: cx + dir[0] * 40, clientY: cy + dir[1] * 40, pointerId: 7, pointerType: 'touch', buttons: 1 });
    await page.waitForTimeout(1200);
    await page.locator('.rpg-stick').dispatchEvent('pointerup', { clientX: cx, clientY: cy, pointerId: 7, pointerType: 'touch' });
    const moved = await lw<number>(page, `Math.hypot(lw.player.x - ${x0}, lw.player.y - ${y0})`);
    expect(moved).toBeGreaterThan(1);
    expect(await lw<unknown>(page, 'lw.input')).toBeNull(); // released: the keyboard (none here) is back in charge
    const d0 = await lw<number>(page, 'lw.player.hero.dodgeT');
    await page.getByRole('button', { name: 'Dodge' }).click();
    await expect.poll(() => lw<number>(page, 'lw.player.hero.dodgeT')).not.toBe(d0);
  });
});
