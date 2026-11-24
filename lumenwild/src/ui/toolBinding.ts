import type { Engine } from '../engine/Engine';
import type { ToolId } from './store';
import { RENDER_MIN_DEPTH } from '../engine/water/WaterLayer';

/**
 * Connects the selected UI tool to engine pointer events. Milestone 2: the ripple tool (click or drag on water).
 * Milestone 4 replaces this with the full editor tool set.
 */
export function bindTool(engine: Engine, tool: ToolId): void {
  if (tool === 'ripple') {
    let last = 0;
    const hit = (i: number, force: boolean) => {
      const ws = engine.water;
      if (i < 0 || !ws) return;
      const now = performance.now();
      if (!force && now - last < 90) return;
      last = now;
      if (ws.view.depth[i] < RENDER_MIN_DEPTH) return;
      const w = engine.world.w;
      ws.disturb(i % w, Math.floor(i / w), 1.6, 1.2);
    };
    engine.toolHandler = { down: (i) => hit(i, true), move: (i) => hit(i, false), up: () => {} };
  } else {
    engine.toolHandler = null;
  }
}
