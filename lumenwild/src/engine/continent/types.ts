// Continent layout: the whole Lumenwild landmass at design level (biomes, rivers, villages, trails, sites).
// One unit = one world cell (the same cell as the playable valley, about 2 m). North is up (y grows southward).

export const SIZE = 1024;

export enum Biome { Sea = 0, Heartlands = 1, DragonPeaks = 2, GoldenPlains = 3, WhisperingMarshes = 4, Elderwood = 5, Thornwild = 6 }
export const BIOME_NAMES: Record<Biome, string> = {
  [Biome.Sea]: 'Sea', [Biome.Heartlands]: 'Heartlands', [Biome.DragonPeaks]: 'Dragon Peaks', [Biome.GoldenPlains]: 'Golden Plains',
  [Biome.WhisperingMarshes]: 'Whispering Marshes', [Biome.Elderwood]: 'Elderwood', [Biome.Thornwild]: 'Thornwild',
};

/** Natural water per cell. */
export enum Water { None = 0, Sea = 1, Lake = 2, River = 3, Marsh = 4 }

/** Land use per cell. Everything not listed is natural wilderness (natural water included). */
export enum Use { Wild = 0, Village = 1, Farmland = 2, Outpost = 3, Trail = 4, Special = 5, AncientRoad = 6 }

export type Pt = [number, number];
export interface Rect { x: number; y: number; w: number; h: number }

export interface River { id: string; name: string; points: Pt[]; halfWidth: number[]; bed: number[] }
export interface Lake { id: string; name: string; x: number; y: number; r: number; level: number }
export interface Fall { river: string; x: number; y: number; drop: number }
export interface Cave { x: number; y: number; lair: boolean }

export interface Territory { id: string; name: string; dragon: string; x: number; y: number; r: number; lair: Pt }
export interface Habitat { id: string; species: string[]; x: number; y: number; r: number }

export type CultureId = 'heartlands-timber' | 'frost-lodge' | 'plains-farmstead' | 'marsh-stilt' | 'elder-grove';

export type BuildingType =
  | 'home' | 'farmhouse' | 'barn' | 'inn' | 'smithy' | 'market-hall' | 'market-stall' | 'well' | 'shrine' | 'water-mill'
  | 'stable' | 'workshop' | 'granary' | 'windmill' | 'trading-post' | 'longhouse' | 'cabin' | 'mine-head' | 'storehouse'
  | 'smokehouse' | 'watch-post' | 'stilt-house' | 'fishing-hut' | 'herbalist' | 'net-shed' | 'lantern-deck' | 'tree-house'
  | 'root-house' | 'elder-hall' | 'woodcarver' | 'moonwell' | 'fire-pit' | 'tavern';

export interface Building {
  id: string;
  type: BuildingType;
  /** Footprint (axis-aligned; `w` runs along the facing lane). */
  x: number; y: number; w: number; h: number;
  /** Counted as a building (false for wells, stalls, decks, fire pits). */
  counts: boolean;
  floors: number;
  /** Raised on stilts (marsh) or set in a tree (Elderwood). */
  raised: boolean;
}

export type ActivityPlace = 'home' | 'work' | 'communal' | 'market' | 'fields' | 'water' | 'forest' | 'mine' | 'wilds' | 'shelter';
export type Activity = 'sleep' | 'eat' | 'work' | 'gather' | 'trade' | 'patrol' | 'forage' | 'rest' | 'shelter';

export interface Resident {
  id: string;
  occupation: string;
  home: string;
  /** Building id, or a named area of the village (fields, water, forest, mine, wilds). */
  work: string;
}

export interface Village {
  id: string;
  name: string;
  biome: Biome;
  /** Design coordinates from the settlement brief. */
  at: Pt;
  /** The centre actually used (moved to the nearest suitable ground if needed). */
  centre: Pt;
  culture: CultureId;
  buildings: Building[];
  lanes: Pt[][];
  fields: Rect[];
  pens: Rect[];
  /** Gathering places (square, fire pit, deck, glade) and the building everyone shelters in. */
  communal: Pt[];
  shelter: string;
  residents: Resident[];
  /** Share of the village's land (buildings, yards, lanes, farmland) that was ancient forest (cover ≥ 215) and was cleared. */
  clearedAncient: number;
}

export type OutpostKind = 'ranger-cabin' | 'hunter-camp' | 'mountain-shelter' | 'watchtower' | 'travellers-camp';
export interface Outpost { id: string; kind: OutpostKind; x: number; y: number; onTrail: boolean }

export type SpecialKind = 'ruin' | 'dungeon' | 'landmark' | 'lair' | 'abandoned-hamlet';
export interface Special { id: string; kind: SpecialKind; name: string; x: number; y: number; r: number }

export type TrailKind = 'footpath' | 'forest-trail' | 'mountain-pass' | 'boardwalk' | 'spur' | 'ancient-road';
export interface Trail { id: string; kind: TrailKind; from: string; to: string; cells: Pt[] }
export type CrossingKind = 'wooden-bridge' | 'stone-crossing' | 'boardwalk';
export interface Crossing { x: number; y: number; kind: CrossingKind; trail: string }

export interface LandStats {
  landCells: number;
  /** Shares of land in percent. */
  wilderness: number;
  settlements: number;
  special: number;
  /** Parts of `settlements`. */
  villages: number;
  farmland: number;
  outposts: number;
  trails: number;
  /** Land within 10 cells of an active trail, percent (many areas should have no road). */
  nearTrail: number;
  buildings: number;
  population: number;
  /** Non-wilderness share inside dragon territories and wildlife habitat cores, percent. */
  territoryDisturbance: number;
  habitatDisturbance: number;
}

export interface Continent {
  seed: number;
  size: number;
  height: Float32Array;
  biome: Uint8Array;
  water: Uint8Array;
  use: Uint8Array;
  /** Tree cover 0..255. */
  forest: Uint8Array;
  rivers: River[];
  lakes: Lake[];
  falls: Fall[];
  caves: Cave[];
  territories: Territory[];
  habitats: Habitat[];
  villages: Village[];
  outposts: Outpost[];
  specials: Special[];
  trails: Trail[];
  crossings: Crossing[];
  stats: LandStats;
  ms: Record<string, number>;
}
