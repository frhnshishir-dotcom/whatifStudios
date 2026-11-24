import { World } from './world/World';
import { Camera } from './world/Camera';
import { Clock } from './world/Clock';
import { TerrainShader } from './render/TerrainShader';
import { Composer } from './render/Composer';
import { Renderer } from './render/Renderer';
import { Particles } from './render/Particles';
import type { WaterSystem } from './water/WaterSystem';
import { WaterLayer } from './water/WaterLayer';
import { ObjectStore } from './objects/ObjectStore';
import { ObjectLayer } from './objects/ObjectLayer';
import type { SceneLayer } from './render/Composer';

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
  simMode: 'worker' | 'main' | 'none';
  water: number;
  activeChunks: number;
  particles: number;
  objects: number;
  objectCells: number;
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
  /** Where the view opens (and the Home key returns to). */
  home: [number, number] | null = null;
  water: WaterSystem | null = null;
  waterLayer: WaterLayer | null = null;
  readonly particles = new Particles(4000);
  objects: ObjectStore;
  objectLayer: ObjectLayer;
  /** Draws particles last (after objects), depth-tested. */
  private particleLayer: SceneLayer;
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
    this.objects = new ObjectStore(world);
    this.objectLayer = new ObjectLayer(world, this.objects, null);
    this.particleLayer = { after: (buf, cam, t) => this.particles.draw(buf, cam, t, this.objectLayer.night) };
    this.composer.layers.push(this.objectLayer, this.particleLayer);
    this.bindObjects();
  }

  /** Use an existing object store (generated together with the world). */
  setObjects(store: ObjectStore): void {
    const k = this.composer.layers.indexOf(this.objectLayer);
    this.objects = store;
    this.objectLayer = new ObjectLayer(this.world, store, this.water ? this.water.view : null);
    if (k >= 0) this.composer.layers[k] = this.objectLayer;
    this.bindObjects();
    this.renderer?.blitter.invalidate();
  }

  /** Object edits that change the solid mask wake the water there. */
  private bindObjects(): void {
    this.objects.onChange = (x0, y0, x1, y1) => this.water?.terrainChanged(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
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

  /** Centre the view on a world cell, accounting for its elevation in the oblique projection. */
  focus(x: number, y: number): void {
    const w = this.world;
    this.shader.update();
    this.cam.maxLift = Math.max(this.cam.maxLift, this.shader.maxElev * this.cam.heightScale);
    this.cam.centerOn(x, y, w.w, w.h, w.elevAt(Math.round(x), Math.round(y)));
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

  /** Connect the water simulation: rendering layer + stepping (main-thread mode) or worker control. */
  attachWater(ws: WaterSystem): void {
    this.water = ws;
    this.waterLayer = new WaterLayer(this.world, ws.view, this.shader, this.particles);
    this.composer.layers.unshift(this.waterLayer);
    this.objectLayer.water = ws.view;
    if (ws.mode === 'main') this.sims.push(ws);
    ws.setRunning(!this.clock.paused, this.clock.speed);
  }

  setPaused(p: boolean): void {
    this.clock.paused = p;
    this.water?.setRunning(!p, this.clock.speed);
    this.onPauseChange?.(p);
  }

  setSpeed(v: number): void {
    this.clock.speed = v;
    this.water?.setRunning(!this.clock.paused, v);
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
      this.cam.maxLift = Math.max(0, this.shader.maxElev * this.cam.heightScale);
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
      const ws = this.water;
      this.onStats({
        fps: avg > 0 ? 1000 / avg : 0, frameMs: ft, composeMs: this.composeMs, blitMs: r.blitMs, putMs: r.putMs,
        simMs: ws?.mode === 'worker' ? ws.stats.stepMs : this.simMs,
        drawnCells: r.drawnCells, cells: b.n, cols: b.cols, rows: b.rows, cellW: this.cam.cellW, simSteps: ws ? ws.stats.steps : this.clock.steps,
        simMode: ws ? ws.mode : 'none', water: ws ? ws.stats.total : 0, activeChunks: ws ? ws.stats.active : 0, particles: this.particles.n,
        objects: this.objects.objects.size, objectCells: this.objectLayer.drawn,
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
      if (ev.code === 'Home') { const [hx, hy] = this.home ?? [this.world.w / 2, this.world.h / 2]; this.focus(hx, hy); }
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
