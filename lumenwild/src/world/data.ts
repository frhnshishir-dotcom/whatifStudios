import world from '../../world/config/world.json';
import coordinates from '../../world/config/coordinates.json';
import regions from '../../world/config/regions.json';
import coastline from '../../world/geography/coastline.json';
import ranges from '../../world/geography/mountain-ranges.json';
import elevation from '../../world/geography/elevation.json';
import lakes from '../../world/geography/lakes.json';
import rivers from '../../world/geography/rivers.json';
import settlements from '../../world/settlements/settlements.json';
import landmarks from '../../world/landmarks/landmarks.json';
import roads from '../../world/roads/roads.json';
import habitats from '../../world/creatures/habitats.json';
import territories from '../../world/dragons/territories.json';
import flight from '../../world/dragons/flight-routes.json';
import discovery from '../../world/discovery/discovery.json';
import type { WorldData } from './schema';

/** The world data files, as one typed object. Validate with `validateWorld` before use. */
export const WORLD: WorldData = {
  world, coordinates, regions, coastline, ranges, elevation, lakes, rivers, settlements, landmarks, roads, habitats, territories, flight, discovery,
} as unknown as WorldData;
