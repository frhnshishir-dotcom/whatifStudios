import type { World } from '../world/World';
import type { TerrainShader } from './TerrainShader';
import type { WaterView } from '../water/WaterSim';
import type { ObjectStore } from '../objects/ObjectStore';

const OBJ_COLOR: Record<string, number> = {
  tree: 0xff2f6b2a, rock: 0xff8a948f, stone: 0xffd8c27a, mushroom: 0xffe070c0,
  bridge: 0xff3a78b0, cottage: 0xff4a64e0, mill: 0xff70a0d8,
};

/**
 * Top-down overview of the world (one pixel per cell, ABGR packed for ImageData): terrain colour from the shader,
 * water tinted by depth, waterfalls bright, objects as coloured dots. Used by the minimap and for debugging.
 */
export function renderMinimap(world: World, shader: TerrainShader, water: WaterView | null, objects: ObjectStore | null, out: Uint32Array): void {
  shader.update();
  const n = world.n;
  for (let i = 0; i < n; i++) {
    let c = shader.topBg[i];
    if (water) {
      const d = water.depth[i];
      if (water.fall[i] > 0.05) c = 0xfff4f0e8;
      else if (d > 0.025) {
        const k = Math.min(1, Math.sqrt(d / 1.4));
        const r = 60 - 49 * k, gg = 188 - 130 * k, b = 176 - 96 * k;
        c = (0xff000000 | (b << 16) | (gg << 8) | r) >>> 0;
      }
    }
    out[i] = c;
  }
  if (objects) for (const o of objects.objects.values()) {
    const col = OBJ_COLOR[o.kind] ?? 0xffffffff;
    for (const [x, y] of objects.footprint(o)) if (world.inBounds(x, y)) out[y * world.w + x] = col;
  }
}
