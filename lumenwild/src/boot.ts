import { FONT_CHARS } from './engine/render/glyphs';
import { World, sharedAlloc, heapAlloc, canShare } from './engine/world/World';
import { WaterSystem } from './engine/water/WaterSystem';
import { seedSources } from './engine/gen/water';
import { buildWaterTest, waterTestWater } from './engine/gen/testScenes';
import { Engine } from './engine/Engine';
import { generateTerrain } from './engine/gen/terrain';
import { generateWorld, prefillWater, type GenInfo } from './engine/gen/world';
import { ObjectStore } from './engine/objects/ObjectStore';
import { Dragon } from './engine/dragon/Dragon';

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

/** Generated world plus its objects and generator report. */
export function generateVale(seed: number, share = canShare()): { world: World; objects: ObjectStore; info: GenInfo } {
  const world = new World(256, 256, share ? sharedAlloc : heapAlloc);
  world.seed = seed;
  world.name = `Vale ${seed}`;
  const objects = new ObjectStore(world);
  const info = generateWorld(world, objects, seed);
  return { world, objects, info };
}

/** River source rate (m^3/s per source cell group) for generated worlds. */
export const RIVER_RATE = 5;

/**
 * scene: 'world' (generated vale), 'terrain' (bare heightmap, M1 test) or 'watertest' (deterministic water test).
 */
export function createEngine(seed: number, scene = 'world', opts: { worker?: boolean } = {}): Engine {
  const share = canShare() && opts.worker !== false;
  if (scene === 'world') {
    const { world, objects, info } = generateVale(seed, share);
    const engine = new Engine(world);
    engine.setObjects(objects);
    engine.gen = info;
    // Open on the bridge (river, cottage and a waterfall nearby).
    const xt = info.features.find((f) => f.kind === 'christmas tree'), br = info.features.find((f) => f.kind === 'bridge');
    if (xt) engine.home = [xt.x, xt.y - 6];
    else if (br) engine.home = [br.x, br.y + 6];
    const water = new WaterSystem(world, { useWorker: share, init: (_sim, view) => { prefillWater(world, view.depth, info); } });
    engine.attachWater(water);
    engine.editor.setSourceDirect('source', info.source[0], info.source[1], RIVER_RATE);
    water.warmup(600);
    // The dragon: its own life in this world (personality and name from the seed).
    const dragon = new Dragon(world, objects, water.view, engine.env, seed);
    engine.attachDragon(dragon);
    dragon.spawn(seed, info.features, engine.home);
    return engine;
  }
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
