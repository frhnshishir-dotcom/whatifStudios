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
import { WORLD } from './world/data';
import { buildBlueprint } from './world/blueprint';
import { ContinentTerrain } from './world/terrain';
import { RegionCache, WorldWindow } from './world/stream';
import { ContinentSession } from './world/session';
import type { ContinentEdits } from './world/edits';
import { LivingWorld } from './world/life/client';
import { NetClient } from './world/net/NetClient';
import type { MapPt } from './world/schema';

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
 * Continent mode: the world blueprint, seamless terrain and a 3 x 3 region window streamed around the view, starting
 * at Lumenfall Village (or `at`, map units). The valley scenes are untouched.
 */
export function createContinentEngine(opts: { worker?: boolean; at?: MapPt; edits?: ContinentEdits; life?: boolean; server?: string; name?: string } = {}): { engine: Engine; session: ContinentSession; life: LivingWorld | null } {
  const share = canShare() && opts.worker !== false;
  const bp = buildBlueprint(WORLD);
  const terrain = new ContinentTerrain(bp);
  const worker = typeof Worker !== 'undefined' && opts.worker !== false ? new Worker(new URL('./world/region.worker.ts', import.meta.url), { type: 'module' }) : null;
  const cache = new RegionCache(terrain, { worker, capacity: 24 });
  const win = new WorldWindow(WORLD.coordinates.regionCells, share ? sharedAlloc : heapAlloc);
  const start = opts.at ?? WORLD.settlements[0].at;
  const session = new ContinentSession(bp, terrain, cache, win);
  if (opts.edits) session.edits = opts.edits;
  win.load(session.regionOf(start), (rx, ry) => cache.ensure(rx, ry));
  session.applyLoadedGround();
  win.world.name = WORLD.world.name;
  win.world.seed = WORLD.world.seed;
  const engine = new Engine(win.world);
  const water = new WaterSystem(win.world, { useWorker: share, params: { edgeDrain: false, sleep: true }, init: (_sim, view) => { view.depth.set(session.initialDepth()); } });
  engine.attachWater(water);
  session.attach(engine);
  engine.home = session.windowCellOf(start);
  // Re-shade newly streamed strips over several frames (they load far from the view).
  engine.composer.shadeBudgetMs = 4;
  // The living world: the traveller, wildlife, villagers and dragons (off for streaming-only tests).
  const life = opts.life === false ? null : new LivingWorld(engine, session);
  session.life = life;
  if (life && opts.server) life.net = new NetClient(life, opts.server, opts.name);
  return { engine, session, life };
}

/**
 * scene: 'world' (generated vale), 'terrain' (bare heightmap, M1 test), 'watertest' (deterministic water test) or
 * 'continent' (the streamed continent).
 */
export function createEngine(seed: number, scene = 'world', opts: { worker?: boolean; at?: MapPt; server?: string; name?: string } = {}): Engine {
  if (scene === 'continent') return createContinentEngine(opts).engine;
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
