import type { Species } from '../life/wildlife';

/** Game content: creature combat, loot, recipes, crafting stations, shops and quest givers. */

export interface CreatureCombat {
  hp: number;
  /** Attack damage, seconds between bites, reach (m); 0 damage = never attacks. */
  dmg: number; cd: number; reach: number;
  /** Body radius (m), for being hit. */
  size: number;
  /** Below this share of health it runs away. */
  fleeAt: number;
  xp: number;
}

export const CREATURE_COMBAT: Record<Species, CreatureCombat> = {
  deer: { hp: 40, dmg: 0, cd: 1, reach: 0, size: 0.8, fleeAt: 1, xp: 14 },
  fox: { hp: 22, dmg: 0, cd: 1, reach: 0, size: 0.45, fleeAt: 1, xp: 10 },
  bird: { hp: 6, dmg: 0, cd: 1, reach: 0, size: 0.35, fleeAt: 1, xp: 3 },
  wolf: { hp: 55, dmg: 7, cd: 1.1, reach: 1.5, size: 0.65, fleeAt: 0.15, xp: 32 },
  bear: { hp: 170, dmg: 17, cd: 1.6, reach: 1.9, size: 1.0, fleeAt: 0.1, xp: 95 },
};

/** Loot: [item, chance, min, max] rolled per drop. */
export const LOOT: Record<Species, Array<[string, number, number, number]>> = {
  deer: [['hide', 0.9, 1, 1], ['venison', 1, 1, 2], ['antler', 0.25, 1, 1]],
  fox: [['fox-pelt', 0.85, 1, 1]],
  bird: [['feather', 0.9, 1, 3]],
  wolf: [['wolf-pelt', 0.8, 1, 1], ['fang', 0.45, 1, 2]],
  bear: [['bear-pelt', 0.9, 1, 1], ['bear-meat', 1, 1, 2], ['claw', 0.6, 1, 2]],
};

/** Gear that can drop from beasts and old places, by tier. */
export const GEAR_DROPS = ['knife', 'club', 'spear', 'iron-dagger', 'leather-cap', 'leather-gloves', 'leather-boots', 'leather-jerkin', 'iron-helm', 'iron-sword', 'iron-gauntlets', 'iron-boots', 'mail-shirt', 'war-hammer', 'knight-sword', 'fang-necklace', 'antler-charm', 'relic-amulet'];

export type Station = 'none' | 'workbench' | 'forge' | 'hearth' | 'apothecary';
export const STATION_NAMES: Record<Station, string> = { none: 'anywhere', workbench: 'a workbench', forge: 'a forge', hearth: 'a hearth', apothecary: "an herbalist's table" };
/** Which village buildings hold which station. */
export const STATION_AT: Record<string, Station> = {
  smithy: 'forge', workshop: 'workbench', woodcarver: 'workbench', inn: 'hearth', tavern: 'hearth', longhouse: 'hearth', 'fire-pit': 'hearth',
  'elder-hall': 'hearth', smokehouse: 'hearth', herbalist: 'apothecary', shrine: 'apothecary', moonwell: 'apothecary',
};

export type Skill = 'melee' | 'defence' | 'hunting' | 'foraging' | 'woodcutting' | 'mining' | 'smithing' | 'crafting' | 'cooking' | 'trading' | 'exploration' | 'athletics';
export const SKILLS: Skill[] = ['melee', 'defence', 'hunting', 'foraging', 'woodcutting', 'mining', 'smithing', 'crafting', 'cooking', 'trading', 'exploration', 'athletics'];

export interface Recipe { id: string; out: string; n: number; station: Station; inputs: Array<[string, number]>; skill: Skill; level: number; xp: number }
const RC = (out: string, station: Station, inputs: Array<[string, number]>, skill: Skill, level = 1, xp = 12, n = 1): Recipe => ({ id: out, out, n, station, inputs, skill, level, xp });

export const RECIPES: Recipe[] = [
  RC('poultice', 'none', [['herbs', 2]], 'crafting', 1, 6),
  RC('club', 'none', [['wood', 3]], 'crafting', 1, 6),
  RC('spear', 'workbench', [['wood', 3], ['stone', 1]], 'crafting', 1, 12),
  RC('leather-cap', 'workbench', [['hide', 2]], 'crafting', 1, 12),
  RC('leather-gloves', 'workbench', [['hide', 1], ['feather', 1]], 'crafting', 1, 10),
  RC('leather-boots', 'workbench', [['hide', 2]], 'crafting', 2, 12),
  RC('leather-jerkin', 'workbench', [['hide', 4]], 'crafting', 3, 20),
  RC('wolf-cloak', 'workbench', [['wolf-pelt', 3], ['hide', 1]], 'crafting', 4, 30),
  RC('fang-necklace', 'workbench', [['fang', 3], ['hide', 1]], 'crafting', 3, 22),
  RC('antler-charm', 'workbench', [['antler', 2]], 'crafting', 2, 18),
  RC('iron-bar', 'forge', [['ore', 2]], 'smithing', 1, 8),
  RC('iron-dagger', 'forge', [['iron-bar', 1], ['wood', 1]], 'smithing', 1, 16),
  RC('pickaxe', 'forge', [['iron-bar', 1], ['wood', 2]], 'smithing', 1, 14),
  RC('iron-axe', 'forge', [['iron-bar', 2], ['wood', 2]], 'smithing', 2, 22),
  RC('iron-sword', 'forge', [['iron-bar', 3], ['wood', 1]], 'smithing', 3, 30),
  RC('iron-helm', 'forge', [['iron-bar', 2]], 'smithing', 2, 22),
  RC('iron-gauntlets', 'forge', [['iron-bar', 1], ['hide', 1]], 'smithing', 2, 18),
  RC('iron-boots', 'forge', [['iron-bar', 2]], 'smithing', 3, 22),
  RC('mail-shirt', 'forge', [['iron-bar', 5], ['hide', 1]], 'smithing', 5, 45),
  RC('roast-venison', 'hearth', [['venison', 1]], 'cooking', 1, 8),
  RC('mushroom-stew', 'hearth', [['mushroom', 2]], 'cooking', 1, 8),
  RC('bear-stew', 'hearth', [['bear-meat', 1], ['mushroom', 1]], 'cooking', 3, 16),
  RC('salve', 'apothecary', [['herbs', 3], ['mushroom', 1]], 'crafting', 2, 18),
];

/** Shops by villager job: what they sell (item ids) and what they gladly buy (item kinds or ids). */
export const SHOPS: Record<string, { sells: string[]; wants: string[] }> = {
  blacksmith: { sells: ['iron-dagger', 'iron-sword', 'iron-axe', 'pickaxe', 'iron-helm', 'iron-gauntlets', 'iron-boots', 'mail-shirt', 'iron-bar'], wants: ['weapon', 'armour', 'ore', 'iron-bar'] },
  merchant: { sells: ['bread', 'knife', 'spear', 'leather-cap', 'leather-boots', 'padded-tunic', 'herbs', 'wood', 'poultice'], wants: ['trophy', 'trinket', 'resource', 'weapon', 'armour'] },
  trader: { sells: ['bread', 'spear', 'leather-jerkin', 'leather-gloves', 'ore', 'hide', 'pickaxe', 'antler-charm'], wants: ['trophy', 'trinket', 'resource', 'weapon', 'armour'] },
  herbalist: { sells: ['herbs', 'poultice', 'salve', 'mushroom'], wants: ['herbs', 'mushroom', 'potion', 'feather'] },
  innkeeper: { sells: ['bread', 'roast-venison', 'mushroom-stew', 'bear-stew'], wants: ['venison', 'bear-meat', 'mushroom', 'food'] },
  cook: { sells: ['bread', 'roast-venison', 'mushroom-stew'], wants: ['venison', 'bear-meat', 'mushroom', 'food'] },
  brewer: { sells: ['bread', 'mushroom-stew'], wants: ['mushroom', 'herbs', 'food'] },
  carpenter: { sells: ['club', 'spear', 'wood'], wants: ['wood', 'stone', 'hide'] },
  woodcarver: { sells: ['club', 'spear', 'antler-charm', 'wood'], wants: ['wood', 'antler', 'fang'] },
  hunter: { sells: ['spear', 'leather-boots', 'hide'], wants: ['hide', 'wolf-pelt', 'bear-pelt', 'fox-pelt', 'fang', 'claw', 'antler', 'venison'] },
  trapper: { sells: ['knife', 'leather-gloves', 'fox-pelt'], wants: ['fox-pelt', 'wolf-pelt', 'hide', 'fang', 'feather'] },
};

/** Quest kinds each job gives. */
export type QuestKind = 'bounty' | 'gather' | 'explore' | 'dragon' | 'deliver' | 'craft';
export const QUEST_GIVERS: Record<string, QuestKind[]> = {
  warden: ['bounty', 'explore', 'dragon'], lookout: ['dragon', 'bounty', 'explore'], hunter: ['bounty', 'gather'], trapper: ['bounty', 'gather'], guide: ['explore', 'dragon'],
  herbalist: ['gather'], miner: ['gather'], blacksmith: ['gather', 'craft'], merchant: ['deliver', 'gather'], trader: ['deliver', 'explore'], innkeeper: ['gather', 'deliver'],
  'shrine-keeper': ['explore', 'dragon'], farmer: ['bounty', 'gather'], herder: ['bounty'],
};
