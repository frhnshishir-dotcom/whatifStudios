import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain } from '../src/world/terrain';
import { LifeSim, type Player } from '../src/world/life/LifeSim';
import type { TerrainQuery } from '../src/world/life/core';
import type { Creature, Species } from '../src/world/life/wildlife';
import type { Villager } from '../src/world/life/villagers';
import { CREATURE_COMBAT, RECIPES } from '../src/world/rpg/content';
import { ITEMS, makeItem, rng, itemValue, type Item } from '../src/world/rpg/items';
import { newHero, addItem, count, equip, unequip, gainXp, practise, sLevel, maxHp, heroToJSON, heroFromJSON, xpToNext, BAG, attackDamage, nextUid } from '../src/world/rpg/hero';

/**
 * The RPG rules: items, the character, combat with the existing creature AI, death and respawn, gathering, crafting
 * at village stations, shops, quests and trade between players. Synthetic flat meadow for the combat rules; the real
 * continent (Lumenfall's buildings and people) for stations, shops and quests.
 */
let bp: Blueprint, ct: ContinentTerrain;
beforeAll(() => { bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp); }, 60_000);

const meadow: TerrainQuery = { height: () => 100, water: () => false, walkable: () => true, biome: () => 'heartlands', detailed: () => true };

function sim(hour = 12): LifeSim { const s = new LifeSim(bp, ct, meadow); s.clock.hour = hour; (s as unknown as { lastPopulate: number }).lastPopulate = 1e12; return s; }
let n = 0;
function beast(s: LifeSim, sp: Species, x: number, y: number, extra: Partial<Creature> = {}): Creature {
  const id = `${sp}-t${n++}`;
  const c: Creature = { id, kind: 'creature', sp, tag: sp, x, y, alt: 0, alive: true, h: 0, st: 'idle', stT: 0, next: 0, tx: x, ty: y, target: null, hunger: 0.1, thirst: 0.1, energy: 0.9, stamina: 1, homeX: x, homeY: y, group: id, leader: true, male: true, look: 0.3, alert: 0, diedAt: -1, tier: 0, water: null, hp: CREATURE_COMBAT[sp].hp, foe: null, atkT: 0, ...extra };
  s.wildlife.creatures.set(id, c);
  return c;
}
const run = (s: LifeSim, seconds: number) => { for (let t = 0; t < seconds; t += 0.1) s.update(0.1, { hour: s.clock.hour, rain: 0 }); };
const msgs = (s: LifeSim) => s.rpg.drain().filter((e) => e.e === 'msg').map((e) => (e as { text: string }).text);
/** Swing at a creature until it falls (or `max` swings). */
function fight(s: LifeSim, p: Player, c: Creature, max = 80): number {
  let k = 0;
  for (; k < max && c.alive; k++) { p.x = c.x - 1.2; p.y = c.y; s.rpg.command(p.id, { t: 'attack', h: 0 }); run(s, 0.7); }
  return k;
}

describe('items and the character', () => {
  it('rarity, stacking, the 24-slot pack, equipment, levels and skills', () => {
    const r = rng(7), rolled = Array.from({ length: 400 }, (_, k) => makeItem('iron-sword', 1, `x${k}`, r));
    const by = [0, 1, 2, 3, 4].map((q) => rolled.filter((i) => i.r === q).length);
    expect(by[0]).toBeGreaterThan(by[1]); expect(by[1]).toBeGreaterThan(by[2]); expect(by[2]).toBeGreaterThan(by[4]);
    expect(rolled.filter((i) => i.r >= 2).every((i) => i.props && Object.keys(i.props).length >= 1)).toBe(true);
    expect(itemValue(rolled.find((i) => i.r === 3)!)).toBeGreaterThan(itemValue(rolled.find((i) => i.r === 0)!));
    const h = newHero([0, 0], 'Home');
    expect(h.equip.weapon?.id).toBe('knife');
    expect(count(h, 'bread')).toBe(3);
    addItem(h, makeItem('wood', 45, nextUid(h))); addItem(h, makeItem('wood', 30, nextUid(h)));
    expect(count(h, 'wood')).toBe(75);
    expect(h.inv.filter((i) => i.id === 'wood').length).toBe(2); // stacks of 50
    for (let k = 0; h.inv.length < BAG; k++) addItem(h, makeItem('iron-dagger', 1, nextUid(h)));
    expect(addItem(h, makeItem('iron-helm', 1, nextUid(h)))).toBe(false);
    const dmg0 = attackDamage(h), sword = makeItem('iron-sword', 1, nextUid(h), null, 2);
    h.inv.pop(); addItem(h, sword);
    expect(equip(h, sword.uid)).toBeNull();
    expect(h.equip.weapon!.id).toBe('iron-sword');
    expect(attackDamage(h)).toBeGreaterThan(dmg0 * 2);
    expect(h.inv.some((i) => i.id === 'knife')).toBe(true); // swapped back into the pack
    expect(unequip(h, 'weapon')).toBe('Your pack is full.');
    const hp1 = maxHp(h);
    expect(gainXp(h, xpToNext(1) + xpToNext(2))).toBe(2);
    expect(h.level).toBe(3); expect(h.points).toBe(4); expect(maxHp(h)).toBeGreaterThan(hp1);
    expect(practise(h, 'mining', 20)).toBe(2);
    expect(sLevel(h, 'mining')).toBe(2);
    const back = heroFromJSON(JSON.parse(JSON.stringify(heroToJSON(h))), newHero([5, 5], 'x'));
    expect(back.level).toBe(3); expect(back.inv.length).toBe(h.inv.length); expect(back.equip.weapon!.uid).toBe(sword.uid); expect(back.skills.mining).toBe(20);
  });
});

describe('combat with the living creatures', { timeout: 60_000 }, () => {
  it('a wolf fights back, falls, drops loot; experience, skills and the bounty count', () => {
    const s = sim(12), p = s.addPlayer('p', 'Tester', 1000, 1000);
    const wolf = beast(s, 'wolf', 1001.5, 1000);
    p.hero.quests.push({ id: 'q', giver: 'g', giverName: 'G', village: 'lumenfall', kind: 'bounty', title: 'Hunt a wolf', text: '', target: 'wolf', targetName: 'wolf', need: 1, have: 0, reward: { xp: 1, coins: 1 }, status: 'active' });
    const hp0 = p.hero.hp, swings = fight(s, p, wolf);
    expect(wolf.alive).toBe(false);
    expect(swings).toBeGreaterThan(3); // 55 health against a knife
    expect(p.hero.hp).toBeLessThan(hp0); // it bit back
    expect(p.hero.stats.kills.wolf).toBe(1);
    expect(p.hero.xp).toBeGreaterThanOrEqual(CREATURE_COMBAT.wolf.xp); // level 2 needs 60
    expect(p.hero.skills.melee).toBeGreaterThan(0); expect(p.hero.skills.hunting).toBeGreaterThan(0);
    expect(p.hero.quests[0].status).toBe('ready');
    const bag = [...s.rpg.loot.values()].find((g) => g.owner === 'p')!;
    expect(bag.items.length).toBeGreaterThan(0);
    p.x = bag.x; p.y = bag.y;
    s.rpg.command('p', { t: 'pickup', id: bag.id });
    expect(s.rpg.loot.has(bag.id)).toBe(false);
    expect(count(p.hero, 'wolf-pelt') + count(p.hero, 'fang')).toBeGreaterThan(0);
  });

  it('a deer runs when hurt; wolves hunt a traveller at night; a dodge makes bites miss', () => {
    const s = sim(12);
    s.addPlayer('p', 'Tester', 2000, 2000);
    const deer = beast(s, 'deer', 2001.5, 2000);
    s.rpg.command('p', { t: 'attack', h: 0 });
    run(s, 1);
    expect(deer.st).toBe('flee');
    expect(deer.hp).toBeLessThan(CREATURE_COMBAT.deer.hp);
    const s2 = sim(23), p2 = s2.addPlayer('p', 'Tester', 3000, 3000);
    const pack = [0, 1, 2].map((k) => beast(s2, 'wolf', 3014, 3000 + k * 2, { group: 'pack', leader: k === 0 }));
    run(s2, 2);
    expect(pack.every((w) => w.st === 'fight' && w.foe === 'p')).toBe(true);
    // Keep dodging while they close in: some bites are evaded.
    let evaded = 0;
    for (let k = 0; k < 40; k++) { p2.stamina = 1; s2.rpg.command('p', { t: 'dodge', h: Math.PI }); s2.update(0.1, { hour: 23, rain: 0 }); evaded += s2.rpg.drain().filter((e) => e.e === 'evade').length; p2.x = 3000; p2.y = 3000; }
    expect(evaded).toBeGreaterThan(0);
    expect(p2.hero.skills.defence).toBeGreaterThan(0);
  });

  it('a traveller who falls drops some coins and wakes at home with full health', () => {
    const s = sim(12), p = s.addPlayer('p', 'Tester', 4000, 4000);
    p.hero.home = [4100, 4100]; p.hero.homeName = 'Testholm'; p.hero.coins = 100;
    const bear = beast(s, 'bear', 4001.5, 4000);
    p.hero.hp = 5;
    s.wildlife.provoke(bear, p, s.clock);
    run(s, 3);
    expect(p.hero.dead).toBeGreaterThanOrEqual(0);
    expect(p.alive).toBe(false);
    expect(p.hero.coins).toBe(90);
    expect([...s.rpg.loot.values()].some((g) => g.coins === 10)).toBe(true);
    expect(bear.st).not.toBe('fight'); // nothing left to fight
    run(s, 6);
    expect(p.hero.dead).toBe(-1);
    expect(p.alive).toBe(true);
    expect(Math.hypot(p.x - 4100, p.y - 4102)).toBeLessThan(1);
    expect(p.hero.hp).toBe(maxHp(p.hero));
    expect(p.hero.stats.deaths).toBe(1);
  });

  it('creatures killed come back after a while (when nobody is watching)', () => {
    const s = sim(12), p = s.addPlayer('p', 'Tester', 5000, 5000);
    const fox = beast(s, 'fox', 5001, 5000, { homeX: 5400, homeY: 5000 });
    for (let k = 0; k < 20 && fox.alive; k++) { p.x = fox.x - 1; p.y = fox.y; s.rpg.command('p', { t: 'attack', h: 0 }); run(s, 0.5); fox.x = 5001; fox.y = 5000; }
    expect(fox.alive).toBe(false);
    s.clock.t += 700; p.x = 4000;
    run(s, 1.2);
    expect(fox.alive).toBe(true); expect(fox.hp).toBe(CREATURE_COMBAT.fox.hp);
  });
});

describe('gathering, crafting, shops, quests and trade (Lumenfall)', { timeout: 120_000 }, () => {
  function lumenfall() {
    const s = sim(11), v = ct.village('lumenfall')!;
    s.populateVillages([{ x: v.cx, y: v.cy }]);
    for (const x of s.villages.people.values()) x.out = true;
    const p = s.addPlayer('p', 'Tester', v.square.x, v.square.y);
    return { s, v, p };
  }
  const job = (s: LifeSim, tag: string) => [...s.villages.people.values()].find((v) => v.village === 'lumenfall' && v.tag === tag) as Villager;

  it('crafting needs the materials, the skill and the right station (the smithy’s forge)', () => {
    const { s, v, p } = lumenfall();
    addItem(p.hero, makeItem('herbs', 4, nextUid(p.hero)));
    s.rpg.command('p', { t: 'craft', recipe: 'poultice' });
    expect(count(p.hero, 'poultice')).toBe(1);
    addItem(p.hero, makeItem('ore', 6, nextUid(p.hero))); addItem(p.hero, makeItem('wood', 2, nextUid(p.hero)));
    p.x = v.square.x; p.y = v.square.y + 200; // out in the fields
    s.rpg.command('p', { t: 'craft', recipe: 'iron-bar' });
    expect(msgs(s).join()).toMatch(/need a forge/);
    const smithy = v.buildings.find((b) => b.type === 'smithy')!;
    expect(smithy).toBeDefined();
    p.x = smithy.x + smithy.w / 2; p.y = smithy.y + smithy.d + 1;
    expect(s.rpg.stationsNear(p.x, p.y).has('forge')).toBe(true);
    for (let k = 0; k < 3; k++) s.rpg.command('p', { t: 'craft', recipe: 'iron-bar' });
    expect(count(p.hero, 'iron-bar')).toBe(3);
    s.rpg.command('p', { t: 'craft', recipe: 'iron-dagger' });
    expect(count(p.hero, 'iron-dagger')).toBe(1);
    expect(p.hero.stats.crafted).toBe(5);
    expect(p.hero.skills.smithing).toBeGreaterThan(0);
    expect(RECIPES.every((r) => ITEMS[r.out] && r.inputs.every(([id]) => ITEMS[id]))).toBe(true);
  });

  it('a blacksmith sells and buys; prices follow value, demand and trading skill', () => {
    const { s, p } = lumenfall();
    const smith = job(s, 'blacksmith');
    p.x = smith.x + 1; p.y = smith.y;
    p.hero.coins = 500;
    s.rpg.command('p', { t: 'talk', vid: smith.id });
    const view = s.rpg.viewFor('p');
    expect(view.shop).toBe(smith.id);
    const k = view.stock.findIndex((e) => e.item.id === 'iron-sword');
    const price = s.rpg.buyPrice(p, view.stock[k]);
    s.rpg.command('p', { t: 'buy', vid: smith.id, idx: k });
    expect(count(p.hero, 'iron-sword')).toBe(1);
    expect(p.hero.coins).toBe(500 - price);
    const sword = p.hero.inv.find((i) => i.id === 'iron-sword') as Item;
    const back = s.rpg.sellPrice(p, smith.id, sword);
    expect(back).toBeGreaterThan(0); expect(back).toBeLessThan(price);
    s.rpg.command('p', { t: 'sell', vid: smith.id, uid: sword.uid });
    expect(count(p.hero, 'iron-sword')).toBe(0);
    expect(p.hero.coins).toBe(500 - price + back);
    expect(s.rpg.viewFor('p').stock[k].left).toBe(0); // one of each piece of gear per restock
  });

  it('quests: offered by villagers with work, accepted, progressed by hunting, rewarded on return; persistent', () => {
    const { s, p } = lumenfall();
    const giver = [...s.villages.people.values()].find((v) => v.village === 'lumenfall' && s.rpg.isGiver(v) && ['hunter', 'warden', 'lookout', 'farmer', 'herder', 'trapper'].includes(v.tag) && s.rpg.questFrom(p, v)?.kind === 'bounty')!;
    expect(giver).toBeDefined();
    const q1 = s.rpg.questFrom(p, giver)!, q2 = s.rpg.questFrom(p, giver)!;
    expect(q1).toEqual(q2); // deterministic
    p.x = giver.x + 1; p.y = giver.y;
    s.rpg.command('p', { t: 'talk', vid: giver.id });
    expect(s.rpg.viewFor('p').offer?.id).toBe(q1.id);
    s.rpg.command('p', { t: 'accept' });
    expect(p.hero.quests.map((q) => q.id)).toEqual([q1.id]);
    // Hunt what was asked, far from the village.
    p.hero.equip.weapon = makeItem('knight-sword', 1, nextUid(p.hero), null, 3);
    for (let k = 0; k < q1.need; k++) { const c = beast(s, q1.target as Species, 9000, 9000 + k * 30); fight(s, p, c); expect(c.alive).toBe(false); }
    expect(p.hero.quests[0].status).toBe('ready');
    // Saved and loaded mid-quest: still there.
    const j = JSON.parse(JSON.stringify(s.toJSON()));
    const s2 = sim(11); s2.addPlayer('p', 'Tester', 0, 0); s2.load(j);
    expect(s2.players.get('p')!.hero.quests[0].status).toBe('ready');
    const coins = p.hero.coins, xp = p.hero.xp + p.hero.level * 1e6;
    p.x = giver.x + 1; p.y = giver.y;
    s.rpg.command('p', { t: 'talk', vid: giver.id });
    expect(msgs(s).join()).toMatch(/Quest complete/);
    expect(p.hero.quests.length).toBe(0);
    expect(p.hero.coins).toBe(coins + q1.reward.coins);
    expect(p.hero.xp + p.hero.level * 1e6).toBeGreaterThan(xp);
    expect(p.hero.done[giver.id]).toBe(1);
    expect(s.rpg.questFrom(p, giver)!.id).not.toBe(q1.id); // the next one
  });

  it('two players trade: items and coins change hands at once, or not at all', () => {
    const s = sim(12), a = s.addPlayer('a', 'Ada', 100, 100), b = s.addPlayer('b', 'Bram', 103, 100);
    const pelt = makeItem('wolf-pelt', 2, nextUid(a.hero)); addItem(a.hero, pelt);
    b.hero.coins = 5;
    s.rpg.command('a', { t: 'offer', to: 'b', uids: [pelt.uid], coins: 0, price: 12 });
    const offer = [...s.rpg.offers.values()][0];
    s.rpg.command('b', { t: 'trade', id: offer.id, accept: true });
    expect(msgs(s).join()).toMatch(/Not enough coins/);
    expect(count(a.hero, 'wolf-pelt')).toBe(2); expect(count(b.hero, 'wolf-pelt')).toBe(0);
    b.hero.coins = 20;
    s.rpg.command('a', { t: 'offer', to: 'b', uids: [pelt.uid], coins: 3, price: 12 });
    s.rpg.command('b', { t: 'trade', id: [...s.rpg.offers.values()][0].id, accept: true });
    expect(count(a.hero, 'wolf-pelt')).toBe(0); expect(count(b.hero, 'wolf-pelt')).toBe(2);
    expect(a.hero.coins).toBe(20 - 3 + 12); expect(b.hero.coins).toBe(20 + 3 - 12);
    b.x = 200;
    s.rpg.command('b', { t: 'offer', to: 'a', uids: [], coins: 1, price: 0 });
    expect(s.rpg.offers.size).toBe(0); // too far apart
  });

  it('an old save (pack of counts) loads into the new character', () => {
    const s = sim(12);
    s.addPlayer('local', 'Tester', 0, 0);
    s.load({ t: 5, players: [{ id: 'local', x: 10, y: 20, inv: { coins: 33, herbs: 2, ore: 1, relics: 1 } }] });
    const h = s.players.get('local')!.hero;
    expect(h.coins).toBe(20 + 33); expect(count(h, 'herbs')).toBe(2); expect(count(h, 'ore')).toBe(1); expect(count(h, 'relic')).toBe(1);
  });
});
