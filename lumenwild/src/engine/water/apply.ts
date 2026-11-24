import type { WaterSim } from './WaterSim';
import type { WaterCmd } from './commands';

export function applyWaterCmd(sim: WaterSim, c: WaterCmd, dt: number): void {
  switch (c.op) {
    case 'addWater': sim.addWater(c.x, c.y, c.r, c.amount); break;
    case 'disturb': sim.disturb(c.x, c.y, c.r, c.strength); break;
    case 'source': sim.setSource(c.x, c.y, c.rate); break;
    case 'drain': sim.setDrain(c.x, c.y, c.rate); break;
    case 'terrain': sim.terrainChanged(c.x0, c.y0, c.x1, c.y1); break;
    case 'warmup': for (let k = 0; k < c.steps; k++) sim.step(dt); break;
    case 'clear': sim.clearWater(); break;
    case 'params': Object.assign(sim.params, c.params); break;
  }
}
