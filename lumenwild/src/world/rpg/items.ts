/**
 * Items: definitions, rarity and instances. Pure data and functions (browser and server).
 *
 * An item instance has a unique id (for equip, sell and trade commands), a definition id, a count (stacks), a rarity
 * and, from Rare up, one or two bonus properties. Value scales with rarity and properties.
 */

export type Slot = 'weapon' | 'head' | 'body' | 'hands' | 'feet' | 'trinket';
export const SLOTS: Slot[] = ['weapon', 'head', 'body', 'hands', 'feet', 'trinket'];
export type ItemKind = 'weapon' | 'armour' | 'trinket' | 'resource' | 'food' | 'potion' | 'trophy' | 'quest';
export type Tool = 'axe' | 'pick';

export interface ItemDef {
  id: string; name: string; kind: ItemKind;
  slot?: Slot;
  /** Max stack (1 for equipment). */
  stack: number;
  /** Base value in coins. */
  value: number;
  /** Weapons: damage, seconds between swings, reach (m), how many it can hit in one swing. */
  dmg?: number; cd?: number; reach?: number; cleave?: number;
  /** Armour points. */
  armour?: number;
  /** Food and potions: health restored, stamina restored (0..1). */
  heal?: number; rest?: number;
  tool?: Tool;
  /** Fixed bonus properties (trinkets). */
  props?: Partial<Record<Prop, number>>;
  desc: string;
}

/** Bonus properties: max health, crit chance (%), health regen (/s), damage (%), armour, stamina efficiency (%). */
export type Prop = 'hp' | 'crit' | 'regen' | 'dmg' | 'armour' | 'stam';
export const PROP_NAMES: Record<Prop, (v: number) => string> = {
  hp: (v) => `+${v} health`, crit: (v) => `+${v}% critical`, regen: (v) => `+${v} health/s`, dmg: (v) => `+${v}% damage`, armour: (v) => `+${v} armour`, stam: (v) => `-${v}% stamina use`,
};

const W = (id: string, name: string, dmg: number, cd: number, reach: number, value: number, desc: string, extra: Partial<ItemDef> = {}): ItemDef => ({ id, name, kind: 'weapon', slot: 'weapon', stack: 1, value, dmg, cd, reach, cleave: 1, desc, ...extra });
const A = (id: string, name: string, slot: Slot, armour: number, value: number, desc: string, extra: Partial<ItemDef> = {}): ItemDef => ({ id, name, kind: 'armour', slot, stack: 1, value, armour, desc, ...extra });
const R = (id: string, name: string, value: number, desc: string, kind: ItemKind = 'resource'): ItemDef => ({ id, name, kind, stack: 50, value, desc });
const F = (id: string, name: string, heal: number, rest: number, value: number, desc: string, kind: ItemKind = 'food'): ItemDef => ({ id, name, kind, stack: 20, value, heal, rest, desc });

export const ITEMS: Record<string, ItemDef> = Object.fromEntries((<ItemDef[]>[
  // Weapons
  W('knife', "Traveller's knife", 6, 0.45, 1.5, 6, 'A short, quick blade.'),
  W('club', 'Wooden club', 8, 0.7, 1.6, 4, 'Heavy and honest.'),
  W('spear', 'Hunting spear', 10, 0.8, 2.6, 14, 'Long reach: keeps wolves at a distance.'),
  W('iron-dagger', 'Iron dagger', 9, 0.42, 1.5, 24, 'Fast, and quick to find a gap.', { props: { crit: 5 } }),
  W('iron-sword', 'Iron sword', 14, 0.62, 1.9, 48, 'Cuts through two foes in one swing.', { cleave: 2 }),
  W('iron-axe', 'Iron axe', 16, 0.85, 1.7, 40, 'A weapon and a woodcutter’s tool.', { tool: 'axe' }),
  W('pickaxe', 'Pickaxe', 7, 0.9, 1.6, 22, 'Breaks ore out of rock.', { tool: 'pick' }),
  W('war-hammer', 'War hammer', 22, 1.1, 1.8, 90, 'Slow, crushing blows.'),
  W('knight-sword', "Knight's sword", 19, 0.6, 2.0, 140, 'Fine steel from the old forges.', { cleave: 2 }),
  // Armour
  A('padded-tunic', 'Padded tunic', 'body', 3, 6, 'Quilted cloth.'),
  A('leather-cap', 'Leather cap', 'head', 2, 10, 'Hardened leather.'),
  A('leather-jerkin', 'Leather jerkin', 'body', 5, 22, 'Hide, stitched double.'),
  A('leather-gloves', 'Leather gloves', 'hands', 1, 8, 'Good grip.'),
  A('leather-boots', 'Leather boots', 'feet', 1, 10, 'Soft-soled for stalking.'),
  A('wolf-cloak', 'Wolf-hide cloak', 'body', 6, 36, 'Warm, and wolves smell their own.', { props: { hp: 10 } }),
  A('iron-helm', 'Iron helm', 'head', 4, 30, 'Rings when struck.'),
  A('mail-shirt', 'Mail shirt', 'body', 9, 70, 'Iron rings, riveted.'),
  A('iron-gauntlets', 'Iron gauntlets', 'hands', 2, 24, 'Plated knuckles.'),
  A('iron-boots', 'Iron boots', 'feet', 2, 26, 'Heavy, sure-footed.'),
  // Trinkets
  { id: 'fang-necklace', name: 'Fang necklace', kind: 'trinket', slot: 'trinket', stack: 1, value: 30, props: { crit: 4 }, desc: 'Wolf fangs on a cord.' },
  { id: 'antler-charm', name: 'Antler charm', kind: 'trinket', slot: 'trinket', stack: 1, value: 26, props: { hp: 12 }, desc: 'Carved for luck.' },
  { id: 'relic-amulet', name: 'Old amulet', kind: 'trinket', slot: 'trinket', stack: 1, value: 80, props: { regen: 1, armour: 2 }, desc: 'From before the villages.' },
  // Resources
  R('wood', 'Wood', 1, 'Logs and branches.'), R('stone', 'Stone', 1, 'Rough stone.'), R('ore', 'Iron ore', 4, 'Rusty-red rock.'),
  R('iron-bar', 'Iron bar', 10, 'Smelted iron.'), R('hide', 'Hide', 4, 'Deer hide.'), R('wolf-pelt', 'Wolf pelt', 9, 'Grey fur.'),
  R('bear-pelt', 'Bear pelt', 22, 'Thick brown fur.'), R('fox-pelt', 'Fox pelt', 8, 'Russet fur.'), R('feather', 'Feather', 1, 'Light and bright.'),
  R('fang', 'Wolf fang', 5, 'Sharp.'), R('claw', 'Bear claw', 12, 'Long and curved.'), R('antler', 'Antler', 7, 'A stag’s.'),
  R('herbs', 'Herbs', 3, 'Healing leaves.'), R('mushroom', 'Mushroom', 2, 'Edible, probably.'),
  R('venison', 'Raw venison', 3, 'Cook it first.'), R('bear-meat', 'Raw bear meat', 5, 'Cook it first.'),
  R('relic', 'Relic', 30, 'A carved stone from an older age.', 'trophy'),
  { id: 'parcel', name: 'Parcel', kind: 'quest', stack: 5, value: 0, desc: 'Wrapped and tied. Not yours to open.' },
  // Food and potions
  F('bread', 'Bread', 15, 0.1, 3, 'Fresh enough.'),
  F('roast-venison', 'Roast venison', 30, 0.2, 9, 'Hot and filling.'),
  F('mushroom-stew', 'Mushroom stew', 22, 0.5, 8, 'Warms you through.'),
  F('bear-stew', 'Bear stew', 45, 0.4, 16, 'A hunter’s meal.'),
  F('poultice', 'Herbal poultice', 15, 0, 6, 'Pressed onto wounds.', 'potion'),
  F('salve', 'Healing salve', 55, 0.2, 22, 'The herbalist’s best.', 'potion'),
]).map((d) => [d.id, d]));

export type Rarity = 0 | 1 | 2 | 3 | 4;
export const RARITY = [
  { name: 'Common', mult: 1, colour: '#c8c8c8' },
  { name: 'Uncommon', mult: 1.15, colour: '#6fd36f' },
  { name: 'Rare', mult: 1.32, colour: '#5ca8ff' },
  { name: 'Epic', mult: 1.55, colour: '#c07cff' },
  { name: 'Legendary', mult: 1.85, colour: '#ffb347' },
] as const;

export interface Item {
  uid: string;
  id: string;
  n: number;
  r: Rarity;
  props?: Partial<Record<Prop, number>>;
}

export type Rng = () => number;

/** Mulberry32: small, fast, seedable. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const isGear = (d: ItemDef) => d.kind === 'weapon' || d.kind === 'armour' || d.kind === 'trinket';

/** Roll a rarity: mostly common; `bonus` (0..2, from skill or a good source) shifts it up. */
export function rollRarity(r: Rng, bonus = 0): Rarity {
  const x = r() * (1 - Math.min(0.6, bonus * 0.22));
  return (x < 0.012 ? 4 : x < 0.05 ? 3 : x < 0.16 ? 2 : x < 0.42 ? 1 : 0) as Rarity;
}

const PROP_ROLL: Array<[Prop, number, number]> = [['hp', 6, 20], ['crit', 2, 6], ['regen', 0.5, 1.5], ['dmg', 4, 12], ['armour', 1, 4], ['stam', 5, 15]];

/** A new item. Gear gets a rarity (given, or rolled with `bonus`) and, from Rare up, bonus properties. */
export function makeItem(id: string, n: number, uid: string, r: Rng | null = null, rarity?: Rarity, bonus = 0): Item {
  const d = ITEMS[id];
  if (!d) throw new Error(`unknown item ${id}`);
  if (!isGear(d)) return { uid, id, n: Math.min(n, d.stack), r: 0 };
  const rar = rarity ?? (r ? rollRarity(r, bonus) : 0);
  const it: Item = { uid, id, n: 1, r: rar };
  if (rar >= 2 && r) {
    it.props = {};
    for (let k = 0; k < rar - 1 && k < 2; k++) {
      const [p, lo, hi] = PROP_ROLL[Math.floor(r() * PROP_ROLL.length)];
      const v = lo + r() * (hi - lo) * (0.6 + rar * 0.1);
      it.props[p] = Math.round(((it.props[p] ?? 0) + v) * (p === 'regen' ? 10 : 1)) / (p === 'regen' ? 10 : 1);
    }
  }
  return it;
}

export function itemName(it: Item): string {
  const d = ITEMS[it.id];
  return isGear(d) && it.r > 0 ? `${RARITY[it.r].name} ${d.name.toLowerCase()}` : d.name;
}

/** Value in coins (for the whole stack). */
export function itemValue(it: Item): number {
  const d = ITEMS[it.id];
  let v = d.value * (isGear(d) ? RARITY[it.r].mult ** 2 : 1);
  if (it.props) v *= 1 + Object.keys(it.props).length * 0.25;
  return Math.max(0, Math.round(v * it.n));
}

/** All bonus properties of an item (fixed ones from its definition plus rolled ones). */
export function itemProps(it: Item): Partial<Record<Prop, number>> {
  const out: Partial<Record<Prop, number>> = { ...(ITEMS[it.id].props ?? {}) };
  for (const [k, v] of Object.entries(it.props ?? {})) out[k as Prop] = (out[k as Prop] ?? 0) + (v as number);
  return out;
}

/** One line describing an item's numbers. */
export function itemStats(it: Item): string {
  const d = ITEMS[it.id], m = RARITY[it.r].mult, bits: string[] = [];
  if (d.dmg) bits.push(`${Math.round(d.dmg * m)} dmg`, `${d.cd}s`, `${d.reach} m`);
  if (d.armour) bits.push(`${Math.round(d.armour * m)} armour`);
  if (d.heal) bits.push(`+${d.heal} health`);
  if (d.tool) bits.push(d.tool === 'axe' ? 'chops wood' : 'mines ore');
  for (const [k, v] of Object.entries(itemProps(it))) bits.push(PROP_NAMES[k as Prop](v as number));
  return bits.join(' · ');
}

export function validItem(j: unknown): j is Item {
  if (!j || typeof j !== 'object') return false;
  const it = j as Item;
  return typeof it.uid === 'string' && typeof it.id === 'string' && !!ITEMS[it.id] && Number.isInteger(it.n) && it.n > 0 && it.n <= ITEMS[it.id].stack && [0, 1, 2, 3, 4].includes(it.r);
}
