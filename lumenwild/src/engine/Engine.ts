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
import { Editor, type EditTool } from './edit/Editor';
import { EditorOverlay } from './edit/EditorOverlay';
import { Environment } from './env/Environment';
import { Atmosphere } from './env/Atmosphere';
import { generateWorld, prefillWater, type GenInfo } from './gen/world';
import { buildSave, type SaveData, type LoadedWorld } from '../persist/format';

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
  /** Hour of day and current weather (smoothed). */
  time: number;
  rain: number;
  fog: number;
  wind: number;
  lights: number;
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
  /** Generator report for the current world (null after loading a save). */
  gen: GenInfo | null = null;
  /** Low-performance mode: 30 fps cap and fewer particles. */
  lowPerf = false;
  private lastRender = 0;
  water: WaterSystem | null = null;
  waterLayer: WaterLayer | null = null;
  readonly particles = new Particles(4000);
  objects: ObjectStore;
  objectLayer: ObjectLayer;
  /** Draws particles last (after objects), depth-tested. */
  private particleLayer: SceneLayer;
  readonly editor: Editor;
  readonly overlay: EditorOverlay;
  readonly env = new Environment();
  atmosphere: Atmosphere;
  /** Active editor tool (left-button strokes go to the editor). */
  tool: EditTool = 'select';
  /** World cell under the pointer (-1 = none). */
  hoverIndex = -1;
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
    this.editor = new Editor(world, this.objects, null);
    this.overlay = new EditorOverlay(this.editor);
    this.atmosphere = new Atmosphere(this.env, world, this.objects, this.particles);
    this.composer.layers.push(this.objectLayer, this.particleLayer, this.atmosphere, this.overlay);
    this.bindObjects();
    this.toolHandler = {
      down: (i) => this.editor.begin(this.tool, i),
      move: (i) => this.editor.drag(i),
      up: () => this.editor.end(),
    };
  }

  /** Use an existing object store (generated together with the world). */
  setObjects(store: ObjectStore): void {
    const k = this.composer.layers.indexOf(this.objectLayer);
    this.objects = store;
    this.objectLayer = new ObjectLayer(this.world, store, this.water ? this.water.view : null);
    if (k >= 0) this.composer.layers[k] = this.objectLayer;
    this.editor.objects = store;
    this.atmosphere.objects = store;
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

  /** Zoom in until at most `maxCols` columns are visible (small screens open closer). */
  fitZoom(maxCols: number): void {
    while (this.cam.cols > maxCols && this.cam.zoomIndex < 13) {
      this.cam.zoomIndex++;
      if (this.renderer) { const r = this.renderer.canvas.getBoundingClientRect(); this.resize(r.width, r.height, window.devicePixelRatio || 1); }
    }
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
    // Phones report 3x pixel density: 2x is sharp enough and keeps the pixel work affordable.
    this.renderer.resize(cssW, cssH, Math.min(dpr, 2), this.cam);
    this.cam.clampTo(this.world.w, this.world.h);
  }

  start(): void {
    const loop = (now: number) => {
      // Low-performance mode renders every other display frame (about 30 fps).
      if (!this.lowPerf || now - this.lastRender >= 30) { this.lastRender = now; this.frame(now); }
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

  setLowPerf(on: boolean): void {
    this.lowPerf = on;
    this.atmosphere.density = on ? 0.45 : 1;
  }

  // ------------------------------------------------------------------ worlds: save, load, regenerate
  /** Everything needed to restore this world exactly. */
  snapshot(): SaveData {
    const w = this.world;
    return buildSave({
      name: w.name, seed: w.seed, w: w.w, h: w.h,
      elev: w.elev, mat: w.mat, cover: w.cover, coverVar: w.coverVar, moisture: w.moisture, magic: w.magic,
      depth: this.water ? this.water.view.depth : new Float32Array(w.n),
      objects: this.objects.toJSON(), sources: this.editor.sources, drains: this.editor.drains,
      env: this.env.state(), camera: { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoomIndex }, home: this.home,
    });
  }

  /** Replace the world in place with a validated save. Returns problems (objects that could not be placed). */
  applyWorld(L: LoadedWorld): string[] {
    const w = this.world;
    if (L.w !== w.w || L.h !== w.h) return [`World size ${L.w} x ${L.h} does not match ${w.w} x ${w.h}.`];
    if (this.editor.active) this.editor.end();
    w.elev.set(L.elev); w.mat.set(L.mat); w.cover.set(L.cover); w.coverVar.set(L.coverVar); w.moisture.set(L.moisture); w.magic.set(L.magic);
    w.name = L.name; w.seed = L.seed;
    const onChange = this.objects.onChange;
    this.objects.onChange = null;
    w.solid.fill(0);
    const problems = this.objects.load(L.objects);
    this.objects.onChange = onChange;
    w.markAllDirty();
    this.water?.reset(L.depth);
    this.editor.bind(w, this.objects, this.water);
    for (const [i, r] of L.sources) this.editor.setSourceDirect('source', i % w.w, Math.floor(i / w.w), r);
    for (const [i, r] of L.drains) this.editor.setSourceDirect('drain', i % w.w, Math.floor(i / w.w), r);
    this.env.set(L.env); this.env.settle();
    this.cam.zoomIndex = L.camera.zoom; this.cam.x = L.camera.x; this.cam.y = L.camera.y;
    this.cam.clampTo(w.w, w.h);
    this.home = L.home;
    this.gen = null;
    this.particles.n = 0;
    this.renderer?.blitter.invalidate();
    if (this.renderer) { const r = this.renderer.canvas.getBoundingClientRect(); this.resize(r.width, r.height, window.devicePixelRatio || 1); }
    return problems;
  }

  /** Generate a new world from a seed in place (same size), with flowing water. */
  regenerate(seed: number, riverRate = 5): GenInfo {
    const w = this.world;
    if (this.editor.active) this.editor.end();
    const onChange = this.objects.onChange;
    this.objects.onChange = null;
    w.seed = seed;
    w.name = `Vale ${seed}`;
    const info = generateWorld(w, this.objects, seed);
    this.objects.onChange = onChange;
    const depth = new Float32Array(w.n);
    prefillWater(w, depth, info);
    this.water?.reset(depth);
    this.editor.bind(w, this.objects, this.water);
    this.editor.setSourceDirect('source', info.source[0], info.source[1], riverRate);
    this.water?.warmup(600);
    this.gen = info;
    const br = info.features.find((f) => f.kind === 'bridge');
    this.home = br ? [br.x, br.y + 6] : null;
    this.particles.n = 0;
    this.renderer?.blitter.invalidate();
    const [hx, hy] = this.home ?? [w.w / 2, w.h / 2];
    this.focus(hx, hy);
    return info;
  }

  /** Connect the water simulation: rendering layer + stepping (main-thread mode) or worker control. */
  attachWater(ws: WaterSystem): void {
    this.water = ws;
    this.waterLayer = new WaterLayer(this.world, ws.view, this.shader, this.particles);
    this.composer.layers.unshift(this.waterLayer);
    this.objectLayer.water = ws.view;
    this.editor.water = ws;
    this.atmosphere.water = ws;
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
    this.editor.tick(Math.min(0.05, dt));
    this.objectLayer.selectedId = this.editor.selectedId;
    this.objectLayer.wind = this.env.gust;
    this.objectLayer.windDir = this.env.windDir;
    this.objectLayer.night = this.env.night;
    this.overlay.tool = this.tool;
    this.overlay.hover = this.hoverIndex;
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
        time: this.env.time, rain: this.env.rain, fog: this.env.fog, wind: this.env.wind, lights: this.atmosphere.stats.lights,
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
    if (!this.renderer) return;
    const [hx, hy] = this.hoverCell;
    if (hx < 0) { this.hoverIndex = -1; return; }
    const i = this.pickAt(hx, hy);
    this.hoverIndex = i;
    if (i < 0) { this.onHover?.(null); return; }
    const w = this.world, x = i % w.w, y = Math.floor(i / w.w);
    const b = this.composer.buf, [cx, cy] = this.renderer.cellAt(hx, hy, this.cam);
    this.onHover?.({ x, y, i, elev: w.elev[i], mat: w.mat[i], cover: w.cover[i], moisture: w.moisture[i], kind: b.kind[cy * b.cols + cx] });
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    // Touch: two fingers pan and pinch-zoom; one finger on empty ground with the select tool pans.
    const touches = new Map<number, [number, number]>();
    let pinch: { cx: number; cy: number; d: number } | null = null;
    const gesture = () => {
      const p = [...touches.values()];
      return { cx: (p[0][0] + p[1][0]) / 2, cy: (p[0][1] + p[1][1]) / 2, d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) };
    };
    on(canvas, 'pointerdown', (ev) => {
      const [px, py] = this.devicePos(canvas, ev);
      if (ev.pointerType === 'touch') {
        touches.set(ev.pointerId, [px, py]);
        canvas.setPointerCapture(ev.pointerId);
        if (touches.size === 2) { this.editor.end(); this.panning = null; pinch = gesture(); return; }
        if (touches.size > 2) return;
        const i = this.pickAt(px, py);
        if (this.tool === 'select' && (i < 0 || !this.objects.occ[i]) && !(this.water && i >= 0 && this.water.view.depth[i] > 0.025)) {
          this.panning = { x: px, y: py };
          return;
        }
        this.toolHandler?.down(i, ev);
        return;
      }
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
      if (ev.pointerType === 'touch' && touches.has(ev.pointerId)) {
        touches.set(ev.pointerId, [px, py]);
        if (touches.size >= 2 && pinch) {
          const g = gesture();
          this.cam.panPixels(g.cx - pinch.cx, g.cy - pinch.cy, this.world.w, this.world.h);
          pinch.cx = g.cx; pinch.cy = g.cy;
          const r = g.d / Math.max(1, pinch.d);
          if (r > 1.25 || r < 0.8) { this.cam.zoomAt(g.cx, g.cy, r > 1 ? 1 : -1, this.world.w, this.world.h); pinch.d = g.d; }
          return;
        }
      }
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
      if (ev.pointerType === 'touch') {
        const was = touches.size;
        touches.delete(ev.pointerId);
        if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
        if (was >= 2) { pinch = null; this.panning = null; return; }
        if (this.panning) { this.panning = null; return; }
        this.toolHandler?.up(ev);
        return;
      }
      if (this.panning) {
        this.panning = null;
        canvas.style.cursor = '';
      } else if (this.toolHandler && ev.button === 0) this.toolHandler.up(ev);
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    };
    on(canvas, 'pointerup', end);
    on(canvas, 'pointercancel', (ev) => { end(ev); this.editor.end(); });
    on(canvas, 'pointerleave', () => { this.hoverCell = [-1, -1]; this.hoverIndex = -1; this.onHover?.(null); });
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
