import { ITEMS, RARITY, SLOTS, itemProps, validItem, makeItem, type Item, type Slot, type Prop } from './items';
import { SKILLS, type Skill, type QuestKind } from './content';
import { HERO_VERSION, migrateHero } from '../migrations';

/**
 * A player's character: level and experience, attributes, health, skills that grow with use, inventory and
 * equipment, quests and statistics. Plain data (saved as JSON); the functions here are the rules for it.
 */

export type Attr = 'str' | 'agi' | 'vit';
export const ATTR_NAMES: Record<Attr, string> = { str: 'Strength', agi: 'Agility', vit: 'Vitality' };

export interface QuestState {
  id: string;
  giver: string; giverName: string; village: string;
  kind: QuestKind;
  title: string; text: string;
  /** What is wanted: a species, an item, a place id, a village id, a dragon id. */
  target: string; targetName: string;
  need: number; have: number;
  reward: { xp: number; coins: number; item?: string };
  status: 'active' | 'ready';
}

export interface Hero {
  level: number; xp: number; points: number;
  attrs: Record<Attr, number>;
  hp: number;
  skills: Record<Skill, number>;
  inv: Item[];
  equip: Partial<Record<Slot, Item>>;
  coins: number;
  quests: QuestState[];
  /** Completed quests per giver (the next quest a giver offers depends on it), and all completed ids. */
  done: Record<string, number>;
  /** Places and landmarks this hero has found (for rewards and the map). */
  found: string[];
  /** Where the hero comes back after falling (a village square), and its name. */
  home: [number, number]; homeName: string;
  stats: { kills: Record<string, number>; deaths: number; crafted: number; gathered: number; bought: number; sold: number; quests: number; dmgDealt: number; dmgTaken: number; coinsEarned: number };
  uid: number;
  /** Runtime (not saved): time of death (-1 alive), cooldowns, dodge window, last hurt, last regen tick. */
  dead: number; atkT: number; dodgeT: number; dodgeUntil: number; dodgeH: number; hurtT: number; gatherT: number;
}

export const MAX_LEVEL = 30, BAG = 24;
export const xpToNext = (level: number) => Math.round(60 * level ** 1.55);
export const skillLevel = (xp: number) => Math.min(50, Math.floor(Math.sqrt(xp / 18)) + 1);
export const skillXpFor = (level: number) => (level - 1) ** 2 * 18;

export function newHero(home: [number, number], homeName: string): Hero {
  const h: Hero = {
    level: 1, xp: 0, points: 0, attrs: { str: 3, agi: 3, vit: 3 }, hp: 0,
    skills: Object.fromEntries(SKILLS.map((s) => [s, 0])) as Record<Skill, number>,
    inv: [], equip: {}, coins: 20, quests: [], done: {}, found: [], home, homeName,
    stats: { kills: {}, deaths: 0, crafted: 0, gathered: 0, bought: 0, sold: 0, quests: 0, dmgDealt: 0, dmgTaken: 0, coinsEarned: 0 },
    uid: 0, dead: -1, atkT: 0, dodgeT: 0, dodgeUntil: 0, dodgeH: 0, hurtT: -1e9, gatherT: 0,
  };
  h.equip.weapon = makeItem('knife', 1, nextUid(h));
  h.equip.body = makeItem('padded-tunic', 1, nextUid(h));
  addItem(h, makeItem('bread', 3, nextUid(h)));
  h.hp = maxHp(h);
  return h;
}

export const nextUid = (h: Hero) => `i${(h.uid++).toString(36)}`;

// ------------------------------------------------------------------ derived numbers

/** Sum of a bonus property over all equipped gear. */
export function gearProp(h: Hero, p: Prop): number {
  let v = 0;
  for (const s of SLOTS) { const it = h.equip[s]; if (it) v += itemProps(it)[p] ?? 0; }
  return v;
}

export const maxHp = (h: Hero) => Math.round(60 + (h.level - 1) * 8 + h.attrs.vit * 6 + gearProp(h, 'hp'));
export const sLevel = (h: Hero, s: Skill) => skillLevel(h.skills[s]);

export function weaponOf(h: Hero) {
  const it = h.equip.weapon, d = it ? ITEMS[it.id] : null;
  return { dmg: d?.dmg ?? 3, cd: d?.cd ?? 0.5, reach: d?.reach ?? 1.3, cleave: d?.cleave ?? 1, mult: it ? RARITY[it.r].mult : 1 };
}

/** Damage of one swing before variance and crits. */
export function attackDamage(h: Hero): number {
  const w = weaponOf(h);
  return w.dmg * w.mult * (1 + h.attrs.str * 0.04 + (sLevel(h, 'melee') - 1) * 0.02) * (1 + gearProp(h, 'dmg') / 100);
}
export const attackCooldown = (h: Hero) => weaponOf(h).cd * Math.max(0.6, 1 - h.attrs.agi * 0.012);
export const critChance = (h: Hero) => Math.min(0.5, 0.05 + h.attrs.agi * 0.008 + gearProp(h, 'crit') / 100);

export function armourOf(h: Hero): number {
  let a = gearProp(h, 'armour');
  for (const s of SLOTS) { const it = h.equip[s]; if (it && ITEMS[it.id].armour) a += ITEMS[it.id].armour! * RARITY[it.r].mult; }
  return a;
}
/** Share of damage taken after armour and defence skill. */
export const damageTaken = (h: Hero, dmg: number) => dmg * (40 / (40 + armourOf(h))) * (1 - Math.min(0.25, (sLevel(h, 'defence') - 1) * 0.005));
/** Stamina (0..1) a dodge costs. */
export const dodgeCost = (h: Hero) => 0.24 * (1 - Math.min(0.4, (sLevel(h, 'defence') - 1) * 0.008 + gearProp(h, 'stam') / 100));
export const regenRate = (h: Hero) => 1.2 + h.attrs.vit * 0.15 + gearProp(h, 'regen');

// ------------------------------------------------------------------ progression

/** Add experience; returns the levels gained. */
export function gainXp(h: Hero, n: number): number {
  let up = 0;
  h.xp += Math.round(n);
  while (h.level < MAX_LEVEL && h.xp >= xpToNext(h.level)) {
    h.xp -= xpToNext(h.level); h.level++; h.points += 2; up++;
    h.hp = maxHp(h);
  }
  if (h.level >= MAX_LEVEL) h.xp = Math.min(h.xp, xpToNext(MAX_LEVEL));
  return up;
}

/** Practise a skill; returns the new level if it went up, else 0. */
export function practise(h: Hero, s: Skill, n: number): number {
  const before = sLevel(h, s);
  h.skills[s] += n;
  const after = sLevel(h, s);
  return after > before ? after : 0;
}

export function spendPoint(h: Hero, a: Attr): boolean {
  if (h.points <= 0 || !(a in h.attrs)) return false;
  h.points--; h.attrs[a]++;
  if (a === 'vit') h.hp += 6;
  return true;
}

// ------------------------------------------------------------------ inventory

export const count = (h: Hero, id: string) => h.inv.reduce((n, it) => n + (it.id === id ? it.n : 0), 0);
export const findItem = (h: Hero, uid: string) => h.inv.find((it) => it.uid === uid) ?? null;

/** Room for this item (stacking first)? */
export function canAdd(h: Hero, it: Item): boolean {
  const d = ITEMS[it.id];
  let left = it.n;
  if (d.stack > 1) for (const s of h.inv) if (s.id === it.id && s.r === it.r) left -= d.stack - s.n;
  if (left <= 0) return true;
  return h.inv.length + Math.ceil(left / d.stack) <= BAG;
}

/** Add an item (stacks merge). Returns false (and adds nothing) if the bag is full. */
export function addItem(h: Hero, it: Item): boolean {
  if (!canAdd(h, it)) return false;
  const d = ITEMS[it.id];
  let left = it.n;
  if (d.stack > 1) for (const s of h.inv) {
    if (left <= 0) break;
    if (s.id !== it.id || s.r !== it.r || s.n >= d.stack) continue;
    const k = Math.min(left, d.stack - s.n); s.n += k; left -= k;
  }
  let first = true;
  while (left > 0) { const k = Math.min(left, d.stack); h.inv.push({ ...it, uid: first ? it.uid : nextUid(h), n: k }); left -= k; first = false; }
  return true;
}

/** Remove n of an item id (from any stacks). */
export function removeId(h: Hero, id: string, n: number): boolean {
  if (count(h, id) < n) return false;
  for (let k = h.inv.length - 1; k >= 0 && n > 0; k--) {
    const s = h.inv[k];
    if (s.id !== id) continue;
    const t = Math.min(n, s.n); s.n -= t; n -= t;
    if (s.n <= 0) h.inv.splice(k, 1);
  }
  return true;
}

/** Take n from one stack by uid; returns the removed part (a new item) or null. */
export function takeUid(h: Hero, uid: string, n = Infinity): Item | null {
  const k = h.inv.findIndex((it) => it.uid === uid);
  if (k < 0) return null;
  const s = h.inv[k], t = Math.min(s.n, Math.max(1, Math.floor(n)));
  if (t >= s.n) { h.inv.splice(k, 1); return s; }
  s.n -= t;
  return { ...s, uid: nextUid(h), n: t };
}

/** Equip a bag item (the previous one in that slot goes back to the bag). */
export function equip(h: Hero, uid: string): string | null {
  const it = findItem(h, uid);
  if (!it) return 'No such item.';
  const d = ITEMS[it.id];
  if (!d.slot) return `${d.name} cannot be worn or wielded.`;
  const old = h.equip[d.slot];
  h.inv.splice(h.inv.indexOf(it), 1);
  h.equip[d.slot] = it;
  if (old) h.inv.push(old);
  h.hp = Math.min(h.hp, maxHp(h));
  return null;
}

export function unequip(h: Hero, slot: Slot): string | null {
  const it = h.equip[slot];
  if (!it) return 'Nothing there.';
  if (h.inv.length >= BAG) return 'Your pack is full.';
  delete h.equip[slot];
  h.inv.push(it);
  h.hp = Math.min(h.hp, maxHp(h));
  return null;
}

// ------------------------------------------------------------------ persistence

const SAVED: Array<keyof Hero> = ['level', 'xp', 'points', 'attrs', 'hp', 'skills', 'inv', 'equip', 'coins', 'quests', 'done', 'found', 'home', 'homeName', 'stats', 'uid'];

export function heroToJSON(h: Hero): Record<string, unknown> {
  return { v: HERO_VERSION, ...Object.fromEntries(SAVED.map((k) => [k, h[k]])) };
}

/** Restore a hero from a save (tolerant: anything unreadable keeps the fresh hero's value). */
export function heroFromJSON(j: unknown, fallback: Hero): Hero {
  const h = fallback;
  if (!j || typeof j !== 'object') return h;
  // Older characters are migrated forward; a character from a newer build is never half-loaded (callers check
  // versions before loading anything, so reaching this is a bug).
  const m = migrateHero(j);
  if (!m.ok) throw new Error(m.error);
  const s = m.data;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  h.level = Math.max(1, Math.min(MAX_LEVEL, Math.floor(num(s.level, 1))));
  h.xp = Math.max(0, num(s.xp, 0)); h.points = Math.max(0, Math.floor(num(s.points, 0)));
  if (s.attrs && typeof s.attrs === 'object') for (const a of ['str', 'agi', 'vit'] as Attr[]) h.attrs[a] = Math.max(0, Math.floor(num((s.attrs as Record<string, unknown>)[a], h.attrs[a])));
  if (s.skills && typeof s.skills === 'object') for (const k of SKILLS) h.skills[k] = Math.max(0, num((s.skills as Record<string, unknown>)[k], 0));
  if (Array.isArray(s.inv)) h.inv = s.inv.filter(validItem).slice(0, BAG);
  if (s.equip && typeof s.equip === 'object') { h.equip = {}; for (const sl of SLOTS) { const it = (s.equip as Record<string, unknown>)[sl]; if (validItem(it) && ITEMS[it.id].slot === sl) h.equip[sl] = it; } }
  h.coins = Math.max(0, Math.floor(num(s.coins, h.coins)));
  if (Array.isArray(s.quests)) h.quests = (s.quests as QuestState[]).filter((q) => q && typeof q.id === 'string' && typeof q.kind === 'string');
  if (s.done && typeof s.done === 'object') h.done = Object.fromEntries(Object.entries(s.done as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  if (Array.isArray(s.found)) h.found = (s.found as unknown[]).filter((x): x is string => typeof x === 'string');
  if (Array.isArray(s.home) && s.home.length === 2 && s.home.every(Number.isFinite)) h.home = [s.home[0] as number, s.home[1] as number];
  if (typeof s.homeName === 'string') h.homeName = s.homeName;
  if (s.stats && typeof s.stats === 'object') Object.assign(h.stats, s.stats);
  h.uid = Math.max(h.uid, Math.floor(num(s.uid, 0)));
  h.hp = Math.max(1, Math.min(maxHp(h), num(s.hp, maxHp(h))));
  return h;
}
