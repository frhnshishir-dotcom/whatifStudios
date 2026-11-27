import { describe, it, expect } from 'vitest';
import { createContinentEngine } from '../src/boot';

/**
 * Naming the traveller (RPG interface step 4). The name has always been written into continent saves
 * (life.players[].name); it now also comes back when the save is loaded. No save format change.
 */
describe('the traveller\'s name', { timeout: 120_000 }, () => {
  it('renames in single player, within the rules for a name', () => {
    const lw = createContinentEngine({ worker: false }).life!;
    expect(lw.player.name).toBe('Traveller');
    let calls = 0;
    lw.subscribe(() => calls++);
    expect(lw.rename('  Elowen   of  the Vale ')).toBe(true);
    expect(lw.player.name).toBe('Elowen of the Vale');
    expect(calls).toBe(1);
    for (const bad of ['', '   ', '-dash first', 'x'.repeat(25), 'Bad<tag>', 'semi;colon']) expect(lw.rename(bad)).toBe(false);
    expect(lw.player.name).toBe('Elowen of the Vale');
    expect(lw.rename("Aël O'Dunn-Mere Jr.")).toBe(true);
  });

  it('is written to the save and comes back on load; older saves keep "Traveller"', () => {
    const a = createContinentEngine({ worker: false }).life!;
    a.rename('Elowen');
    const saved = JSON.parse(JSON.stringify(a.sim.toJSON()));
    expect((saved.players as Array<{ name: string }>)[0].name).toBe('Elowen');
    const b = createContinentEngine({ worker: false }).life!;
    expect(b.player.name).toBe('Traveller');
    expect(b.sim.load(saved)).toEqual([]);
    expect(b.player.name).toBe('Elowen');
    // A save written before naming existed holds "Traveller" (the fixed name): it loads as it was.
    const old = JSON.parse(JSON.stringify(saved)); old.players[0].name = 'Traveller';
    const c = createContinentEngine({ worker: false }).life!;
    c.sim.load(old);
    expect(c.player.name).toBe('Traveller');
  });
});
