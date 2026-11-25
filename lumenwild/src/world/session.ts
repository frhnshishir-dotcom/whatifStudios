import type { Engine } from '../engine/Engine';
import type { Blueprint } from './blueprint';
import type { ContinentTerrain } from './terrain';
import { RegionCache, WorldWindow, WINDOW_REGIONS, riverPorts } from './stream';
import type { MapPt } from './schema';
import { Navigator, Traveller } from './navigation';

/**
 * Continent mode: keeps the engine's World (the 3 x 3 region window) centred on what the player looks at. When the
 * view's centre crosses into a neighbouring region, the window moves by one region: terrain, shading cache, objects,
 * water and the camera shift together, so the picture does not jump. The ring of regions just outside the window is
 * prefetched (in a worker when available).
 */
export class ContinentSession {
  readonly bp: Blueprint;
  readonly terrain: ContinentTerrain;
  readonly cache: RegionCache;
  readonly win: WorldWindow;
  stats = { shifts: 0, lastShiftMs: 0, maxShiftMs: 0, stalls: 0 };
  /** Called after every window move (UI, tests). */
  onShift: ((dx: number, dy: number) => void) | null = null;
  /** Long-distance routes, and the journey in progress (the view follows it). */
  private nav: Navigator | null = null;
  travel: Traveller | null = null;
  travelTo = '';

  constructor(bp: Blueprint, terrain: ContinentTerrain, cache: RegionCache, win: WorldWindow) {
    this.bp = bp; this.terrain = terrain; this.cache = cache; this.win = win;
  }

  /** Region holding a map point. */
  regionOf(p: MapPt): [number, number] {
    const c = this.bp.coords.mapToCell(p);
    return [Math.floor(c[0] / this.win.S), Math.floor(c[1] / this.win.S)];
  }
  /** Map point (units) of a window cell, and the window cell of a map point (may lie outside the window). */
  mapOf(x: number, y: number): MapPt { const [cx, cy] = this.win.toContinent(x, y); return this.bp.coords.cellToMap([cx, cy]); }
  windowCellOf(p: MapPt): [number, number] { const c = this.bp.coords.mapToCell(p); return this.win.toWindow(c[0], c[1]); }

  /** Wire into an engine built on `win.world`: objects, water sources and drains, the per-frame update. */
  attach(engine: Engine): void {
    engine.streamer = this;
    engine.elevationDatum = this.win.datum;
    for (const o of this.win.allObjects()) engine.objects.add({ kind: o.kind, x: o.x, y: o.y, variant: o.variant, props: {} });
    this.applyPorts(engine);
    this.prefetch();
  }

  private applyPorts(engine: Engine): void {
    const w = engine.water;
    if (!w) return;
    const { sources, drains } = riverPorts(this.bp, this.win);
    w.setPorts(sources.map((s) => [s.x, s.y, s.rate]), drains.map((d) => [d.x, d.y, d.rate]));
  }

  /** Prefetch the ring of regions around the window (off in headless tests without a worker, where it is slow). */
  prefetchRing = true;

  /** Request every region in the ring around the window (no-op for those cached or on their way). */
  prefetch(): void {
    if (!this.prefetchRing) return;
    const [ox, oy] = this.win.origin;
    for (let gy = -1; gy <= WINDOW_REGIONS; gy++) for (let gx = -1; gx <= WINDOW_REGIONS; gx++) {
      if (gx >= 0 && gy >= 0 && gx < WINDOW_REGIONS && gy < WINDOW_REGIONS) continue;
      this.cache.request(ox + gx, oy + gy);
    }
  }

  /** The window cell under the middle of the screen (terrain-aware), or the camera centre. */
  focusCell(engine: Engine): [number, number] {
    const cam = engine.cam;
    const i = engine.renderer ? engine.pickAt(cam.viewW / 2, cam.viewH / 2) : -1;
    if (i >= 0) return [i % this.win.W, Math.floor(i / this.win.W)];
    return [Math.round(cam.x + cam.viewW / cam.cellW / 2), Math.round(cam.y + cam.viewH / cam.cellH / 2)];
  }

  get navigator(): Navigator { return (this.nav ??= new Navigator(this.bp)); }

  /** Start travelling from the current view to a map point at `speed` m/s. Returns the route length in metres, or null. */
  startTravel(engine: Engine, to: MapPt, speed: number, label = ''): number | null {
    const [fx, fy] = this.focusCell(engine);
    const route = this.navigator.route(this.mapOf(fx, fy), to);
    if (!route) return null;
    this.travel = new Traveller(route, speed, this.bp.coords.metresPerUnit);
    this.travelTo = label;
    return this.travel.length;
  }

  stopTravel(): void { this.travel = null; this.travelTo = ''; }

  /** Where the view is, in continent terms. */
  whereAmI(engine: Engine): { map: MapPt; region: string; biome: string; elevation: number; nearest: { name: string; km: number; bearing: string } } {
    const [fx, fy] = this.focusCell(engine), map = this.mapOf(fx, fy), W = this.win.W;
    const i = Math.max(0, Math.min(W * W - 1, fy * W + fx)), b = this.win.biome[i];
    let nearest = { name: '', km: Infinity, bearing: '' };
    for (const s of this.bp.data.settlements) {
      const dx = s.at[0] - map[0], dy = s.at[1] - map[1], km = (Math.hypot(dx, dy) * this.bp.coords.metresPerUnit) / 1000;
      if (km < nearest.km) {
        const a = (Math.atan2(dx, -dy) * 180) / Math.PI, dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        nearest = { name: s.name, km, bearing: dirs[Math.round(((a + 360) % 360) / 45) % 8] };
      }
    }
    return { map, region: this.bp.coords.mapToRegionId(map), biome: this.bp.data.regions[b]?.name ?? 'Sea', elevation: engine.world.elevAt(fx, fy) + this.win.datum, nearest };
  }

  /** Per frame: follow the journey (if any), then move the window when the focus has left the central region. */
  update(engine: Engine, dt = 1 / 60): void {
    if (this.travel) {
      const p = this.travel.advance(engine.clock.paused ? 0 : dt);
      const [x, y] = this.windowCellOf(p), W = this.win.W;
      const cx = Math.max(1, Math.min(W - 2, Math.round(x))), cy = Math.max(1, Math.min(W - 2, Math.round(y)));
      engine.cam.centerOn(x, y, W, W, engine.world.elevAt(cx, cy));
      if (this.travel.done) this.stopTravel();
    }
    const S = this.win.S, [fx, fy] = this.focusCell(engine);
    const dx = fx < S ? -1 : fx >= 2 * S ? 1 : 0, dy = fy < S ? -1 : fy >= 2 * S ? 1 : 0;
    if (!dx && !dy) return;
    // One axis per frame (a diagonal move takes two frames).
    const mx = dx || 0, my = dx ? 0 : dy;
    const strip = this.stripRegions(mx, my);
    const ready = strip.every(([rx, ry]) => this.cache.has(rx, ry));
    const nearEdge = fx < 48 || fy < 48 || fx >= this.win.W - 48 || fy >= this.win.W - 48;
    if (!ready && !nearEdge) { for (const [rx, ry] of strip) this.cache.request(rx, ry); return; }
    if (!ready) this.stats.stalls++;
    this.moveWindow(engine, mx, my);
  }

  private stripRegions(dx: number, dy: number): Array<[number, number]> {
    const [ox, oy] = this.win.origin, out: Array<[number, number]> = [];
    for (let k = 0; k < WINDOW_REGIONS; k++) {
      if (dx) out.push([dx > 0 ? ox + WINDOW_REGIONS : ox - 1, oy + k]);
      else out.push([ox + k, dy > 0 ? oy + WINDOW_REGIONS : oy - 1]);
    }
    return out;
  }

  /** Move the window by one region along one axis and carry everything with it. */
  moveWindow(engine: Engine, dx: number, dy: number): void {
    const t0 = performance.now();
    const water = engine.water;
    water?.setRunning(false, engine.clock.speed);
    const [sx, sy] = this.win.shift(dx, dy, (rx, ry) => this.cache.ensure(rx, ry));
    engine.shader.shift(sx, sy);
    engine.objects.shift(sx, sy);
    if (water) {
      // Water, flow, ripples and settled (sleeping) pools move with the terrain; the uncovered strip starts with its
      // rivers, lakes and pools filled. Then the river inflows and outflows are placed at the new window edge.
      // (Before the strip's objects are added: their obstacles must displace water in the shifted grid.)
      water.shift(sx, sy, this.win.waterDepth());
      this.applyPorts(engine);
    }
    const gx0 = dx > 0 ? WINDOW_REGIONS - 1 : 0, gy0 = dy > 0 ? WINDOW_REGIONS - 1 : 0;
    for (let k = 0; k < WINDOW_REGIONS; k++) {
      const gx = dx ? gx0 : k, gy = dx ? k : gy0;
      for (const o of this.win.objectsOf(gx, gy)) engine.objects.add({ kind: o.kind, x: o.x, y: o.y, variant: o.variant, props: {} });
    }
    water?.setRunning(!engine.clock.paused, engine.clock.speed);
    engine.cam.x -= sx; engine.cam.y -= sy;
    engine.particles.n = 0;
    engine.editor.history.clear();
    engine.editor.sources.clear(); engine.editor.drains.clear();
    if (engine.home) engine.home = [engine.home[0] - sx, engine.home[1] - sy];
    engine.renderer?.invalidate();
    const ms = performance.now() - t0;
    this.stats.shifts++; this.stats.lastShiftMs = ms; this.stats.maxShiftMs = Math.max(this.stats.maxShiftMs, ms);
    this.prefetch(); // background with a worker (without one it generates here, outside the timed move)
    this.onShift?.(dx, dy);
  }
}
