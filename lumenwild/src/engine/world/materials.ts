// Ground materials (one per world cell) and ground cover (vegetation layer on top of the material).
// Plain const objects (not const enums) so isolatedModules builds and workers can share them.

export const Mat = {
  Grass: 0,
  Meadow: 1,
  Dirt: 2,
  Path: 3,
  Sand: 4,
  Stone: 5,
  Moss: 6,
  Cliff: 7,
  Mud: 8,
  ForestFloor: 9,
  Glade: 10, // magical glowing ground
  Snow: 11,
  // Continent biomes (not used by the valley generator).
  DryGrass: 12, // golden grassland of the Golden Plains
  Ash: 13, // corrupted soil of the Hollow Lands
  Bog: 14, // waterlogged peat of the Whispering Marshes
  Scree: 15, // loose mountain rock above the tree line
} as const;
export type MatId = (typeof Mat)[keyof typeof Mat];
export const MAT_NAMES = ['Grass', 'Meadow', 'Dirt', 'Stone path', 'Sand', 'Stone', 'Moss', 'Cliff rock', 'Mud', 'Forest floor', 'Glade', 'Snow', 'Dry grass', 'Ash', 'Bog', 'Scree'] as const;

export const Cover = {
  None: 0,
  ShortGrass: 1,
  TallGrass: 2,
  Flowers: 3,
  Fern: 4,
  Reeds: 5,
  MossPatch: 6,
  Litter: 7, // fallen leaves / needles
  Clover: 8,
  GoldenGrass: 9, // tall golden grass
  Embers: 10, // glowing red glints on corrupted ground
  Thorns: 11, // dead, dark brambles
} as const;
export type CoverId = (typeof Cover)[keyof typeof Cover];
export const COVER_NAMES = ['None', 'Short grass', 'Tall grass', 'Flowers', 'Fern', 'Reeds', 'Moss', 'Leaf litter', 'Clover', 'Golden grass', 'Embers', 'Thorns'] as const;
