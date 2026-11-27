import { describe, it, expect } from 'vitest';
import { createContinentEngine } from '../src/boot';
import { WorldServer } from '../server/WorldServer';

/**
 * The RPG interface's link to the game (docs/audit/RPG_UI_AUDIT.md, step 1). The interface reads the character from
 * the living world and is told when to look again. Offline, rules events and commands raise the revision. Online,
 * a command changes nothing here: only the server's answer does.
 */
describe('the RPG interface link', { timeout: 120_000 }, () => {
  it('single player: commands and rules events raise the revision and reach listeners', () => {
    const { life } = createContinentEngine({ worker: false });
    const lw = life!;
    let calls = 0;
    const off = lw.subscribe(() => { calls++; });
    const r0 = lw.revision;
    // Equipping and unequipping emit no event of their own: the command itself counts as a change.
    lw.command({ t: 'unequip', slot: 'weapon' });
    expect(lw.player.hero.equip.weapon).toBeUndefined();
    expect(lw.revision).toBeGreaterThan(r0);
    expect(calls).toBeGreaterThan(0);
    // A rules event (as the rules or the server produce them) is kept for notices and raises the revision.
    const r1 = lw.revision, c1 = calls;
    lw.sim.rpg.events.push({ e: 'xp', who: 'local', n: 12 });
    lw.processEvents();
    expect(lw.revision).toBe(r1 + 1);
    expect(calls).toBe(c1 + 1);
    expect(lw.recent.at(-1)!.ev).toEqual({ e: 'xp', who: 'local', n: 12 });
    // Frames without events do not disturb the interface.
    const r2 = lw.revision;
    lw.processEvents([]);
    expect(lw.revision).toBe(r2);
    // The buffer keeps the latest 60, numbered in order.
    for (let k = 0; k < 70; k++) lw.sim.rpg.events.push({ e: 'msg', who: 'local', text: `m${k}` });
    lw.processEvents();
    expect(lw.recent.length).toBe(60);
    expect(lw.recent.at(-1)!.ev).toEqual({ e: 'msg', who: 'local', text: 'm69' });
    expect(lw.recent.every((r, k) => k === 0 || r.seq === lw.recent[k - 1].seq + 1)).toBe(true);
    off();
    const c3 = calls;
    lw.command({ t: 'equip', uid: lw.player.hero.inv.find((i) => i.id === 'knife')!.uid });
    expect(calls).toBe(c3); // unsubscribed
    expect(lw.player.hero.equip.weapon?.id).toBe('knife');
  });

  it('online: the interface changes when the server says so, not when the command is sent', async () => {
    const server = new WorldServer({ port: 0, dataFile: null });
    const port = await server.listen();
    const { life } = createContinentEngine({ worker: false, server: `ws://127.0.0.1:${port}`, name: 'Ada' });
    const lw = life!;
    const revs: number[] = [];
    lw.subscribe(() => revs.push(lw.revision));
    for (let k = 0; k < 200 && !lw.net!.connected; k++) await new Promise((r) => setTimeout(r, 25));
    expect(lw.net!.connected).toBe(true);
    expect(revs.length).toBeGreaterThan(0); // the welcome
    await new Promise((r) => setTimeout(r, 300)); // the first character message
    const r0 = lw.revision;
    expect(lw.player.hero.equip.weapon?.id).toBe('knife');
    lw.command({ t: 'unequip', slot: 'weapon' });
    // Sent, not applied: the client's character and revision are untouched until the server answers.
    expect(lw.player.hero.equip.weapon?.id).toBe('knife');
    expect(lw.revision).toBe(r0);
    for (let k = 0; k < 200 && lw.player.hero.equip.weapon; k++) await new Promise((r) => setTimeout(r, 25));
    expect(lw.player.hero.equip.weapon).toBeUndefined(); // the server's character arrived
    expect(lw.player.hero.inv.some((i) => i.id === 'knife')).toBe(true);
    expect(lw.revision).toBeGreaterThan(r0);
    // The server's own record agrees.
    expect(server.sim.players.get(lw.net!.id)!.hero.equip.weapon).toBeUndefined();
    lw.net!.close();
    lw.dispose();
    await server.stop();
  });
});
