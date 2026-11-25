import { Biome, type BuildingType, type CultureId, type Pt } from './types';

/** Where a building type wants to stand. `near:<type>` = next to a building of that type. */
export type Zone = 'centre' | 'lane' | 'outer' | 'water' | 'tree' | 'high' | `near:${BuildingType}`;

export interface BuildingSpec {
  w: number; h: number;
  /** Counted as a building (wells, stalls, decks and fire pits are not). */
  counts: boolean;
  floors: number;
  /** People living in it (min, max). */
  residents: [number, number];
  /** Jobs it provides. */
  jobs: string[];
}

export const SPECS: Record<BuildingType, BuildingSpec> = {
  home: { w: 5, h: 3, counts: true, floors: 1, residents: [2, 5], jobs: [] },
  farmhouse: { w: 6, h: 4, counts: true, floors: 2, residents: [4, 7], jobs: [] },
  barn: { w: 7, h: 4, counts: true, floors: 1, residents: [0, 0], jobs: [] },
  inn: { w: 7, h: 5, counts: true, floors: 2, residents: [2, 3], jobs: ['innkeeper', 'cook'] },
  smithy: { w: 5, h: 4, counts: true, floors: 1, residents: [1, 2], jobs: ['blacksmith'] },
  'market-hall': { w: 7, h: 4, counts: true, floors: 1, residents: [0, 0], jobs: ['merchant', 'merchant'] },
  'market-stall': { w: 2, h: 2, counts: false, floors: 0, residents: [0, 0], jobs: [] },
  well: { w: 1, h: 1, counts: false, floors: 0, residents: [0, 0], jobs: [] },
  shrine: { w: 3, h: 3, counts: true, floors: 1, residents: [0, 0], jobs: ['shrine-keeper'] },
  'water-mill': { w: 4, h: 3, counts: true, floors: 2, residents: [1, 2], jobs: ['miller'] },
  stable: { w: 6, h: 3, counts: true, floors: 1, residents: [0, 0], jobs: ['groom'] },
  workshop: { w: 5, h: 4, counts: true, floors: 1, residents: [0, 0], jobs: ['carpenter'] },
  granary: { w: 4, h: 4, counts: true, floors: 1, residents: [0, 0], jobs: [] },
  windmill: { w: 3, h: 3, counts: true, floors: 3, residents: [0, 0], jobs: ['miller'] },
  'trading-post': { w: 6, h: 4, counts: true, floors: 1, residents: [1, 2], jobs: ['trader'] },
  longhouse: { w: 9, h: 4, counts: true, floors: 1, residents: [0, 0], jobs: ['cook'] },
  cabin: { w: 4, h: 3, counts: true, floors: 1, residents: [1, 3], jobs: [] },
  'mine-head': { w: 4, h: 4, counts: true, floors: 1, residents: [0, 0], jobs: ['miner', 'miner'] },
  storehouse: { w: 4, h: 3, counts: true, floors: 1, residents: [0, 0], jobs: [] },
  smokehouse: { w: 3, h: 3, counts: true, floors: 1, residents: [0, 0], jobs: ['smoker'] },
  'watch-post': { w: 2, h: 2, counts: true, floors: 3, residents: [0, 0], jobs: ['lookout'] },
  'stilt-house': { w: 4, h: 4, counts: true, floors: 1, residents: [2, 4], jobs: [] },
  'fishing-hut': { w: 3, h: 3, counts: true, floors: 1, residents: [0, 0], jobs: [] },
  herbalist: { w: 4, h: 4, counts: true, floors: 1, residents: [1, 2], jobs: ['herbalist'] },
  'net-shed': { w: 3, h: 2, counts: true, floors: 1, residents: [0, 0], jobs: ['netmaker'] },
  'lantern-deck': { w: 5, h: 5, counts: false, floors: 0, residents: [0, 0], jobs: ['lamplighter'] },
  'tree-house': { w: 3, h: 3, counts: true, floors: 2, residents: [1, 3], jobs: [] },
  'root-house': { w: 4, h: 3, counts: true, floors: 1, residents: [2, 4], jobs: [] },
  'elder-hall': { w: 7, h: 5, counts: true, floors: 1, residents: [1, 1], jobs: ['warden'] },
  woodcarver: { w: 4, h: 3, counts: true, floors: 1, residents: [1, 2], jobs: ['woodcarver'] },
  moonwell: { w: 3, h: 3, counts: false, floors: 0, residents: [0, 0], jobs: [] },
  'fire-pit': { w: 3, h: 3, counts: false, floors: 0, residents: [0, 0], jobs: [] },
  tavern: { w: 6, h: 4, counts: true, floors: 2, residents: [1, 2], jobs: ['brewer'] },
};

export interface Architecture {
  walls: string;
  roof: string;
  foundation: string;
  layout: 'square-and-lanes' | 'terrace-cluster' | 'linear-street' | 'boardwalk-spine' | 'grove';
  signature: BuildingType[];
  /** Colours for both renderers (hex). */
  palette: { roof: string; wall: string; trim: string; accent: string };
}

export interface Culture {
  id: CultureId;
  architecture: Architecture;
  /** [type, min, max, zone] in placement order. */
  program: Array<[BuildingType, number, number, Zone]>;
  lanes: { count: number; length: number; wind: number; follow: 'none' | 'river' | 'contour' };
  /** Max distance of buildings from the centre, and of fields. */
  coreR: number;
  fieldR: number;
  /** Farmland, pasture, ponds or gardens to lay out (cells), plot size range [w0, w1, h0, h1]. */
  farm: { kind: 'fields' | 'pasture' | 'ponds' | 'gardens'; target: number; plot: [number, number, number, number]; maxForest: number };
  pens: number;
  /** Max height difference across one footprint (m). */
  flatTol: number;
  /** Open-ended work for residents without a building job, with weights. */
  trades: Array<[string, number, 'fields' | 'water' | 'forest' | 'mine' | 'wilds' | 'market']>;
  /** Gathering place built at the centre, and the building everyone shelters in. */
  communal: BuildingType;
  shelter: BuildingType;
}

export const CULTURES: Record<CultureId, Culture> = {
  'heartlands-timber': {
    id: 'heartlands-timber',
    architecture: { walls: 'whitewashed timber frame and wattle', roof: 'thatch (shingle on inn and smithy)', foundation: 'fieldstone plinth', layout: 'square-and-lanes',
      signature: ['market-hall', 'inn', 'smithy', 'water-mill'], palette: { roof: '#c9a35a', wall: '#e8dcc0', trim: '#4a3524', accent: '#d9822b' } },
    program: [['well', 1, 1, 'centre'], ['inn', 1, 1, 'centre'], ['market-hall', 1, 1, 'centre'], ['smithy', 1, 1, 'centre'], ['market-stall', 3, 3, 'centre'],
      ['shrine', 1, 1, 'lane'], ['water-mill', 1, 1, 'water'], ['stable', 1, 1, 'near:inn'], ['workshop', 1, 1, 'lane'], ['home', 10, 13, 'lane'],
      ['farmhouse', 3, 4, 'outer'], ['barn', 2, 3, 'near:farmhouse'], ['granary', 1, 1, 'near:water-mill']],
    lanes: { count: 4, length: 34, wind: 0.12, follow: 'none' }, coreR: 40, fieldR: 90,
    farm: { kind: 'fields', target: 9500, plot: [12, 22, 7, 11], maxForest: 170 }, pens: 2, flatTol: 2.2,
    trades: [['farmer', 5, 'fields'], ['herder', 1, 'fields'], ['woodcutter', 1, 'forest']],
    communal: 'well', shelter: 'inn',
  },
  'frost-lodge': {
    id: 'frost-lodge',
    architecture: { walls: 'logs on dry-stone courses', roof: 'steep slate shingle, snow-laden', foundation: 'cut stone, half sunk into the slope', layout: 'terrace-cluster',
      signature: ['longhouse', 'mine-head', 'smokehouse', 'watch-post'], palette: { roof: '#3b4250', wall: '#6b4a32', trim: '#5d636b', accent: '#e6eef2' } },
    program: [['fire-pit', 1, 1, 'centre'], ['longhouse', 1, 1, 'centre'], ['trading-post', 1, 1, 'centre'], ['smithy', 1, 1, 'lane'], ['cabin', 7, 10, 'lane'],
      ['storehouse', 2, 2, 'near:longhouse'], ['smokehouse', 1, 1, 'near:storehouse'], ['mine-head', 1, 1, 'high'], ['watch-post', 1, 1, 'high']],
    lanes: { count: 3, length: 22, wind: 0.3, follow: 'contour' }, coreR: 28, fieldR: 62,
    farm: { kind: 'pasture', target: 4000, plot: [10, 16, 7, 11], maxForest: 200 }, pens: 1, flatTol: 4,
    trades: [['hunter', 4, 'wilds'], ['miner', 3, 'mine'], ['trapper', 1, 'wilds'], ['guide', 1, 'wilds']],
    communal: 'fire-pit', shelter: 'longhouse',
  },
  'plains-farmstead': {
    id: 'plains-farmstead',
    architecture: { walls: 'whitewashed cob on rubble', roof: 'red clay tile, thatched barns', foundation: 'packed earth and rubble', layout: 'linear-street',
      signature: ['windmill', 'barn', 'granary', 'trading-post'], palette: { roof: '#b5573a', wall: '#efe6d2', trim: '#8c3b2e', accent: '#e7c35a' } },
    program: [['well', 1, 1, 'centre'], ['trading-post', 1, 1, 'centre'], ['tavern', 1, 1, 'centre'], ['granary', 1, 1, 'lane'], ['home', 4, 6, 'lane'],
      ['farmhouse', 4, 5, 'outer'], ['barn', 3, 4, 'near:farmhouse'], ['stable', 1, 1, 'near:farmhouse'], ['windmill', 3, 3, 'high']],
    lanes: { count: 2, length: 58, wind: 0.08, follow: 'river' }, coreR: 62, fieldR: 120,
    farm: { kind: 'fields', target: 18000, plot: [16, 28, 9, 14], maxForest: 140 }, pens: 4, flatTol: 2.2,
    trades: [['farmer', 6, 'fields'], ['herder', 2, 'fields'], ['carter', 1, 'market']],
    communal: 'well', shelter: 'tavern',
  },
  'marsh-stilt': {
    id: 'marsh-stilt',
    architecture: { walls: 'reed panels on weathered plank', roof: 'steep reed thatch', foundation: 'timber stilts above the waterline', layout: 'boardwalk-spine',
      signature: ['stilt-house', 'fishing-hut', 'lantern-deck', 'herbalist'], palette: { roof: '#a39a6a', wall: '#7b7466', trim: '#4e4a3e', accent: '#c8e07a' } },
    program: [['lantern-deck', 1, 1, 'centre'], ['longhouse', 1, 1, 'centre'], ['herbalist', 1, 1, 'lane'], ['stilt-house', 6, 8, 'lane'],
      ['fishing-hut', 2, 3, 'water'], ['net-shed', 1, 1, 'water'], ['smokehouse', 1, 1, 'near:fishing-hut']],
    lanes: { count: 3, length: 30, wind: 0.15, follow: 'river' }, coreR: 34, fieldR: 52,
    farm: { kind: 'ponds', target: 3600, plot: [7, 12, 5, 9], maxForest: 220 }, pens: 0, flatTol: 3,
    trades: [['fisher', 5, 'water'], ['reed-cutter', 1, 'water'], ['gatherer', 1, 'forest']],
    communal: 'lantern-deck', shelter: 'longhouse',
  },
  'elder-grove': {
    id: 'elder-grove',
    architecture: { walls: 'living wood and carved timber', roof: 'moss and bark shingle', foundation: 'roots; tree houses on giant trunks', layout: 'grove',
      signature: ['tree-house', 'root-house', 'elder-hall', 'moonwell'], palette: { roof: '#4f6b3a', wall: '#5a4433', trim: '#3a2d22', accent: '#9fc4e8' } },
    program: [['moonwell', 1, 1, 'centre'], ['elder-hall', 1, 1, 'centre'], ['woodcarver', 1, 1, 'lane'], ['tree-house', 4, 6, 'tree'],
      ['root-house', 4, 6, 'lane'], ['storehouse', 1, 1, 'lane']],
    lanes: { count: 3, length: 30, wind: 0.45, follow: 'none' }, coreR: 36, fieldR: 50,
    farm: { kind: 'gardens', target: 2400, plot: [5, 8, 4, 7], maxForest: 165 }, pens: 0, flatTol: 3,
    trades: [['forester', 3, 'forest'], ['gatherer', 3, 'forest'], ['beekeeper', 1, 'forest']],
    communal: 'moonwell', shelter: 'elder-hall',
  },
};

export interface VillageDesign { id: string; name: string; biome: Biome; at: Pt; culture: CultureId; buildings: [number, number] }

/** The five villages of the settlement brief (building ranges are design targets). */
export const VILLAGE_DESIGNS: VillageDesign[] = [
  { id: 'greenhaven', name: 'Greenhaven', biome: Biome.Heartlands, at: [390, 510], culture: 'heartlands-timber', buildings: [20, 30] },
  { id: 'frostwatch', name: 'Frostwatch', biome: Biome.DragonPeaks, at: [430, 300], culture: 'frost-lodge', buildings: [10, 20] },
  { id: 'windmere', name: 'Windmere', biome: Biome.GoldenPlains, at: [190, 760], culture: 'plains-farmstead', buildings: [15, 25] },
  { id: 'marshlight', name: 'Marshlight', biome: Biome.WhisperingMarshes, at: [690, 700], culture: 'marsh-stilt', buildings: [10, 15] },
  { id: 'moonrest', name: 'Moonrest', biome: Biome.Elderwood, at: [260, 390], culture: 'elder-grove', buildings: [10, 20] },
];
