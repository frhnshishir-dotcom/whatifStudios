/// <reference lib="webworker" />
import { WaterSim, type WaterBuffers, type WaterParams } from './WaterSim';
import { applyWaterCmd } from './apply';
import type { WaterCmd, WaterStats } from './commands';

// Simulation worker: owns the step loop at a fixed 60 Hz over SharedArrayBuffers that the main thread renders from.
// Edits arrive as commands and are applied between steps, so the simulation never sees a half-applied edit.
const DT = 1 / 60;
let sim: WaterSim | null = null;
let running = true;
let speed = 1;
let acc = 0;
let last = 0;
let stepMs = 0;
let lastStats = 0;
let warming = false;
const queue: WaterCmd[] = [];

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    const buffers = m.buffers as WaterBuffers;
    sim = new WaterSim(m.w, m.h, new Float32Array(m.elev), buffers, m.params as Partial<WaterParams>, m.solid ? new Uint8Array(m.solid) : undefined);
    last = performance.now();
    loop();
  } else if (m.type === 'cmd') queue.push(...(m.cmds as WaterCmd[]));
  else if (m.type === 'run') { running = m.running; speed = m.speed ?? speed; }
};

function loop(): void {
  if (!sim) return;
  const now = performance.now();
  const real = Math.min(0.25, (now - last) / 1000);
  last = now;
  while (queue.length) {
    const c = queue.shift()!;
    warming = c.op === 'warmup';
    if (warming) post(true);
    applyWaterCmd(sim, c, DT);
    warming = false;
  }
  if (running) {
    acc += real * speed;
    let n = 0;
    const t0 = performance.now();
    while (acc >= DT && n < 8) { sim.step(DT); acc -= DT; n++; }
    if (n === 8) acc = 0;
    if (n) stepMs = stepMs * 0.9 + ((performance.now() - t0) / n) * 0.1;
  }
  if (now - lastStats > 250) { lastStats = now; post(false); }
  setTimeout(loop, 4);
}

function post(w: boolean): void {
  if (!sim) return;
  const s: WaterStats = { stepMs, steps: sim.steps, total: sim.totalWater(), active: sim.activeChunks, sleeping: sim.sleepingChunks, added: sim.added, removed: sim.removed, warming: w };
  (self as unknown as Worker).postMessage({ type: 'stats', stats: s });
}
