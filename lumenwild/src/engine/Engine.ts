import { World } from './world/World';
import { Camera } from './world/Camera';
import { Clock } from './world/Clock';
import { TerrainShader } from './render/TerrainShader';
import { Composer } from './render/Composer';
import { Renderer } from './render/Renderer';

export interface EngineStats {
  fps: number;
  frameMs: number;
  composeMs: number;
  blitMs: number;
  putMs: number;
  simMs: number;
  drawnCells: number;
  cells: number;
  cols: number;
  rows: number;
  cellW: number;
  simSteps: number;
}

export interface HoverInfo { x: number; y: number; i: number; elev: number; mat: number; cover: number; moisture: number; kind: number }

/** A plug-in simulation (water, weather...) advanced at the fixed timestep. */
export interface Simulation { step(dt: number): void; name: string }

/**
 * Orchestrates world, camera, fixed-step clock, simulations and rendering. Owns the frame loop and canvas input
 * (pan, zoom, hover). Tools (editor) receive pointer events through `toolHandler` when one is set.
 */
export class Engine {
  world: World;
  readonly cam = new Camera();
  readonly clock = new Clock(60);
  shader: TerrainShader;
  composer: Composer;
  renderer: Renderer | null = null;
  readonly sims: Simulation[] = [];
  onStats: ((s: EngineStats) => void) | null = null;
  onHover: ((h: HoverInfo | null) => void) | null = null;
  onPauseChange: ((paused: boolean) => void) | null = null;
  toolHandler: { down(i: number, ev: PointerEvent): void; move(i: number, ev: PointerEvent): void; up(ev: PointerEvent): void } | null = null;

  private raf = 0;
  private last = 0;
  private frameTimes: number[] = [];
  private statAcc = 0;
  private simMs = 0;
  private composeMs = 0;
  private panning: { x: number; y: number } | null = null;
  private spaceDown = false;
  private spaceDragged = false;
  private hoverCell: [number, number] = [-1, -1];
  private cleanup: Array<() => void> = [];

  constructor(world: World) {
    this.world = world;
    this.shader = new TerrainShader(world);
    this.composer = new Composer(world, this.shader);
  }

  /** Replace the world (generation, load): rebuilds caches, keeps layers. */
  setWorld(world: World): void {
    this.world = world;
    const layers = this.composer.layers.slice();
    this.shader = new TerrainShader(world);
    this.composer = new Composer(world, this.shader);
    this.composer.layers.push(...layers);
    this.renderer?.blitter.invalidate();
  }

  attach(canvas: HTMLCanvasElement): void {
    this.renderer = new Renderer(canvas);
    this.bindInput(canvas);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    if (!this.renderer) return;
    this.renderer.resize(cssW, cssH, dpr, this.cam);
    this.cam.clampTo(this.world.w, this.world.h);
  }

  start(): void {
    const loop = (now: number) => {
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.last = performance.now();
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
  }

  setPaused(p: boolean): void {
    this.clock.paused = p;
    this.onPauseChange?.(p);
  }

  /** One frame: advance fixed steps, compose, blit. Exposed for tests (render a frame at a given time). */
  frame(now: number): void {
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    const steps = this.clock.advance(dt);
    const t0 = performance.now();
    for (let s = 0; s < steps; s++) for (const sim of this.sims) sim.step(this.clock.dt);
    const t1 = performance.now();
    if (this.renderer) {
      const buf = this.composer.compose(this.cam, this.clock.simTime);
      const t2 = performance.now();
      this.renderer.draw(buf, this.cam);
      this.composeMs = this.composeMs * 0.9 + (t2 - t1) * 0.1;
    }
    this.simMs = this.simMs * 0.9 + (t1 - t0) * 0.1;
    const ft = performance.now() - t0;
    this.frameTimes.push(dt * 1000);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.statAcc += dt;
    if (this.statAcc > 0.25 && this.onStats && this.renderer) {
      this.statAcc = 0;
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      const r = this.renderer.stats, b = this.composer.buf;
      this.onStats({
        fps: avg > 0 ? 1000 / avg : 0, frameMs: ft, composeMs: this.composeMs, blitMs: r.blitMs, putMs: r.putMs, simMs: this.simMs,
        drawnCells: r.drawnCells, cells: b.n, cols: b.cols, rows: b.rows, cellW: this.cam.cellW, simSteps: this.clock.steps,
      });
    }
    this.updateHover();
  }

  // ------------------------------------------------------------------ input
  /** World cell index under a device-pixel position, or -1. */
  pickAt(px: number, py: number): number {
    if (!this.renderer) return -1;
    const [cx, cy] = this.renderer.cellAt(px, py, this.cam);
    const b = this.composer.buf;
    if (cx < 0 || cy < 0 || cx >= b.cols || cy >= b.rows) return -1;
    return b.pick[cy * b.cols + cx];
  }

  private devicePos(canvas: HTMLCanvasElement, ev: { clientX: number; clientY: number }): [number, number] {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(1, r.width), sy = canvas.height / Math.max(1, r.height);
    return [(ev.clientX - r.left) * sx, (ev.clientY - r.top) * sy];
  }

  private updateHover(): void {
    if (!this.onHover || !this.renderer) return;
    const [hx, hy] = this.hoverCell;
    if (hx < 0) return;
    const i = this.pickAt(hx, hy);
    if (i < 0) { this.onHover(null); return; }
    const w = this.world, x = i % w.w, y = Math.floor(i / w.w);
    const b = this.composer.buf, [cx, cy] = this.renderer.cellAt(hx, hy, this.cam);
    this.onHover({ x, y, i, elev: w.elev[i], mat: w.mat[i], cover: w.cover[i], moisture: w.moisture[i], kind: b.kind[cy * b.cols + cx] });
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(canvas, 'pointerdown', (ev) => {
      const [px, py] = this.devicePos(canvas, ev);
      if (ev.button === 1 || (ev.button === 0 && this.spaceDown) || ev.button === 2) {
        ev.preventDefault();
        this.panning = { x: px, y: py };
        if (this.spaceDown) this.spaceDragged = true;
        canvas.setPointerCapture(ev.pointerId);
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (ev.button === 0 && this.toolHandler) {
        canvas.setPointerCapture(ev.pointerId);
        this.toolHandler.down(this.pickAt(px, py), ev);
      }
    });
    on(canvas, 'pointermove', (ev) => {
      const [px, py] = this.devicePos(canvas, ev);
      this.hoverCell = [px, py];
      if (this.panning) {
        this.cam.panPixels(px - this.panning.x, py - this.panning.y, this.world.w, this.world.h);
        this.panning = { x: px, y: py };
        if (this.spaceDown) this.spaceDragged = true;
        return;
      }
      if (this.toolHandler && ev.buttons & 1) this.toolHandler.move(this.pickAt(px, py), ev);
    });
    const end = (ev: PointerEvent) => {
      if (this.panning) {
        this.panning = null;
        canvas.style.cursor = '';
      } else if (this.toolHandler && ev.button === 0) this.toolHandler.up(ev);
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    };
    on(canvas, 'pointerup', end);
    on(canvas, 'pointercancel', end);
    on(canvas, 'pointerleave', () => { this.hoverCell = [-1, -1]; this.onHover?.(null); });
    on(canvas, 'contextmenu', (ev) => ev.preventDefault());
    on(canvas, 'wheel', (ev) => {
      ev.preventDefault();
      const [px, py] = this.devicePos(canvas, ev);
      this.cam.zoomAt(px, py, ev.deltaY < 0 ? 1 : -1, this.world.w, this.world.h);
    }, { passive: false });
    on(window, 'keydown', (ev) => {
      if (isTyping(ev)) return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        if (!this.spaceDown) { this.spaceDown = true; this.spaceDragged = false; canvas.style.cursor = 'grab'; }
      }
      const step = 8 / Math.max(1, this.cam.cellW / 8);
      const pan = (dx: number, dy: number) => this.cam.panPixels(dx * this.cam.cellW * step, dy * this.cam.cellH * step, this.world.w, this.world.h);
      if (ev.code === 'ArrowLeft') pan(1, 0);
      if (ev.code === 'ArrowRight') pan(-1, 0);
      if (ev.code === 'ArrowUp') pan(0, 1);
      if (ev.code === 'ArrowDown') pan(0, -1);
    });
    on(window, 'keyup', (ev) => {
      if (ev.code !== 'Space' || isTyping(ev)) return;
      // Space pressed and released without dragging = pause/resume; Space + drag = pan.
      if (this.spaceDown && !this.spaceDragged) this.setPaused(!this.clock.paused);
      this.spaceDown = false;
      canvas.style.cursor = '';
    });
  }
}

function isTyping(ev: Event): boolean {
  const t = ev.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
