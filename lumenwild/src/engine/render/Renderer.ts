import type { Camera } from '../world/Camera';
import type { CellBuffer } from './CellBuffer';
import { GlyphAtlas } from './GlyphAtlas';
import { Blitter } from './Blitter';

/**
 * Owns the canvas: keeps one glyph atlas per cell size (baked on first use), one ImageData the size of the cell
 * grid, and blits the CellBuffer into it. The image is placed with a negative sub-cell offset so the camera can
 * pan smoothly while the character grid itself stays perfectly aligned.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private atlases = new Map<string, GlyphAtlas>();
  private image: ImageData | null = null;
  private pixels = new Uint32Array(0);
  private lastAtlas: GlyphAtlas | null = null;
  readonly blitter = new Blitter();
  resolutionScale = 1;
  stats = { blitMs: 0, putMs: 0, drawnCells: 0, atlasBakeMs: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  /** Size the backing store from CSS size, device pixel ratio and the resolution scale. */
  resize(cssW: number, cssH: number, dpr: number, cam: Camera): void {
    const s = dpr * this.resolutionScale;
    const w = Math.max(1, Math.round(cssW * s)), h = Math.max(1, Math.round(cssH * s));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.blitter.invalidate();
    }
    cam.setViewport(w, h);
  }

  /** Device pixels per CSS pixel on the backing store. */
  get pixelRatio(): number { return this.canvas.width / Math.max(1, this.canvas.clientWidth || this.canvas.width); }

  atlas(cellW: number, cellH: number): GlyphAtlas {
    const key = `${cellW}x${cellH}`;
    let a = this.atlases.get(key);
    if (!a) {
      const t0 = performance.now();
      a = GlyphAtlas.bake(cellW, cellH);
      this.stats.atlasBakeMs = performance.now() - t0;
      this.atlases.set(key, a);
    }
    return a;
  }

  draw(buf: CellBuffer, cam: Camera): void {
    const atlas = this.atlas(cam.cellW, cam.cellH);
    const pw = buf.cols * atlas.cellW, ph = buf.rows * atlas.cellH;
    if (!this.image || this.image.width !== pw || this.image.height !== ph || atlas !== this.lastAtlas) {
      this.image = this.ctx.createImageData(pw, ph);
      this.pixels = new Uint32Array(this.image.data.buffer);
      this.blitter.invalidate();
      this.lastAtlas = atlas;
    }
    const t0 = performance.now();
    this.stats.drawnCells = this.blitter.blit(buf, atlas, this.pixels, pw);
    const t1 = performance.now();
    const ox = Math.round((cam.x - Math.floor(cam.x)) * atlas.cellW);
    const oy = Math.round((cam.y - Math.floor(cam.y)) * atlas.cellH);
    this.ctx.putImageData(this.image, -ox, -oy);
    this.stats.blitMs = t1 - t0;
    this.stats.putMs = performance.now() - t1;
  }

  /** Screen cell under a device-pixel position (accounts for the sub-cell offset). */
  cellAt(px: number, py: number, cam: Camera): [number, number] {
    const ox = (cam.x - Math.floor(cam.x)) * cam.cellW, oy = (cam.y - Math.floor(cam.y)) * cam.cellH;
    return [Math.floor((px + ox) / cam.cellW), Math.floor((py + oy) / cam.cellH)];
  }
}
