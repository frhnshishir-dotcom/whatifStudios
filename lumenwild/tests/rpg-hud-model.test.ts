import { describe, it, expect, beforeAll } from 'vitest';
import { createContinentEngine } from '../src/boot';
import type { LivingWorld } from '../src/world/life/client';
import type { Creature } from '../src/world/life/wildlife';
import { addItem, type QuestState } from '../src/world/rpg/hero';
import { makeItem } from '../src/world/rpg/items';
import type { RpgEvent } from '../src/world/rpg/Rpg';
import { CREATURE_COMBAT } from '../src/world/rpg/content';
import { NoticeReader, TargetPicker, questProgress } from '../src/ui/rpg/hudModel';

/** The HUD's view of the game (step 3): quest progress, notices and the target are read from the real state. */
let lw: LivingWorld;
beforeAll(() => { lw = createContinentEngine({ worker: false }).life!; }, 60_000);
const ev = (...evs: RpgEvent[]) => { lw.processEvents(evs); };

function wolf(id: string, dx: number): Creature {
  const p = lw.player;
  const c: Creature = { id, kind: 'creature', sp: 'wolf', tag: 'wolf', x: p.x + dx, y: p.y, alt: 0, alive: true, h: 0, st: 'idle', stT: 0, next: 1e9, tx: p.x + dx, ty: p.y, target: null,
    hunger: 0.1, thirst: 0.1, energy: 0.9, stamina: 1, homeX: p.x + dx, homeY: p.y, group: id, leader: true, male: true, look: 0.3, alert: 0, diedAt: -1, tier: 0, water: null, hp: CREATURE_COMBAT.wolf.hp, foe: null, atkT: 0 };
  lw.sim.wildlife.creatures.set(id, c);
  return c;
}

describe('HUD model', () => {
  it('quest progress counts what the rules count', () => {
    const h = lw.player.hero;
    const q: QuestState = { id: 'q1', giver: 'v', giverName: 'Mira', village: 'lumenfall', kind: 'gather', title: 'Wood for winter', text: '', target: 'wood', targetName: 'wood', need: 5, have: 0, reward: { xp: 10, coins: 5 }, status: 'active' };
    expect(questProgress(h, q)).toEqual({ have: 0, need: 5, ready: false });
    addItem(h, makeItem('wood', 3, 'u9001'));
    expect(questProgress(h, q)).toEqual({ have: 3, need: 5, ready: false });
    addItem(h, makeItem('wood', 4, 'u9002'));
    expect(questProgress(h, q)).toEqual({ have: 5, need: 5, ready: true }); // capped at the need
    const hunt: QuestState = { ...q, id: 'q2', kind: 'bounty', target: 'wolf', need: 3, have: 1 };
    expect(questProgress(h, hunt)).toEqual({ have: 1, need: 3, ready: false });
    expect(questProgress(h, { ...hunt, status: 'ready', have: 3 }).ready).toBe(true);
  });

  it('notices: the player\'s messages and skills, and new journal lines; nothing old, nothing twice, nobody else\'s', () => {
    const r = new NoticeReader();
    ev({ e: 'msg', who: 'local', text: 'before' });
    lw.sim.note('An old line.');
    expect(r.read(lw, 0)).toEqual([]); // the first read only marks what is there
    ev({ e: 'msg', who: 'local', text: 'Dropped Bread.' }, { e: 'msg', who: 'someone-else', text: 'not mine' }, { e: 'skill', who: 'local', skill: 'woodcutting', level: 2 });
    lw.sim.note('Discovered: Lumenfall Village.');
    lw.sim.note(`${lw.player.name} completed “Wood for winter”.`); // told by the quest's own message
    lw.sim.note(`${lw.player.name} reached level 2.`); // told by the level banner
    lw.sim.note('Dropped Bread.'); // same words as a message: once
    const got = r.read(lw, 1).map((n) => [n.kind, n.text]);
    expect(got).toEqual([['msg', 'Dropped Bread.'], ['skill', 'Woodcutting is now 2.'], ['world', 'Discovered: Lumenfall Village.']]);
    expect(r.read(lw, 2)).toEqual([]);
  });

  it('the target: the creature last hit or hurting the player, with its real health; gone after a fight ends', () => {
    const t = new TargetPicker(), c = wolf('hud-wolf', 3);
    expect(t.pick(lw, 0)).toBeNull();
    c.hp = 17;
    ev({ e: 'hit', who: 'local', target: c.id, dmg: 6, crit: false, x: c.x, y: c.y });
    const a = t.pick(lw, 1)!;
    expect(a.c).toBe(c);
    expect(a.hp).toBe(17); expect(a.max).toBe(CREATURE_COMBAT.wolf.hp);
    // Someone else's blow does not change the target; a wolf biting the player becomes it.
    const c2 = wolf('hud-wolf-2', -3);
    ev({ e: 'hit', who: 'someone-else', target: c2.id, dmg: 2, crit: false, x: c2.x, y: c2.y });
    expect(t.pick(lw, 2)!.c).toBe(c);
    ev({ e: 'hurt', who: 'local', by: c2.id, dmg: 4, x: lw.player.x, y: lw.player.y });
    expect(t.pick(lw, 3)!.c).toBe(c2);
    // Eight quiet seconds and no fight: nothing shown.
    expect(t.pick(lw, 12)).toBeNull();
    // Slain: shown as slain for 2.5 s, then gone.
    ev({ e: 'hit', who: 'local', target: c.id, dmg: 99, crit: true, x: c.x, y: c.y });
    c.alive = false; c.hp = 0;
    const s = t.pick(lw, 13)!;
    expect(s.slain).toBe(true); expect(s.hp).toBe(0);
    expect(t.pick(lw, 15)!.slain).toBe(true);
    expect(t.pick(lw, 16)).toBeNull();
    // Single player: a creature that has the player as its foe is the target without a blow.
    const c3 = wolf('hud-wolf-3', 4); c3.foe = lw.player.id;
    expect(t.pick(lw, 20)!.c).toBe(c3);
    expect(t.pick(lw, 20)!.hostile).toBe(true);
    for (const id of ['hud-wolf', 'hud-wolf-2', 'hud-wolf-3']) lw.sim.wildlife.creatures.delete(id);
  });
});
