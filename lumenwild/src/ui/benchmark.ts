import type { Engine } from '../engine/Engine';
import type { PresenterKind } from '../engine/render/Presenter';
import type { EnvState } from '../engine/env/Environment';
import { probeCapabilities, type Capabilities } from './capabilities';
import { useUI } from './store';

export interface FrameSummary { mean: number; p50: number; p95: number; max: number }

export interface ScenarioResult {
  scenario: string;
  presenter: PresenterKind;
  frames: number;
  fps: number;
  /** Time between engine frames (includes waiting for the GPU and the display). */
  frameMs: FrameSummary;
  /** Main-thread CPU per frame: simulation steps, composition and presentation. */
  cpuMs: FrameSummary;
  simMs: number;
  composeMs: number;
  presentMs: number;
  /** Mean ms per frame for each composition stage (terrain pass and each layer). */
  layers: Record<string, number>;
  cols: number;
  rows: number;
  canvas: string;
  particles: number;
}

export interface BudgetCheck { presenter: PresenterKind; worstP95Ms: number; low: boolean; medium: boolean }

export interface BenchmarkReport {
  format: 'lumenwild-benchmark';
  version: 1;
  date: string;
  capabilities: Capabilities;
  settings: { resolutionScale: number; lowPerf: boolean; heightScale: number; simMode: string; viewport: string };
  heapUsedMB: { before: number | null; after: number | null };
  results: ScenarioResult[];
  budgets: BudgetCheck[];
  notes: string[];
}

interface Scenario { name: string; env: Partial<EnvState>; zoom: number; pan?: number }

/** The same four situations as the Phase 0 performance audit. */
const SCENARIOS: Scenario[] = [
  { name: 'day', env: { time: 11 }, zoom: 4 },
  { name: 'night-storm', env: { time: 23, rain: 1, fog: 0.25, wind: 0.95 }, zoom: 4 },
  { name: 'zoomed-out-storm', env: { time: 23, rain: 1, fog: 0.25, wind: 0.95 }, zoom: 1 },
  { name: 'pan', env: { time: 11 }, zoom: 4, pan: 0.15 },
];

/** Budgets from PERFORMANCE_AUDIT.md / the 3D parity gates: p95 frame time. */
const BUDGET_P95 = { medium: 20, low: 40 };

const heapMB = (): number | null => {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
};

function summary(v: number[]): FrameSummary {
  if (!v.length) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = v.slice().sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
  const r = (x: number) => Math.round(x * 100) / 100;
  return { mean: r(v.reduce((a, b) => a + b, 0) / v.length), p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1]) };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Resolve after the engine has drawn `n` frames (works with the animation loop; in manual mode the caller drives frames). */
function frames(engine: Engine, n: number, each?: (now: number) => void): Promise<void> {
  return new Promise((resolve) => {
    let k = 0;
    engine.onFrame = (now) => {
      each?.(now);
      if (++k >= n) { engine.onFrame = null; resolve(); }
    };
  });
}

async function usePresenter(engine: Engine, kind: PresenterKind): Promise<boolean> {
  if (engine.renderer?.kind === kind) return true;
  useUI.getState().setSettings({ presenter: kind });
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 50));
    if (engine.renderer?.kind === kind) return true;
    if (engine.presenterFallback && kind === 'webgl2') return false;
  }
  return false;
}

function setZoom(engine: Engine, z: number): void {
  const c = engine.renderer!.canvas, r = c.getBoundingClientRect();
  engine.cam.zoomIndex = z;
  engine.resize(r.width, r.height, window.devicePixelRatio || 1);
}

/**
 * Run the benchmark on the live engine: each scenario with each available presenter, `frameCount` measured frames
 * after a short warm-up. The user's camera, weather, presenter and dragon-follow state are restored afterwards
 * (the simulation keeps running throughout, as in normal play).
 */
export async function runBenchmark(engine: Engine, opts: { frameCount?: number; presenters?: PresenterKind[]; onProgress?: (text: string, frac: number) => void } = {}): Promise<BenchmarkReport> {
  const N = Math.max(10, opts.frameCount ?? 240), WARM = Math.min(30, Math.ceil(N / 4));
  const caps = probeCapabilities();
  const ui = useUI.getState();
  const saved = {
    env: engine.env.state(), cam: { x: engine.cam.x, y: engine.cam.y, zoom: engine.cam.zoomIndex },
    presenter: ui.settings.presenter, follow: engine.dragon?.follow ?? false, paused: engine.clock.paused,
  };
  const presenters = (opts.presenters ?? ['canvas2d', 'webgl2']).filter((k) => k !== 'webgl2' || !caps.webgl2Problem);
  const notes: string[] = [];
  if (caps.webgl2Problem) notes.push(`WebGL2 presenter skipped: ${caps.webgl2Problem}`);
  if (ui.settings.lowPerf) notes.push('Low-performance mode was on (30 fps cap, fewer particles).');
  notes.push('frameMs is the time between engine frames (display-paced, includes GPU waits); cpuMs is main-thread work only.');
  const heapBefore = heapMB();
  const results: ScenarioResult[] = [];
  const total = presenters.length * SCENARIOS.length;
  if (engine.dragon) engine.dragon.follow = false;
  engine.setPaused(false);
  const prevProfile = engine.composer.profile;
  try {
    for (const kind of presenters) {
      if (!(await usePresenter(engine, kind))) { notes.push(`Could not switch to ${kind}; skipped.`); continue; }
      for (const sc of SCENARIOS) {
        opts.onProgress?.(`${kind}: ${sc.name}`, results.length / total);
        engine.env.set({ cycle: false, rain: 0, fog: 0, wind: 0.35, ...sc.env });
        engine.env.settle();
        setZoom(engine, sc.zoom);
        const [hx, hy] = engine.home ?? [engine.world.w / 2, engine.world.h / 2];
        engine.focus(hx, hy);
        engine.composer.profile = null;
        let dir = 1;
        const pan = () => {
          if (!sc.pan) return;
          const before = engine.cam.x;
          engine.cam.x += sc.pan * dir;
          engine.cam.clampTo(engine.world.w, engine.world.h);
          if (engine.cam.x === before) dir = -dir;
        };
        await frames(engine, WARM, pan);
        const prof = new Map<string, number>();
        engine.composer.profile = prof;
        const gaps: number[] = [], cpu: number[] = [], layers: Record<string, number> = {};
        let last = -1, sim = 0, comp = 0, pres = 0, parts = 0;
        await frames(engine, N, (now) => {
          if (last >= 0) gaps.push(now - last);
          last = now;
          const f = engine.lastFrame;
          cpu.push(f.cpuMs); sim += f.simMs; comp += f.composeMs; pres += f.presentMs; parts += engine.particles.n;
          for (const [k, v] of prof) layers[k] = (layers[k] ?? 0) + v;
          pan();
        });
        engine.composer.profile = null;
        const fs = summary(gaps), b = engine.composer.buf, c = engine.renderer!.canvas;
        for (const k of Object.keys(layers)) layers[k] = round2(layers[k] / N);
        results.push({
          scenario: sc.name, presenter: kind, frames: N, fps: fs.mean > 0 ? Math.round(10000 / fs.mean) / 10 : 0,
          frameMs: fs, cpuMs: summary(cpu), simMs: round2(sim / N), composeMs: round2(comp / N), presentMs: round2(pres / N),
          layers, cols: b.cols, rows: b.rows, canvas: `${c.width}x${c.height}`, particles: Math.round(parts / N),
        });
      }
    }
  } finally {
    engine.onFrame = null;
    engine.composer.profile = prevProfile;
    await usePresenter(engine, saved.presenter);
    engine.env.set(saved.env);
    engine.env.settle();
    setZoom(engine, saved.cam.zoom);
    engine.cam.x = saved.cam.x; engine.cam.y = saved.cam.y;
    engine.cam.clampTo(engine.world.w, engine.world.h);
    if (engine.dragon) engine.dragon.follow = saved.follow;
    engine.setPaused(saved.paused);
    engine.renderer?.invalidate();
  }
  const budgets: BudgetCheck[] = presenters.map((k) => {
    const worst = Math.max(0, ...results.filter((r) => r.presenter === k).map((r) => r.frameMs.p95));
    return { presenter: k, worstP95Ms: worst, low: worst <= BUDGET_P95.low, medium: worst <= BUDGET_P95.medium };
  }).filter((b) => results.some((r) => r.presenter === b.presenter));
  const s = useUI.getState().settings;
  opts.onProgress?.('done', 1);
  return {
    format: 'lumenwild-benchmark', version: 1, date: new Date().toISOString(), capabilities: caps,
    settings: { resolutionScale: s.resolutionScale, lowPerf: s.lowPerf, heightScale: s.heightScale, simMode: engine.water?.mode ?? 'none', viewport: `${window.innerWidth}x${window.innerHeight}` },
    heapUsedMB: { before: heapBefore, after: heapMB() }, results, budgets, notes,
  };
}

/** Save the report as a JSON download. */
export function downloadReport(r: BenchmarkReport): string {
  const name = `lumenwild-benchmark-${r.date.slice(0, 16).replace(/[-:T]/g, '')}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}
