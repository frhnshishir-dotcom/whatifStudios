import type { World } from '../world/World';
import type { Camera } from '../world/Camera';
import { CellBuffer } from './CellBuffer';
import { TerrainShader } from './TerrainShader';
import { pack } from '../core/color';

/** Metres of "diorama base" drawn under the front edge of the world. */
export const BASE_DEPTH = 5;

/** Extra scene layers drawn on top of terrain (water, objects, particles, weather, lighting) plug in here. */
export interface SceneLayer {
  /** Short name for profiling (benchmark reports). */
  readonly name?: string;
  /** Called once per frame before the terrain pass (e.g. to refresh caches). */
  prepare?(cam: Camera, t: number): void;
  /**
   * Terrain-pass hook for each projected world cell (back to front). May replace the surface: return the surface
   * height to use for this cell, or NaN to keep the terrain. Used by water (surface + waterfalls over faces).
   */
  surfaceHeight?(i: number): number;
  /** Draw the surface of cell i into buffer index o (only called when surfaceHeight returned a value). */
  drawSurface?(i: number, x: number, y: number, o: number, buf: CellBuffer, t: number): void;
  /** Draw face cell k of cell i (cliff side) when this layer owns the surface (e.g. falling water). Return true if drawn. */
  drawFace?(i: number, x: number, k: number, total: number, o: number, buf: CellBuffer, t: number): boolean;
  /** Painter pass after terrain (objects, particles, weather). */
  after?(buf: CellBuffer, cam: Camera, t: number): void;
}

/**
 * Builds the CellBuffer for the current camera. Oblique projection: world cell (x, y) at elevation h lands in
 * screen column x - floor(cam.x) and row (y - floor(cam.y)) - round(h * heightScale). Columns are painted back to
 * front; each cell writes its top surface, then its front face down to the next cell's surface, so nearer cells
 * occlude farther ones and cliffs (and waterfalls) get real vertical faces.
 */
export class Composer {
  readonly world: World;
  readonly shader: TerrainShader;
  readonly buf = new CellBuffer();
  readonly layers: SceneLayer[] = [];
  private rowBg = new Uint32Array(0);
  stats = { cells: 0, projected: 0 };

  constructor(world: World, shader: TerrainShader) {
    this.world = world;
    this.shader = shader;
  }

  private ensureRowBg(rows: number): void {
    if (this.rowBg.length === rows) return;
    this.rowBg = new Uint32Array(rows);
    for (let r = 0; r < rows; r++) {
      const t = r / Math.max(1, rows - 1);
      this.rowBg[r] = pack(9 + 6 * t, 12 + 6 * t, 11 + 5 * t);
    }
  }

  /** When set, compose() records milliseconds per layer (prepare + after) and for the terrain pass. Off by default. */
  profile: Map<string, number> | null = null;

  private timed(prof: Map<string, number>, L: SceneLayer, f: () => void): void {
    const a = performance.now();
    f();
    const k = L.name ?? 'layer';
    prof.set(k, (prof.get(k) ?? 0) + performance.now() - a);
  }

  compose(cam: Camera, t: number): CellBuffer {
    const w = this.world, sh = this.shader, buf = this.buf;
    sh.update();
    const cols = cam.cols + 1, rows = cam.rows + 1;
    buf.resize(cols, rows);
    this.ensureRowBg(rows);
    buf.clear(this.rowBg);
    const prof = this.profile;
    if (prof) { prof.clear(); for (const L of this.layers) this.timed(prof, L, () => L.prepare?.(cam, t)); }
    else for (const L of this.layers) L.prepare?.(cam, t);
    const tTerrain = prof ? performance.now() : 0;
    const water = this.layers.find((L) => L.surfaceHeight);

    const W = w.w, H = w.h, elev = w.elev;
    const x0 = Math.floor(cam.x), y0 = Math.floor(cam.y), hs = cam.heightScale;
    sh.heightScale = hs;
    const lift = Math.ceil(Math.max(0, sh.maxElev) * hs) + 2;
    const sink = Math.ceil(Math.max(0, -sh.minElev) * hs) + 2;
    const baseLevel = sh.minElev - BASE_DEPTH;
    const G = buf.glyph, F = buf.fg, B = buf.bg, D = buf.depth, P = buf.pick, K = buf.kind, M = buf.mat, E = buf.elev;
    const TG = sh.topGlyph, TF = sh.topFg, TB = sh.topBg;
    let projected = 0;

    for (let c = 0; c < cols; c++) {
      const wx = x0 + c;
      if (wx < 0 || wx >= W) continue;
      const yStart = Math.max(0, y0 - sink), yEnd = Math.min(H - 1, y0 + rows + lift);
      for (let wy = yStart; wy <= yEnd; wy++) {
        const i = wy * W + wx;
        let h = elev[i];
        let wh = NaN;
        if (water) { wh = water.surfaceHeight!(i); if (!Number.isNaN(wh)) h = wh; }
        const sTop = wy - y0 - Math.round(h * hs);
        const front = wy === H - 1;
        let hn: number;
        if (front) hn = baseLevel;
        else {
          hn = elev[i + W];
          if (water) { const wn = water.surfaceHeight!(i + W); if (!Number.isNaN(wn)) hn = wn; }
        }
        const sNext = wy + 1 - y0 - Math.round(hn * hs);
        if (sTop >= rows) continue;
        projected++;
        if (sTop >= 0) {
          const o = sTop * cols + c;
          if (!Number.isNaN(wh)) water!.drawSurface!(i, wx, wy, o, buf, t);
          else { G[o] = TG[i]; F[o] = TF[i]; B[o] = TB[i]; K[o] = 1; }
          D[o] = wy; P[o] = i; M[o] = w.mat[i]; E[o] = Math.max(0, Math.min(255, Math.round(h * 8)));
        }
        const total = sNext - sTop - 1;
        const fEnd = Math.min(sNext - 1, rows - 1);
        const groundRows = Math.round((elev[i] - sh.minElev) * hs);
        for (let r = Math.max(sTop + 1, 0); r <= fEnd; r++) {
          const k = r - sTop - 1, o = r * cols + c;
          if (!(water && !Number.isNaN(wh) && water.drawFace!(i, wx, k, total, o, buf, t))) {
            sh.face(i, wx, k, total, front && k > groundRows, G, F, B, o);
            K[o] = 2;
          }
          D[o] = wy + 0.5; P[o] = i; M[o] = w.mat[i]; E[o] = 0;
        }
      }
    }
    if (prof) {
      prof.set('terrain', performance.now() - tTerrain);
      for (const L of this.layers) this.timed(prof, L, () => L.after?.(buf, cam, t));
    } else for (const L of this.layers) L.after?.(buf, cam, t);
    this.stats.cells = cols * rows;
    this.stats.projected = projected;
    return buf;
  }
}
