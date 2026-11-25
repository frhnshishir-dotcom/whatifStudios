/// <reference lib="webworker" />
import { WORLD } from './data';
import { buildBlueprint } from './blueprint';
import { ContinentTerrain } from './terrain';

// Generates continent regions off the main thread. The blueprint is built once on the first request; regions are pure
// functions of position, so results equal the main thread's exactly.
let terrain: ContinentTerrain | null = null;

self.onmessage = (e: MessageEvent<{ rx: number; ry: number }>) => {
  terrain ??= new ContinentTerrain(buildBlueprint(WORLD));
  const r = terrain.generateRegion(e.data.rx, e.data.ry);
  (self as unknown as Worker).postMessage({ region: r }, [r.elev.buffer, r.mat.buffer, r.cover.buffer, r.coverVar.buffer, r.moisture.buffer, r.waterLevel.buffer, r.waterKind.buffer, r.biome.buffer]);
};
