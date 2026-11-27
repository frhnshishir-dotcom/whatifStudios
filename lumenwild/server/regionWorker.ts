import { parentPort } from 'node:worker_threads';
import { WORLD } from '../src/world/data';
import { buildBlueprint } from '../src/world/blueprint';
import { ContinentTerrain } from '../src/world/terrain';
import { masksOf } from './regionMasks';

/**
 * Region generation for the world server, on its own thread (worker_threads). Regions are pure functions of their
 * position, so a region made here is identical to one made on the main thread. The blueprint and terrain are built
 * once, on the first request. Each reply carries the region and its collision masks; the typed arrays are
 * transferred, not copied.
 */
let terrain: ContinentTerrain | null = null;

parentPort!.on('message', (m: { rx: number; ry: number }) => {
  terrain ??= new ContinentTerrain(buildBlueprint(WORLD));
  const t0 = performance.now();
  const r = terrain.generateRegion(m.rx, m.ry);
  const masks = masksOf(r);
  const ms = performance.now() - t0;
  parentPort!.postMessage({ rx: m.rx, ry: m.ry, region: r, masks, ms }, [r.elev.buffer, r.mat.buffer, r.cover.buffer, r.coverVar.buffer, r.moisture.buffer, r.waterLevel.buffer, r.waterKind.buffer, r.biome.buffer, r.blend.buffer, masks.solid.buffer, masks.deck.buffer] as ArrayBuffer[]);
});
