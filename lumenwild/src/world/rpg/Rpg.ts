import type { LifeSim, Player } from '../life/LifeSim';
import type { Creature, Species } from '../life/wildlife';
import type { Villager } from '../life/villagers';
import type { VillagePlan } from '../villages';
import { ITEMS, makeItem, itemName, itemValue, isGear, rng, type Item, type Rng, type Slot, type Rarity } from './items';
import { CREATURE_COMBAT, LOOT, GEAR_DROPS, RECIPES, SHOPS, QUEST_GIVERS, STATION_AT, STATION_NAMES, type Station, type Skill } from './content';
import {
  newHero, nextUid, gainXp, practise, addItem, canAdd, removeId, takeUid, count, findItem, equip, unequip, spendPoint,
  maxHp, attackDamage, attackCooldown, critChance, weaponOf, damageTaken, dodgeCost, regenRate, sLevel, BAG,
  type Hero, type QuestState, type Attr,
} from './hero';

/**
 * The RPG rules, the same in the browser (single player) and on the world server (authoritative): combat, gathering,
 * loot, crafting, trade with villagers and between players, quests, progression, death and respawn.
 *
 * Everything a player does is a command (`command(playerId, cmd)`); what happens is reported as events (hits, kills,
 * level-ups, messages...) that the browser draws and the server forwards to the players near it.
 */

export type RpgCmd =
  | { t: 'attack'; h: number }
  | { t: 'dodge'; h: number }
  | { t: 'gather'; node: string }
  | { t: 'pickup'; id: string }
  | { t: 'equip'; uid: string }
  | { t: 'unequip'; slot: Slot }
  | { t: 'use'; uid?: string }
  | { t: 'drop'; uid: string }
  | { t: 'craft'; recipe: string }
  | { t: 'talk'; vid: string }
  | { t: 'accept' }
  | { t: 'abandon'; qid: string }
  | { t: 'buy'; vid: string; idx: number }
  | { t: 'sell'; vid: string; uid: string; n?: number }
  | { t: 'explore'; place: string }
  | { t: 'spend'; attr: Attr }
  | { t: 'offer'; to: string; uids: string[]; coins: number; price: number }
  | { t: 'trade'; id: string; accept: boolean };

export type RpgEvent =
  | { e: 'swing'; who: string; h: number }
  | { e: 'dodge'; who: string; h: number }
  | { e: 'hit'; who: string; target: string; dmg: number; crit: boolean; x: number; y: number }
  | { e: 'kill'; who: string; target: string; sp: string; x: number; y: number }
  | { e: 'hurt'; who: string; by: string; dmg: number; x: number; y: number }
  | { e: 'evade'; who: string; by: string; x: number; y: number }
  | { e: 'died'; who: string; x: number; y: number }
  | { e: 'respawn'; who: string; x: number; y: number }
  | { e: 'xp'; who: string; n: number }
  | { e: 'level'; who: string; level: number }
  | { e: 'skill'; who: string; skill: Skill; level: number }
  | { e: 'msg'; who: string; text: string }
  | { e: 'quest'; who: string; qid: string; status: 'offered' | 'accepted' | 'progress' | 'ready' | 'done' | 'abandoned'; title: string };

export interface GroundLoot { id: string; x: number; y: number; items: Item[]; coins: number; t: number; owner: string | null; label: string }
export interface TradeOffer { id: string; from: string; to: string; items: Item[]; coins: number; price: number; t: number }
export interface ShopEntry { item: Item; price: number; left: number }
/** What a player's panel shows that is not part of the hero: the quest offered, the shop open, trade offers. */
export interface RpgView { offer: QuestState | null; shop: string | null; stock: ShopEntry[]; offers: TradeOffer[] }

/** A gatherable thing in the world: tree, rock, mushroom, or a find (chest, herbs, ore, relic) at a continent cell. */
export interface GatherNode { kind: string; variant: string; x: number; y: number }
/** World objects by node id (`kind:x,y`): the browser looks in the loaded window, the server in generated regions. */
export interface NodeQuery { node(id: string): GatherNode | null }

export const nodeId = (kind: string, x: number, y: number) => `${kind}:${Math.round(x)},${Math.round(y)}`;
const parseNode = (id: string) => { const m = /^([a-z]+):(-?\d+),(-?\d+)$/.exec(id); return m ? { kind: m[1], x: +m[2], y: +m[3] } : null; };
const FINDS = ['chest', 'herbs', 'ore', 'relic'];
const NODE_USES: Record<string, number> = { tree: 3, rock: 3, mushroom: 1 };
const RESPAWN_NODE = 600, RESPAWN_CREATURE = 600, LOOT_LIFE = 300, RESPAWN_PLAYER = 5, REACH = 4.5;
const DIST = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const angDiff = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
const ARTICLE = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a');

export class Rpg {
  readonly loot = new Map<string, GroundLoot>();
  readonly depleted = new Map<string, { n: number; t: number }>();
  /** One-time finds taken (shared world). */
  readonly taken = new Set<string>();
  /** Guardians last raised at an old place (t). */
  readonly guarded = new Map<string, number>();
  readonly offers = new Map<string, TradeOffer>();
  /** Shop stock per villager for the current restock period. */
  private shops = new Map<string, { period: number; stock: ShopEntry[] }>();
  /** Events since the host last drained them. */
  events: RpgEvent[] = [];
  /** Per hero (runtime): the shop open and the quest offered. */
  readonly ui = new Map<string, { shop: string | null; offer: QuestState | null }>();
  nodes: NodeQuery | null = null;
  /** Set on the server: players' stamina is kept here (in the browser, movement keeps it). */
  authoritative = false;
  private r: Rng;
  private n = 0;
  private lastSlow = 0;

  constructor(private sim: LifeSim, seed = 1) { this.r = rng(seed ^ 0x5eed); }

  // ------------------------------------------------------------------ helpers
  hero(pid: string): Hero | null { return this.sim.players.get(pid)?.hero ?? null; }
  private emit(ev: RpgEvent): void { this.events.push(ev); }
  private msg(who: string, text: string): string { this.emit({ e: 'msg', who, text }); return text; }
  private uiOf(pid: string) { let u = this.ui.get(pid); if (!u) { u = { shop: null, offer: null }; this.ui.set(pid, u); } return u; }
  private now(): number { return this.sim.clock.t; }

  /** A fresh hero whose home is the nearest village. */
  createHero(x: number, y: number): Hero {
    const v = this.nearestVillage(x, y);
    return newHero(v ? [v.square.x, v.square.y] : [x, y], v?.name ?? 'the wilds');
  }

  nearestVillage(x: number, y: number): VillagePlan | null {
    let best: VillagePlan | null = null, bd = Infinity;
    for (const s of this.sim.bp.data.settlements) {
      const p = this.sim.terrain.village(s.id);
      if (!p) continue;
      const d = Math.hypot(p.cx - x, p.cy - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private xp(p: Player, n: number, skill?: Skill, sxp = 0): void {
    const h = p.hero;
    if (n > 0) {
      const up = gainXp(h, n);
      this.emit({ e: 'xp', who: p.id, n: Math.round(n) });
      if (up) { this.emit({ e: 'level', who: p.id, level: h.level }); this.sim.note(`${p.name} reached level ${h.level}.`, p.x, p.y); }
    }
    if (skill && sxp > 0) { const lv = practise(h, skill, sxp); if (lv) this.emit({ e: 'skill', who: p.id, skill, level: lv }); }
  }

  private give(p: Player, id: string, n: number, rarityBonus = 0, rarity?: Rarity): Item | null {
    const it = makeItem(id, n, nextUid(p.hero), this.r, rarity, rarityBonus);
    if (addItem(p.hero, it)) return it;
    this.dropAt(p.x, p.y, [it], 0, null, 'Dropped items');
    this.msg(p.id, 'Your pack is full: it is on the ground.');
    return null;
  }

  dropAt(x: number, y: number, items: Item[], coins: number, owner: string | null, label: string): GroundLoot | null {
    if (!items.length && coins <= 0) return null;
    const id = `L${(++this.n).toString(36)}`;
    const g: GroundLoot = { id, x: x + (this.r() - 0.5) * 0.8, y: y + (this.r() - 0.5) * 0.8, items, coins, t: this.now(), owner, label };
    this.loot.set(id, g);
    return g;
  }

  /** Crafting stations within reach (village buildings). */
  stationsNear(x: number, y: number, r = 5): Set<Station> {
    const out = new Set<Station>(['none']);
    for (const v of this.sim.terrain.villagesNear(x - r, y - r, x + r, y + r)) {
      for (const b of v.buildings) {
        const st = STATION_AT[b.type];
        if (!st) continue;
        const dx = Math.max(b.x - x, 0, x - (b.x + b.w)), dy = Math.max(b.y - y, 0, y - (b.y + b.d + 2));
        if (Math.hypot(dx, dy) <= r) out.add(st);
      }
    }
    return out;
  }

  viewFor(pid: string): RpgView {
    const u = this.ui.get(pid);
    const shop = u?.shop && this.sim.players.get(pid) && this.villagerNear(this.sim.players.get(pid)!, u.shop) ? u.shop : null;
    if (u && !shop) u.shop = null;
    return { offer: u?.offer ?? null, shop, stock: shop ? this.shop(shop) : [], offers: [...this.offers.values()].filter((o) => o.from === pid || o.to === pid) };
  }

  // ------------------------------------------------------------------ commands
  /** Apply one command for a player. Returns a message for that player (also emitted as an event), or ''. */
  command(pid: string, c: RpgCmd): string {
    const p = this.sim.players.get(pid);
    if (!p || !c || typeof c !== 'object') return '';
    const h = p.hero;
    if (h.dead >= 0 && c.t !== 'spend') return this.msg(pid, 'You are down…');
    switch (c.t) {
      case 'attack': return this.attack(p, Number(c.h));
      case 'dodge': return this.dodge(p, Number(c.h));
      case 'gather': return this.gather(p, String(c.node));
      case 'pickup': return this.pickup(p, String(c.id));
      case 'equip': { const it = findItem(h, String(c.uid)); const e = equip(h, String(c.uid)); return e ? this.msg(pid, e) : this.msg(pid, `Equipped: ${itemName(it!)}.`); }
      case 'unequip': { const e = unequip(h, c.slot); return e ? this.msg(pid, e) : this.msg(pid, 'Unequipped.'); }
      case 'use': return this.use(p, c.uid);
      case 'drop': { const it = takeUid(h, String(c.uid)); if (!it) return this.msg(pid, 'No such item.'); this.dropAt(p.x, p.y, [it], 0, null, itemName(it)); return this.msg(pid, `Dropped ${itemName(it)}.`); }
      case 'craft': return this.craft(p, String(c.recipe));
      case 'talk': return this.talk(p, String(c.vid));
      case 'accept': return this.accept(p);
      case 'abandon': { const k = h.quests.findIndex((q) => q.id === c.qid); if (k < 0) return ''; const q = h.quests.splice(k, 1)[0]; removeId(h, 'parcel', q.kind === 'deliver' ? 1 : 0); this.emit({ e: 'quest', who: pid, qid: q.id, status: 'abandoned', title: q.title }); return this.msg(pid, `Abandoned: ${q.title}.`); }
      case 'buy': return this.buy(p, String(c.vid), Math.floor(Number(c.idx)));
      case 'sell': return this.sell(p, String(c.vid), String(c.uid), c.n);
      case 'explore': return this.explore(p, String(c.place));
      case 'spend': return spendPoint(h, c.attr) ? this.msg(pid, `${c.attr === 'str' ? 'Strength' : c.attr === 'agi' ? 'Agility' : 'Vitality'} +1.`) : '';
      case 'offer': return this.offer(p, c);
      case 'trade': return this.answerTrade(p, String(c.id), !!c.accept);
      default: return '';
    }
  }

  // ------------------------------------------------------------------ combat
  private attack(p: Player, hd: number): string {
    const h = p.hero, t = this.now();
    if (!Number.isFinite(hd)) hd = p.h;
    if (t < h.atkT) return '';
    h.atkT = t + attackCooldown(h);
    const tired = p.stamina < 0.04;
    p.stamina = Math.max(0, p.stamina - 0.05);
    p.h = hd;
    this.emit({ e: 'swing', who: p.id, h: hd });
    const w = weaponOf(h), hits: Array<[Creature, number]> = [];
    for (const c of this.sim.wildlife.creatures.values()) {
      if (!c.alive || (c.tier !== 0 && !this.authoritative)) continue;
      if (c.sp === 'bird' && c.alt > 2) continue;
      const cc = CREATURE_COMBAT[c.sp], d = DIST(c, p);
      if (d > w.reach + cc.size) continue;
      if (d > cc.size + 0.4 && angDiff(Math.atan2(c.y - p.y, c.x - p.x), hd) > 1.15) continue;
      hits.push([c, d]);
    }
    hits.sort((a, b) => a[1] - b[1]);
    for (const [c] of hits.slice(0, w.cleave)) this.hitCreature(p, c, tired);
    return '';
  }

  private hitCreature(p: Player, c: Creature, tired: boolean): void {
    const h = p.hero, cc = CREATURE_COMBAT[c.sp];
    const crit = this.r() < critChance(h);
    const dmg = Math.max(1, Math.round(attackDamage(h) * (0.85 + this.r() * 0.3) * (crit ? 1.8 : 1) * (tired ? 0.5 : 1)));
    c.hp = Math.max(0, (c.hp ?? cc.hp) - dmg);
    h.stats.dmgDealt += dmg;
    this.emit({ e: 'hit', who: p.id, target: c.id, dmg, crit, x: c.x, y: c.y });
    this.xp(p, 0, 'melee', 3);
    if (c.hp <= 0) return this.killCreature(p, c);
    this.sim.wildlife.provoke(c, p, this.sim.clock);
  }

  private killCreature(p: Player, c: Creature): void {
    const h = p.hero, t = this.now();
    c.alive = false; c.st = 'dead'; c.diedAt = t; c.foe = null;
    this.sim.wildlife.stats.kills++;
    h.stats.kills[c.sp] = (h.stats.kills[c.sp] ?? 0) + 1;
    this.emit({ e: 'kill', who: p.id, target: c.id, sp: c.sp, x: c.x, y: c.y });
    this.sim.note(`${p.name} brought down ${ARTICLE(c.sp)} ${c.sp}.`, c.x, c.y);
    this.xp(p, CREATURE_COMBAT[c.sp].xp, 'hunting', 6 + CREATURE_COMBAT[c.sp].xp / 4);
    // Loot (more with hunting skill), and now and then a piece of gear from a predator.
    const items: Item[] = [], bonus = (sLevel(h, 'hunting') - 1) * 0.02;
    for (const [id, ch, lo, hi] of LOOT[c.sp]) {
      if (id === 'antler' && !c.male) continue;
      if (this.r() < Math.min(1, ch + bonus)) items.push(makeItem(id, lo + Math.floor(this.r() * (hi - lo + 1)), nextUid(h)));
    }
    if ((c.sp === 'wolf' && this.r() < 0.06) || (c.sp === 'bear' && this.r() < 0.3)) items.push(makeItem(GEAR_DROPS[Math.floor(this.r() * 12)], 1, nextUid(h), this.r, undefined, c.sp === 'bear' ? 0.8 : 0.3));
    this.dropAt(c.x, c.y, items, 0, p.id, `${c.sp[0].toUpperCase()}${c.sp.slice(1)}`);
    // Bounties.
    for (const q of h.quests) if (q.kind === 'bounty' && q.target === c.sp && q.status === 'active') this.progress(p, q, q.have + 1);
  }

  private dodge(p: Player, hd: number): string {
    const h = p.hero, t = this.now();
    if (t < h.dodgeT) return '';
    const cost = dodgeCost(h);
    if (p.stamina < cost) return this.msg(p.id, 'Too tired to dodge.');
    p.stamina -= cost;
    h.dodgeT = t + 0.7; h.dodgeUntil = t + 0.35; h.dodgeH = Number.isFinite(hd) ? hd : p.h + Math.PI;
    this.emit({ e: 'dodge', who: p.id, h: h.dodgeH });
    return '';
  }

  /** A creature's bite or swipe at a player (from the wildlife's fight state). */
  creatureAttack(c: Creature, pid: string): void {
    const p = this.sim.players.get(pid);
    if (!p || p.hero.dead >= 0 || !c.alive) return;
    const h = p.hero, t = this.now(), cc = CREATURE_COMBAT[c.sp];
    if (t < h.dodgeUntil) { this.emit({ e: 'evade', who: pid, by: c.id, x: p.x, y: p.y }); this.xp(p, 0, 'defence', 4); return; }
    const dmg = Math.max(1, Math.round(damageTaken(h, cc.dmg * (0.85 + this.r() * 0.3))));
    h.hp -= dmg; h.hurtT = t; h.stats.dmgTaken += dmg;
    this.emit({ e: 'hurt', who: pid, by: c.id, dmg, x: p.x, y: p.y });
    this.xp(p, 0, 'defence', 1);
    if (h.hp <= 0) this.die(p, `${ARTICLE(c.sp)} ${c.sp}`);
  }

  private die(p: Player, cause: string): void {
    const h = p.hero, t = this.now();
    h.hp = 0; h.dead = t; h.stats.deaths++; p.alive = false; p.v = 0;
    const lost = Math.floor(h.coins * 0.1);
    h.coins -= lost;
    if (lost > 0) this.dropAt(p.x, p.y, [], lost, p.id, `${p.name}'s purse`);
    this.emit({ e: 'died', who: p.id, x: p.x, y: p.y });
    this.sim.note(`${p.name} was brought down by ${cause}.`, p.x, p.y);
    this.msg(p.id, `You fell to ${cause}${lost ? ` and dropped ${lost} coins` : ''}. You will wake in ${h.homeName}.`);
  }

  // ------------------------------------------------------------------ gathering and loot
  private gather(p: Player, id: string): string {
    const h = p.hero, t = this.now(), n = parseNode(id);
    if (!n) return '';
    if (t < h.gatherT) return '';
    if (Math.hypot(n.x + 0.5 - p.x, n.y + 0.5 - p.y) > REACH + 2) return this.msg(p.id, 'Too far away.');
    if (this.nodes && !this.nodes.node(id)) return this.msg(p.id, 'Nothing there.');
    h.gatherT = t + 0.8;
    if (FINDS.includes(n.kind)) {
      if (this.taken.has(id)) return this.msg(p.id, 'Someone got there first.');
      this.taken.add(id);
      h.stats.gathered++;
      if (n.kind === 'chest') {
        const coins = 15 + Math.floor(this.r() * 30);
        h.coins += coins; h.stats.coinsEarned += coins;
        const got: string[] = [`${coins} coins`];
        if (this.r() < 0.45) { const it = this.give(p, GEAR_DROPS[Math.floor(this.r() * GEAR_DROPS.length)], 1, 0.6); if (it) got.push(itemName(it)); }
        this.xp(p, 15, 'exploration', 8);
        return this.msg(p.id, `Opened the chest: ${got.join(', ')}.`);
      }
      const item = n.kind === 'relic' ? 'relic' : n.kind, k = n.kind === 'relic' ? 1 : 2;
      this.give(p, item, k);
      this.xp(p, 6, n.kind === 'ore' ? 'mining' : n.kind === 'herbs' ? 'foraging' : 'exploration', 6);
      this.questItems(p);
      return this.msg(p.id, `Took ${k} ${ITEMS[item].name.toLowerCase()}.`);
    }
    const dep = this.depleted.get(id);
    if (dep && t - dep.t > RESPAWN_NODE) this.depleted.delete(id);
    const used = this.depleted.get(id)?.n ?? 0, max = NODE_USES[n.kind] ?? 0;
    if (!max) return '';
    if (used >= max) return this.msg(p.id, n.kind === 'tree' ? 'Already cut back; it will grow again.' : n.kind === 'rock' ? 'Picked clean for now.' : 'Nothing left here.');
    this.depleted.set(id, { n: used + 1, t });
    const tool = h.equip.weapon ? ITEMS[h.equip.weapon.id].tool : undefined;
    let out: string;
    if (n.kind === 'tree') {
      const k = 1 + (tool === 'axe' ? 1 : 0) + (this.r() < sLevel(h, 'woodcutting') * 0.02 ? 1 : 0);
      this.give(p, 'wood', k); this.xp(p, 2, 'woodcutting', tool === 'axe' ? 6 : 4); out = `Cut ${k} wood.`;
    } else if (n.kind === 'rock') {
      this.give(p, 'stone', 1);
      const ore = tool === 'pick' && this.r() < 0.55 + sLevel(h, 'mining') * 0.01;
      if (ore) this.give(p, 'ore', 1);
      this.xp(p, 2, 'mining', ore ? 7 : 3); out = ore ? 'Broke off stone and iron ore.' : tool === 'pick' ? 'Broke off some stone.' : 'Broke off some stone (a pickaxe would find ore).';
    } else {
      const k = 1 + (this.r() < sLevel(h, 'foraging') * 0.03 ? 1 : 0);
      this.give(p, 'mushroom', k); this.xp(p, 2, 'foraging', 5); out = `Picked ${k} mushroom${k > 1 ? 's' : ''}.`;
    }
    h.stats.gathered++;
    this.questItems(p);
    return this.msg(p.id, out);
  }

  private pickup(p: Player, id: string): string {
    const g = this.loot.get(id), h = p.hero, t = this.now();
    if (!g) return this.msg(p.id, 'Nothing there.');
    if (DIST(g, p) > REACH) return this.msg(p.id, 'Too far away.');
    if (g.owner && g.owner !== p.id && t - g.t < 30) return this.msg(p.id, 'That belongs to someone else (for now).');
    const got: string[] = [];
    if (g.coins) { h.coins += g.coins; got.push(`${g.coins} coins`); g.coins = 0; }
    const left: Item[] = [];
    for (const it of g.items) { if (canAdd(h, it)) { addItem(h, { ...it, uid: nextUid(h) }); got.push(it.n > 1 ? `${it.n} ${ITEMS[it.id].name.toLowerCase()}` : itemName(it)); } else left.push(it); }
    g.items = left;
    if (!left.length) this.loot.delete(id);
    this.questItems(p);
    return this.msg(p.id, got.length ? `Picked up ${got.join(', ')}.${left.length ? ' Your pack is full.' : ''}` : 'Your pack is full.');
  }

  private use(p: Player, uid?: string): string {
    const h = p.hero;
    // No id: the best food or potion for the health missing.
    const it = uid ? findItem(h, uid) : [...h.inv].filter((q) => ITEMS[q.id].heal).sort((a, b) => ITEMS[a.id].heal! - ITEMS[b.id].heal!).find((q) => ITEMS[q.id].heal! >= Math.min(30, maxHp(h) - h.hp)) ?? h.inv.filter((q) => ITEMS[q.id].heal).sort((a, b) => ITEMS[b.id].heal! - ITEMS[a.id].heal!)[0];
    if (!it) return this.msg(p.id, uid ? 'No such item.' : 'Nothing to eat.');
    const d = ITEMS[it.id];
    if (!d.heal && !d.rest) return this.msg(p.id, `${d.name} cannot be used like that.`);
    if (h.hp >= maxHp(h) && !d.rest) return this.msg(p.id, 'You are not hurt.');
    takeUid(h, it.uid, 1);
    h.hp = Math.min(maxHp(h), h.hp + (d.heal ?? 0));
    p.stamina = Math.min(1, p.stamina + (d.rest ?? 0));
    return this.msg(p.id, `${d.kind === 'potion' ? 'Used' : 'Ate'} ${d.name.toLowerCase()} (+${d.heal} health).`);
  }

  // ------------------------------------------------------------------ crafting
  private craft(p: Player, rid: string): string {
    const h = p.hero, rc = RECIPES.find((r) => r.id === rid);
    if (!rc) return this.msg(p.id, 'Unknown recipe.');
    if (!this.stationsNear(p.x, p.y).has(rc.station)) return this.msg(p.id, `You need ${STATION_NAMES[rc.station]} for that.`);
    if (sLevel(h, rc.skill) < rc.level) return this.msg(p.id, `Needs ${rc.skill} ${rc.level}.`);
    for (const [id, n] of rc.inputs) if (count(h, id) < n) return this.msg(p.id, `Missing ${n - count(h, id)} ${ITEMS[id].name.toLowerCase()}.`);
    const out = makeItem(rc.out, rc.n, nextUid(h), this.r, undefined, (sLevel(h, rc.skill) - 1) / 12);
    // Room check with the inputs gone.
    for (const [id, n] of rc.inputs) removeId(h, id, n);
    if (!addItem(h, out)) { for (const [id, n] of rc.inputs) addItem(h, makeItem(id, n, nextUid(h))); return this.msg(p.id, 'Your pack is full.'); }
    h.stats.crafted++;
    this.xp(p, rc.xp / 2, rc.skill, rc.xp);
    this.questItems(p);
    return this.msg(p.id, `Made ${itemName(out)}${out.n > 1 ? ` x${out.n}` : ''}.`);
  }

  // ------------------------------------------------------------------ villagers: talk, shops, quests
  private villagerNear(p: Player, vid: string): Villager | null {
    const v = this.sim.villages.people.get(vid);
    return v && v.out && DIST(v, p) <= REACH + 1 ? v : null;
  }

  private talk(p: Player, vid: string): string {
    const v = this.villagerNear(p, vid), h = p.hero, u = this.uiOf(p.id);
    if (!v) return this.msg(p.id, 'They are too far away.');
    u.offer = null;
    u.shop = SHOPS[v.tag] ? v.id : null;
    // A delivery for this village?
    const del = h.quests.find((q) => q.kind === 'deliver' && q.target === v.village && count(h, 'parcel') > 0);
    if (del) { removeId(h, 'parcel', 1); return this.complete(p, del, `${v.name} takes the parcel. “At last!”`); }
    // Our quest from this villager?
    const mine = h.quests.find((q) => q.giver === v.id);
    if (mine) {
      if (this.isComplete(p, mine)) return this.complete(p, mine, `${v.name}: “Well done.”`);
      return this.msg(p.id, `${v.name}: “${mine.title}: ${mine.have}/${mine.need}.”`);
    }
    const q = this.questFrom(p, v);
    if (q && h.quests.length < 5) {
      u.offer = q;
      this.emit({ e: 'quest', who: p.id, qid: q.id, status: 'offered', title: q.title });
      return this.msg(p.id, `${v.name}: “${q.text}” (Accept in the Quests tab.)`);
    }
    const line = this.sim.villages.greet(v);
    return this.msg(p.id, u.shop ? `${line} (Their wares are in the Shop tab.)` : line);
  }

  /** Is this villager one who hands out work? */
  isGiver(v: Villager): boolean {
    const kinds = QUEST_GIVERS[v.tag];
    if (!kinds) return false;
    return v.tag === 'farmer' || v.tag === 'herder' ? hash(v.id) % 4 === 0 : true;
  }

  /** The quest this villager offers this hero next (deterministic: their n-th quest for this hero), or null. */
  questFrom(p: Player, v: Villager): QuestState | null {
    if (!this.isGiver(v)) return null;
    const h = p.hero, n = h.done[v.id] ?? 0, kinds = QUEST_GIVERS[v.tag], kind = kinds[n % kinds.length];
    const plan = this.sim.terrain.village(v.village), r = rng(hash(`${v.id}:${n}`));
    const lvl = h.level, base = { id: `${v.id}#${n}`, giver: v.id, giverName: v.name, village: v.village, kind, have: 0, status: 'active' as const };
    const coins = (k: number) => Math.round(k * (1 + lvl * 0.15));
    switch (kind) {
      case 'bounty': {
        const biome = this.sim.wildlife.regionOf?.(v.x, v.y) ?? '';
        const sp: Species = (biome === 'elderwood' || biome === 'dragon-peaks') && n % 3 === 2 ? 'bear' : biome === 'whispering-marshes' ? 'fox' : 'wolf';
        const need = sp === 'bear' ? 1 : sp === 'fox' ? 2 : 2 + (n % 3);
        const why = sp === 'wolf' ? 'Wolves have been at the flocks again.' : sp === 'bear' ? 'A bear has been tearing up the stores.' : 'Foxes keep getting into the hen-houses.';
        const plural = sp === 'wolf' ? 'wolves' : sp === 'fox' ? 'foxes' : 'bears', what = need === 1 ? `${ARTICLE(sp)} ${sp}` : `${need} ${plural}`;
        return { ...base, title: `Hunt ${what}`, text: `${why} Hunt ${what} and come back to me.`, target: sp, targetName: sp, need, reward: { xp: CREATURE_COMBAT[sp].xp * need * 2, coins: coins(10 * need + (sp === 'bear' ? 30 : 0)), item: r() < 0.5 ? GEAR_DROPS[Math.floor(r() * 10)] : undefined } };
      }
      case 'gather': {
        const opts: Record<string, Array<[string, number]>> = {
          herbalist: [['herbs', 4], ['mushroom', 4], ['feather', 3]], miner: [['ore', 3], ['stone', 6]], blacksmith: [['ore', 4], ['wood', 6]], hunter: [['hide', 3], ['wolf-pelt', 2]],
          trapper: [['fox-pelt', 1], ['feather', 4]], innkeeper: [['venison', 2], ['mushroom', 4]], merchant: [['hide', 2], ['herbs', 3]], farmer: [['wood', 5], ['stone', 4]],
        };
        const list = opts[v.tag] ?? [['wood', 5]], [item, need] = list[n % list.length];
        return { ...base, title: `Bring ${need} ${ITEMS[item].name.toLowerCase()}`, text: `I could use ${need} ${ITEMS[item].name.toLowerCase()}. Bring them and I'll pay.`, target: item, targetName: ITEMS[item].name, need, reward: { xp: 25 + ITEMS[item].value * need * 2, coins: coins(ITEMS[item].value * need * 2 + 5) } };
      }
      case 'craft': {
        const item = ['iron-dagger', 'iron-helm', 'pickaxe', 'iron-sword'][n % 4];
        return { ...base, title: `Forge ${ARTICLE(ITEMS[item].name)} ${ITEMS[item].name.toLowerCase()}`, text: `Show me you can work iron: forge ${ARTICLE(ITEMS[item].name)} ${ITEMS[item].name.toLowerCase()} and bring it here.`, target: item, targetName: ITEMS[item].name, need: 1, reward: { xp: 90, coins: coins(ITEMS[item].value * 1.6) } };
      }
      case 'explore': {
        const places = this.sim.terrain.places().filter((q) => !h.found.includes(q.id)).sort((a, b) => Math.hypot(a.x - v.x, a.y - v.y) - Math.hypot(b.x - v.x, b.y - v.y));
        const q = places[n % Math.max(1, Math.min(3, places.length))];
        if (!q) return null;
        const km = (Math.hypot(q.x - v.x, q.y - v.y) / 1000).toFixed(1), what = q.kind === 'cave' ? 'cave' : q.kind === 'ruin' ? 'ruins' : q.kind === 'tower' ? 'watchtower' : 'old stone';
        return { ...base, title: `Explore ${q.name}`, text: `There's ${what === 'ruins' ? 'ruins' : `${ARTICLE(what)} ${what}`} they call ${q.name}, ${km} km ${compass(q.x - v.x, q.y - v.y)}. Go and see what's there.`, target: q.id, targetName: q.name, need: 1, reward: { xp: 70 + Math.round(+km * 20), coins: coins(15 + +km * 8), item: q.kind === 'cave' || q.kind === 'ruin' ? 'relic' : undefined } };
      }
      case 'dragon': {
        const ds = this.sim.dragons.dragons, d = ds[n % ds.length];
        if (!d) return null;
        return { ...base, title: `Find ${d.name}`, text: `${d.name} has been seen near here. Get within half a kilometre of it, and live to tell me where it flies.`, target: d.id, targetName: d.name, need: 1, reward: { xp: 120, coins: coins(30) } };
      }
      case 'deliver': {
        const others = this.sim.bp.data.settlements.filter((s) => s.id !== v.village);
        const to = others[n % others.length];
        if (!to || !plan) return null;
        return { ...base, title: `Carry a parcel to ${to.name}`, text: `Take this parcel to anyone in ${to.name}. They are expecting it.`, target: to.id, targetName: to.name, need: 1, reward: { xp: 80, coins: coins(25) } };
      }
    }
    return null;
  }

  private accept(p: Player): string {
    const u = this.uiOf(p.id), h = p.hero, q = u.offer;
    if (!q) return this.msg(p.id, 'Nothing offered.');
    if (h.quests.some((x) => x.id === q.id)) { u.offer = null; return ''; }
    if (q.kind === 'deliver' && !addItem(h, makeItem('parcel', 1, nextUid(h)))) return this.msg(p.id, 'Your pack is full.');
    h.quests.push(q); u.offer = null;
    this.emit({ e: 'quest', who: p.id, qid: q.id, status: 'accepted', title: q.title });
    this.questItems(p);
    return this.msg(p.id, `New quest: ${q.title}.`);
  }

  private isComplete(p: Player, q: QuestState): boolean {
    if (q.kind === 'gather' || q.kind === 'craft') return count(p.hero, q.target) >= q.need;
    return q.status === 'ready';
  }

  private progress(p: Player, q: QuestState, have: number): void {
    const was = q.status;
    q.have = Math.min(q.need, have);
    if (q.have >= q.need) q.status = 'ready';
    if (q.status === 'ready' && was !== 'ready') { this.emit({ e: 'quest', who: p.id, qid: q.id, status: 'ready', title: q.title }); this.msg(p.id, `${q.title}: done. Return to ${q.giverName}.`); }
    else if (q.status === 'active') this.emit({ e: 'quest', who: p.id, qid: q.id, status: 'progress', title: q.title });
  }

  /** Gather and craft quests count what is in the pack. */
  private questItems(p: Player): void {
    for (const q of p.hero.quests) if ((q.kind === 'gather' || q.kind === 'craft')) { const have = Math.min(q.need, count(p.hero, q.target)); if (have !== q.have) { q.have = have; q.status = have >= q.need ? 'ready' : 'active'; } }
  }

  private complete(p: Player, q: QuestState, line: string): string {
    const h = p.hero;
    if (q.kind === 'gather' || q.kind === 'craft') removeId(h, q.target, q.need);
    h.quests.splice(h.quests.indexOf(q), 1);
    h.done[q.giver] = (h.done[q.giver] ?? 0) + 1;
    h.stats.quests++;
    h.coins += q.reward.coins; h.stats.coinsEarned += q.reward.coins;
    let extra = '';
    if (q.reward.item) { const it = this.give(p, q.reward.item, 1, 0.8); if (it) extra = ` and ${itemName(it)}`; }
    this.xp(p, q.reward.xp);
    this.emit({ e: 'quest', who: p.id, qid: q.id, status: 'done', title: q.title });
    this.sim.note(`${p.name} completed “${q.title}”.`, p.x, p.y);
    return this.msg(p.id, `${line} Quest complete: ${q.title}. +${q.reward.xp} xp, ${q.reward.coins} coins${extra}.`);
  }

  // ------------------------------------------------------------------ shops
  /** A villager's wares this period (restocks every 10 minutes). */
  shop(vid: string): ShopEntry[] {
    const v = this.sim.villages.people.get(vid), def = v ? SHOPS[v.tag] : null;
    if (!v || !def) return [];
    const period = Math.floor(this.now() / 600);
    const cur = this.shops.get(vid);
    if (cur && cur.period === period) return cur.stock;
    const r = rng(hash(`${vid}:${period}`)), stock: ShopEntry[] = [];
    let k = 0;
    for (const id of def.sells) {
      const d = ITEMS[id];
      const it = makeItem(id, isGear(d) ? 1 : 5, `s${vid}:${period}:${k++}`, r, undefined, 0.2);
      stock.push({ item: it, price: Math.max(1, Math.round(itemValue({ ...it, n: 1 }) * 1.3)), left: isGear(d) ? 1 : 10 + Math.floor(r() * 10) });
    }
    this.shops.set(vid, { period, stock });
    return stock;
  }

  buyPrice(p: Player, e: ShopEntry): number { return Math.max(1, Math.round(e.price * (1 - Math.min(0.25, (sLevel(p.hero, 'trading') - 1) * 0.006)))); }
  sellPrice(p: Player, vid: string, it: Item, n = it.n): number {
    const v = this.sim.villages.people.get(vid), def = v ? SHOPS[v.tag] : null, d = ITEMS[it.id];
    if (!def || d.kind === 'quest') return 0;
    const wants = def.wants.includes(it.id) || def.wants.includes(d.kind);
    return Math.max(0, Math.floor(itemValue({ ...it, n }) * (wants ? 0.5 : 0.25) * (1 + Math.min(0.5, (sLevel(p.hero, 'trading') - 1) * 0.012))));
  }

  private buy(p: Player, vid: string, idx: number): string {
    const v = this.villagerNear(p, vid), h = p.hero;
    if (!v) return this.msg(p.id, 'They are too far away.');
    const e = this.shop(vid)[idx];
    if (!e || e.left <= 0) return this.msg(p.id, 'Sold out.');
    const price = this.buyPrice(p, e);
    if (h.coins < price) return this.msg(p.id, `You need ${price} coins.`);
    const it: Item = { ...e.item, uid: nextUid(h), n: ITEMS[e.item.id].stack > 1 ? 1 : 1 };
    if (!canAdd(h, it)) return this.msg(p.id, 'Your pack is full.');
    addItem(h, it); h.coins -= price; e.left--; h.stats.bought++;
    this.xp(p, 1, 'trading', 3);
    this.questItems(p);
    return this.msg(p.id, `Bought ${itemName(it)} for ${price} coins.`);
  }

  private sell(p: Player, vid: string, uid: string, n?: number): string {
    const v = this.villagerNear(p, vid), h = p.hero;
    if (!v || !SHOPS[v.tag]) return this.msg(p.id, 'No one here buys.');
    const it = findItem(h, uid);
    if (!it) return this.msg(p.id, 'No such item.');
    const k = Math.max(1, Math.min(it.n, Math.floor(n ?? it.n))), price = this.sellPrice(p, vid, it, k);
    if (price <= 0) return this.msg(p.id, `${v.name} won't take that.`);
    takeUid(h, uid, k);
    h.coins += price; h.stats.sold++; h.stats.coinsEarned += price;
    this.xp(p, 1, 'trading', 4);
    this.questItems(p);
    return this.msg(p.id, `Sold ${k > 1 ? `${k} ` : ''}${itemName({ ...it, n: k })} for ${price} coins.`);
  }

  // ------------------------------------------------------------------ exploration
  private explore(p: Player, placeId: string): string {
    const h = p.hero, place = this.sim.terrain.places().find((q) => q.id === placeId);
    if (!place) return '';
    if (Math.hypot(place.x - p.x, place.y - p.y) > 10) return this.msg(p.id, 'Too far away.');
    const first = !h.found.includes(place.id), t = this.now();
    let out = '';
    if (place.kind === 'tower') { const n = this.sim.revealFrom(place.x, place.y, 3000); out = `From the top of ${place.name} you can see for kilometres (${n} map cells revealed).`; }
    else if (place.kind === 'marker') out = `${place.name}: worn runes, still faintly glowing.`;
    else out = place.kind === 'cave' ? `${place.name}: cold air and old bones in the dark.` : `${place.name}: moss-covered stones of an older age.`;
    this.sim.discovery.discovered.add(place.id);
    if (first) {
      h.found.push(place.id);
      this.sim.revealFrom(place.x, place.y, 300);
      this.xp(p, place.kind === 'marker' ? 25 : 50, 'exploration', 20);
      out += ` Discovered: ${place.name}.`;
      // Caves and ruins hold something the first time each traveller searches them.
      if (place.kind === 'cave' || place.kind === 'ruin') {
        const coins = 10 + Math.floor(this.r() * 30); h.coins += coins; h.stats.coinsEarned += coins;
        const got = [`${coins} coins`];
        const it = this.give(p, GEAR_DROPS[Math.floor(this.r() * GEAR_DROPS.length)], 1, 1.2);
        if (it) got.push(itemName(it));
        if (place.kind === 'ruin') { this.give(p, 'relic', 1); got.push('a relic'); }
        out += ` Inside: ${got.join(', ')}.`;
      }
    }
    // Something guards caves and ruins (again after a while).
    if ((place.kind === 'cave' || place.kind === 'ruin') && t - (this.guarded.get(place.id) ?? -1e9) > 1200) {
      this.guarded.set(place.id, t);
      const biome = this.sim.wildlife.regionOf?.(place.x, place.y) ?? '';
      const sp: Species = place.kind === 'cave' && (biome === 'elderwood' || biome === 'dragon-peaks') ? 'bear' : 'wolf';
      const n = sp === 'bear' ? 1 : 2;
      for (let k = 0; k < n; k++) this.sim.wildlife.raiseGuardian(`guard-${place.id}-${k}`, sp, place.x + 3 + k * 2, place.y + 3, p, this.sim.clock);
      out += sp === 'bear' ? ' A bear wakes inside!' : ' Wolves den here, and they are not pleased!';
    }
    for (const q of h.quests) if (q.kind === 'explore' && q.target === place.id) this.progress(p, q, 1);
    return this.msg(p.id, out);
  }

  // ------------------------------------------------------------------ trade between players
  private offer(p: Player, c: Extract<RpgCmd, { t: 'offer' }>): string {
    const to = this.sim.players.get(String(c.to)), h = p.hero;
    if (!to || to.id === p.id) return this.msg(p.id, 'No one to trade with.');
    if (DIST(to, p) > 12) return this.msg(p.id, `${to.name} is too far away to trade.`);
    const uids = Array.isArray(c.uids) ? c.uids.map(String).slice(0, 8) : [];
    const coins = Math.max(0, Math.floor(Number(c.coins) || 0)), price = Math.max(0, Math.floor(Number(c.price) || 0));
    if (coins > h.coins) return this.msg(p.id, 'You do not have that many coins.');
    const items = uids.map((u) => findItem(h, u));
    if (items.some((it) => !it || ITEMS[it.id].kind === 'quest')) return this.msg(p.id, 'You cannot offer that.');
    if (!items.length && !coins) return this.msg(p.id, 'Offer something.');
    for (const o of this.offers.values()) if (o.from === p.id) this.offers.delete(o.id);
    const id = `T${(++this.n).toString(36)}`;
    this.offers.set(id, { id, from: p.id, to: to.id, items: items.map((it) => ({ ...it! })), coins, price, t: this.now() });
    this.msg(to.id, `${p.name} offers ${describe(items as Item[], coins)}${price ? ` for ${price} coins` : ' as a gift'}.`);
    return this.msg(p.id, `Offer sent to ${to.name}.`);
  }

  private answerTrade(p: Player, id: string, accept: boolean): string {
    const o = this.offers.get(id);
    if (!o || (o.to !== p.id && o.from !== p.id)) return this.msg(p.id, 'That offer is gone.');
    this.offers.delete(id);
    const from = this.sim.players.get(o.from), to = this.sim.players.get(o.to);
    if (!accept || !from || !to) { if (from) this.msg(from.id, `${p.name} declined the trade.`); return this.msg(p.id, 'Trade declined.'); }
    if (p.id !== o.to) return this.msg(p.id, 'Only the other side can accept.');
    if (DIST(from, to) > 12) return this.msg(p.id, 'You are too far apart.');
    const a = from.hero, b = to.hero;
    // Everything must still be there and fit, or nothing happens.
    if (a.coins < o.coins || b.coins < o.price) return this.msg(p.id, 'Not enough coins on one side.');
    if (o.items.some((it) => !findItem(a, it.uid))) return this.msg(p.id, 'The offered items are gone.');
    if (b.inv.length + o.items.length > BAG) return this.msg(p.id, 'Your pack is full.');
    for (const it of o.items) { const x = takeUid(a, it.uid)!; addItem(b, { ...x, uid: nextUid(b) }); }
    a.coins += o.price - o.coins; b.coins += o.coins - o.price;
    this.msg(from.id, `${to.name} accepted the trade.`);
    this.sim.note(`${from.name} and ${to.name} traded.`, to.x, to.y);
    return this.msg(p.id, `Trade done: ${describe(o.items, o.coins)}${o.price ? ` for ${o.price} coins` : ''}.`);
  }

  // ------------------------------------------------------------------ per tick
  /** Regeneration, respawns, quest checks, loot and node expiry. */
  update(dt: number): void {
    const t = this.now();
    for (const p of this.sim.players.values()) {
      const h = p.hero;
      if (h.dead >= 0) {
        if (t - h.dead >= RESPAWN_PLAYER) {
          h.dead = -1; h.hp = maxHp(h); p.alive = true; p.stamina = 1; p.x = h.home[0]; p.y = h.home[1] + 2;
          this.emit({ e: 'respawn', who: p.id, x: p.x, y: p.y });
        }
        continue;
      }
      if (t - h.hurtT > 6 && h.hp < maxHp(h)) h.hp = Math.min(maxHp(h), h.hp + regenRate(h) * dt);
      if (this.authoritative) p.stamina = Math.max(0, Math.min(1, p.stamina + (p.running ? -dt / 22 : dt / 30)));
    }
    if (t - this.lastSlow < 1) return;
    this.lastSlow = t;
    // Once a second: places found, home villages, dragons sighted, expired loot and offers, creatures back.
    const mpu = this.sim.bp.coords.metresPerUnit;
    for (const p of this.sim.players.values()) {
      const h = p.hero;
      if (h.dead >= 0) continue;
      for (const s of this.sim.bp.data.settlements) {
        const d = Math.hypot(s.at[0] * mpu - p.x, s.at[1] * mpu - p.y);
        if (d < s.footprintRadius * mpu) {
          if (!h.found.includes(s.id)) { h.found.push(s.id); this.xp(p, 40, 'exploration', 15); this.msg(p.id, `Discovered: ${s.name}.`); }
          if (h.homeName !== s.name) { const v = this.sim.terrain.village(s.id); if (v) { h.home = [v.square.x, v.square.y]; h.homeName = s.name; this.msg(p.id, `${s.name} is now your home: you will wake here if you fall.`); } }
        }
      }
      for (const l of this.sim.bp.data.landmarks) {
        if (h.found.includes(l.id) || !l.visibleFrom) continue;
        if (Math.hypot(l.at[0] * mpu - p.x, l.at[1] * mpu - p.y) <= l.visibleFrom * mpu) { h.found.push(l.id); this.xp(p, 30, 'exploration', 10); this.msg(p.id, `Discovered: ${l.name}.`); }
      }
      for (const q of h.quests) if (q.kind === 'dragon' && q.status === 'active') {
        const d = this.sim.dragons.dragons.find((x) => x.id === q.target);
        if (d && Math.hypot(d.x - p.x, d.y - p.y) < 500) this.progress(p, q, 1);
      }
    }
    for (const [id, g] of this.loot) if (t - g.t > LOOT_LIFE) this.loot.delete(id);
    for (const [id, o] of this.offers) if (t - o.t > 120) this.offers.delete(id);
    for (const c of this.sim.wildlife.creatures.values()) {
      if (c.alive || c.diedAt < 0 || t - c.diedAt < RESPAWN_CREATURE || c.id.startsWith('guard-')) continue;
      if ([...this.sim.players.values()].some((p) => Math.hypot(p.x - c.homeX, p.y - c.homeY) < 150)) continue;
      this.sim.wildlife.revive(c);
    }
  }

  /** Drain events (the host draws or forwards them). */
  drain(): RpgEvent[] { const e = this.events; this.events = []; return e; }

  // ------------------------------------------------------------------ persistence (world part; heroes save with players)
  toJSON(): Record<string, unknown> {
    const t = this.now();
    return {
      taken: [...this.taken],
      depleted: [...this.depleted].filter(([, d]) => t - d.t < RESPAWN_NODE).map(([k, d]) => [k, d.n, Math.round(d.t)]),
      loot: [...this.loot.values()].map((g) => ({ ...g, t: Math.round(g.t) })),
      guarded: [...this.guarded].map(([k, v]) => [k, Math.round(v)]),
      n: this.n,
    };
  }

  load(j: unknown): void {
    if (!j || typeof j !== 'object') return;
    const s = j as Record<string, unknown>;
    if (Array.isArray(s.taken)) for (const k of s.taken) if (typeof k === 'string') this.taken.add(k);
    if (Array.isArray(s.depleted)) for (const d of s.depleted as Array<[string, number, number]>) if (Array.isArray(d)) this.depleted.set(String(d[0]), { n: +d[1] || 0, t: +d[2] || 0 });
    if (Array.isArray(s.loot)) for (const g of s.loot as GroundLoot[]) if (g && typeof g.id === 'string' && Array.isArray(g.items)) this.loot.set(g.id, g);
    if (Array.isArray(s.guarded)) for (const [k, v] of s.guarded as Array<[string, number]>) this.guarded.set(String(k), +v || 0);
    if (typeof s.n === 'number') this.n = Math.max(this.n, s.n);
  }
}

export function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
function compass(dx: number, dy: number): string { return COMPASS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8]; }
function describe(items: Item[], coins: number): string {
  const bits = items.map((it) => (it.n > 1 ? `${it.n} ${ITEMS[it.id].name.toLowerCase()}` : itemName(it)));
  if (coins) bits.push(`${coins} coins`);
  return bits.join(', ') || 'nothing';
}

export type { Hero, QuestState };
