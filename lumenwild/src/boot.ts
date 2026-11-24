import { FONT_CHARS } from './engine/render/glyphs';
import { World, sharedAlloc, heapAlloc, canShare } from './engine/world/World';
import { WaterSystem } from './engine/water/WaterSystem';
import { seedSources } from './engine/gen/water';
import { buildWaterTest, waterTestWater } from './engine/gen/testScenes';
import { Engine } from './engine/Engine';
import { generateTerrain } from './engine/gen/terrain';

/** Load the bundled fonts for every glyph the atlas needs (unicode-range subsets load on demand). */
export async function loadFonts(timeoutMs = 5000): Promise<void> {
  const loads = Promise.all([
    document.fonts.load('16px "Noto Sans Mono"', FONT_CHARS),
    document.fonts.load('16px "Noto Sans Symbols 2"', FONT_CHARS),
  ]);
  await Promise.race([loads, new Promise((r) => setTimeout(r, timeoutMs))]);
}

export function createWorld(seed: number, size = 256, share = canShare()): World {
  const world = new World(size, size, share ? sharedAlloc : heapAlloc);
  world.seed = seed;
  world.name = `Vale ${seed}`;
  generateTerrain(world, seed);
  return world;
}

/** scene: 'world' (generated) or 'watertest' (deterministic water test world). */
export function createEngine(seed: number, scene = 'world', opts: { worker?: boolean } = {}): Engine {
  const share = canShare() && opts.worker !== false;
  let world: World;
  if (scene === 'watertest') {
    world = new World(256, 256, share ? sharedAlloc : heapAlloc);
    world.name = 'Water test';
    world.seed = seed;
    buildWaterTest(world);
  } else world = createWorld(seed, 256, share);
  const engine = new Engine(world);
  const water = new WaterSystem(world, { useWorker: share });
  engine.attachWater(water);
  if (scene === 'watertest') waterTestWater(world, water);
  else { seedSources(world, water); water.warmup(900); }
  return engine;
}
