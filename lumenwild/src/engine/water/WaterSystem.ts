import type { World } from '../world/World';
import { sharedAlloc, heapAlloc } from '../world/World';
import { WaterSim, WaterView, allocWaterBuffers, type WaterParams } from './WaterSim';
import { applyWaterCmd } from './apply';
import type { WaterCmd, WaterStats } from './commands';

/**
 * Main-thread facade over the water simulation. With SharedArrayBuffer (cross-origin isolated page) the simulation
 * runs in a worker and the renderer reads the same memory through `view`; otherwise the same WaterSim runs on the
 * main thread as an engine Simulation. Callers use the same API in both modes.
 */
export class WaterSystem {
  readonly name = 'water';
  readonly mode: 'worker' | 'main';
  readonly view: WaterView;
  readonly sim: WaterSim | null = null;
  private worker: Worker | null = null;
  stats: WaterStats = { stepMs: 0, steps: 0, total: 0, active: 0, added: 0, removed: 0, warming: false };
  onStats: ((s: WaterStats) => void) | null = null;
  private statT = 0;

  constructor(world: World, opts: { useWorker: boolean; params?: Partial<WaterParams>; init?: (sim: WaterSim | null, view: WaterView) => void }) {
    const shared = opts.useWorker && world.elev.buffer instanceof SharedArrayBuffer;
    this.mode = shared ? 'worker' : 'main';
    const buffers = allocWaterBuffers(world.n, shared ? sharedAlloc : heapAlloc);
    if (shared) {
      this.view = new WaterView(world.w, world.h, buffers);
      // Prime state (e.g. pre-filled lakes) before the worker starts.
      new Int32Array(buffers.fallTo).fill(-1);
      opts.init?.(null, this.view);
      this.worker = new Worker(new URL('./water.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => { if (e.data.type === 'stats') { this.stats = e.data.stats; this.onStats?.(this.stats); } };
      this.worker.postMessage({ type: 'init', w: world.w, h: world.h, elev: world.elev.buffer, solid: world.solid.buffer, buffers, params: opts.params ?? {} });
    } else {
      this.sim = new WaterSim(world.w, world.h, world.elev, buffers, opts.params, world.solid);
      this.view = this.sim;
      opts.init?.(this.sim, this.view);
    }
  }

  send(...cmds: WaterCmd[]): void {
    if (this.worker) this.worker.postMessage({ type: 'cmd', cmds });
    else if (this.sim) for (const c of cmds) applyWaterCmd(this.sim, c, 1 / 60);
  }

  addWater(x: number, y: number, r: number, amount: number) { this.send({ op: 'addWater', x, y, r, amount }); }
  disturb(x: number, y: number, r: number, strength: number) { this.send({ op: 'disturb', x, y, r, strength }); }
  setSource(x: number, y: number, rate: number) { this.send({ op: 'source', x, y, rate }); }
  setDrain(x: number, y: number, rate: number) { this.send({ op: 'drain', x, y, rate }); }
  /** Many sources and drains in one command (one list rebuild). */
  setPorts(sources: Array<[number, number, number]>, drains: Array<[number, number, number]>) { this.send({ op: 'ports', sources, drains }); }
  terrainChanged(x0: number, y0: number, x1: number, y1: number) { this.send({ op: 'terrain', x0, y0, x1, y1 }); }
  warmup(steps: number) { this.send({ op: 'warmup', steps }); }
  clear() { this.send({ op: 'clear' }); }
  /** Replace all water (and remove every source and drain). */
  reset(depth: Float32Array | null) { this.send({ op: 'reset', depth: depth ? depth.slice() : null }); }
  /** Streaming: the world moved by (sx, sy) cells; water and flow move with it, the new strip comes from `fresh`. */
  shift(sx: number, sy: number, fresh: Float32Array) { this.send({ op: 'shift', sx, sy, fresh }); }

  setRunning(running: boolean, speed: number): void {
    this.worker?.postMessage({ type: 'run', running, speed });
  }

  /** Main-thread mode: advanced by the engine at the fixed timestep. */
  step(dt: number): void {
    if (!this.sim) return;
    const t0 = performance.now();
    this.sim.step(dt);
    this.stats.stepMs = this.stats.stepMs * 0.9 + (performance.now() - t0) * 0.1;
    this.statT += dt;
    if (this.statT > 0.25) {
      this.statT = 0;
      const s = this.sim;
      this.stats = { ...this.stats, steps: s.steps, total: s.totalWater(), active: s.activeChunks, sleeping: s.sleepingChunks, added: s.added, removed: s.removed };
      this.onStats?.(this.stats);
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
