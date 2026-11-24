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
} as const;
export type MatId = (typeof Mat)[keyof typeof Mat];
export const MAT_NAMES = ['Grass', 'Meadow', 'Dirt', 'Stone path', 'Sand', 'Stone', 'Moss', 'Cliff rock', 'Mud', 'Forest floor', 'Glade'] as const;

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
} as const;
export type CoverId = (typeof Cover)[keyof typeof Cover];
export const COVER_NAMES = ['None', 'Short grass', 'Tall grass', 'Flowers', 'Fern', 'Reeds', 'Moss', 'Leaf litter', 'Clover'] as const;
