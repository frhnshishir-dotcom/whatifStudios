import { test, expect } from '@playwright/test';

/**
 * The living world in the browser, single player: a traveller in Lumenfall among its villagers, walking with the
 * keyboard, wildlife simulated and drawn around them, a find taken with E, a dragon flying on its own and watched with F.
 */
test('a traveller in Lumenfall: villagers, keyboard walking, wildlife, a find, a dragon', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?scene=continent&layout=sandbox');
  await page.waitForFunction(() => (window as any).__lumenwild?.getEngine()?.streamer?.life?.sim.villages.people.size > 0, null, { timeout: 90_000 });
  await page.evaluate(() => { const e = (window as any).__lumenwild.getEngine(); e.env.set({ time: 10 }); e.env.settle(); });
  const lw = <T,>(f: string) => page.evaluate((f) => new Function('lw', `return (${f})`)((window as any).__lumenwild.getEngine().streamer.life), f) as Promise<T>;

  // Villagers are out at mid-morning, near the traveller, and listed in the panel.
  await expect.poll(() => lw<number>(`[...lw.sim.villages.people.values()].filter((v) => v.out && Math.hypot(v.x - lw.player.x, v.y - lw.player.y) < 150).length`), { timeout: 15_000 }).toBeGreaterThan(5);
  await expect(page.getByTestId('life-nearby')).toContainText('villager', { timeout: 10_000 });

  // Walk with the keyboard for two seconds, in a direction that is open for 12 m (Lumenfall has walls and fences).
  const key = await lw<string>(`(() => {
    const p = lw.player, dirs = [['d', 1, 0], ['s', 0, 1], ['a', -1, 0], ['w', 0, -1]];
    for (const [k, dx, dy] of dirs) { let ok = true; for (let m = 1; m <= 12 && ok; m++) ok = lw.q.walkable(p.x + dx * m, p.y + dy * m); if (ok) return k; }
    return 'd';
  })()`);
  const at0 = await lw<[number, number]>('[lw.player.x, lw.player.y]');
  await page.keyboard.down(key);
  await page.waitForTimeout(2000);
  await page.keyboard.up(key);
  const at1 = await lw<[number, number]>('[lw.player.x, lw.player.y]');
  const walked = Math.hypot(at1[0] - at0[0], at1[1] - at0[1]);
  expect(walked).toBeGreaterThan(4);

  // Wildlife: simulated in full detail around the traveller, and drawn by the life layer.
  await expect.poll(() => lw<number>('lw.sim.wildlife.stats.detailed'), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await lw<number>('lw.layer.drawn')).toBeGreaterThan(0);

  // A find: stand by the nearest cache in the loaded area, see the prompt, press E, and it is in the pack.
  const cache = await lw<{ x: number; y: number; variant: string } | null>(`(() => {
    const s = lw.session, S = s.win.S, [ox, oy] = s.win.origin, p = lw.player;
    let best = null, bd = Infinity;
    for (const o of lw.engine.objects.objects.values()) if (o.kind === 'cache') { const x = o.x + ox * S, y = o.y + oy * S, d = Math.hypot(x - p.x, y - p.y); if (d < bd) { bd = d; best = { x, y, variant: o.variant }; } }
    if (best) { p.x = best.x + 0.5; p.y = best.y + 2; }
    return best;
  })()`);
  expect(cache).not.toBeNull();
  await expect(page.getByTestId('life-prompt')).toContainText('Take the', { timeout: 10_000 });
  await page.keyboard.press('e');
  await expect(page.getByTestId('life-inventory')).not.toHaveText('empty', { timeout: 10_000 });

  // Dragons fly on their own: Emberfang (migrating at the start) has moved over a few seconds.
  const d0 = await lw<[number, number]>(`(() => { const d = lw.sim.dragons.dragons.find((d) => d.st === 'migrate') ?? lw.sim.dragons.dragons[0]; return [d.x, d.y]; })()`);
  await page.waitForTimeout(3000);
  const d1 = await lw<[number, number]>(`(() => { const d = lw.sim.dragons.dragons.find((d) => Math.hypot(d.x - ${d0[0]}, d.y - ${d0[1]}) < 400) ?? lw.sim.dragons.dragons[0]; return [d.x, d.y]; })()`);
  expect(Math.hypot(d1[0] - d0[0], d1[1] - d0[1])).toBeGreaterThan(20);
  // F watches the nearest dragon: the view goes there and the dragon is drawn by the dragon renderer.
  await page.keyboard.press('f');
  expect(await lw<string>('lw.follow')).not.toBe('player');
  await expect.poll(() => lw<number>('lw.stats.puppets'), { timeout: 30_000 }).toBeGreaterThan(0);
  // Moving returns to the traveller.
  await page.keyboard.down('a'); await page.waitForTimeout(300); await page.keyboard.up('a');
  expect(await lw<string>('lw.follow')).toBe('player');

  // Budget: the living world's share of a frame stays small.
  const ms = await lw<number>('lw.stats.frameMs');
  console.log(`living world: walked ${walked.toFixed(1)} m; found ${cache!.variant}; life frame ${ms.toFixed(2)} ms; wildlife ${await lw<number>('lw.sim.stats.wildlifeMs')} ms/tick`);
  expect(ms).toBeLessThan(15);
  expect(errors).toEqual([]);
});
