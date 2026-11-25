import type { Camera } from '../world/Camera';
import type { CellBuffer } from './CellBuffer';
import type { GlyphAtlas } from './GlyphAtlas';
import { Blitter } from './Blitter';
import { AtlasCache, backingSize, cellAtPixel, subCellOffset, type Presenter } from './Presenter';

/**
 * The reference presenter (CPU): keeps one ImageData the size of the cell grid, blits the CellBuffer into it with
 * the glyph masks, and places it with a negative sub-cell offset so the camera can pan smoothly while the character
 * grid itself stays perfectly aligned.
 */
export class Canvas2DPresenter implements Presenter {
  readonly kind = 'canvas2d' as const;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private atlases: AtlasCache;
  private image: ImageData | null = null;
  private pixels = new Uint32Array(0);
  private lastAtlas: GlyphAtlas | null = null;
  readonly blitter = new Blitter();
  resolutionScale = 1;
  stats = { blitMs: 0, putMs: 0, drawnCells: 0, atlasBakeMs: 0 };

  constructor(canvas: HTMLCanvasElement, atlases = new AtlasCache()) {
    this.canvas = canvas;
    this.atlases = atlases;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, dpr: number, cam: Camera): void {
    const [w, h] = backingSize(cssW, cssH, dpr, this.resolutionScale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.blitter.invalidate();
    }
    cam.setViewport(w, h);
  }

  invalidate(): void { this.blitter.invalidate(); }

  draw(buf: CellBuffer, cam: Camera): void {
    const atlas = this.atlases.get(cam.cellW, cam.cellH);
    this.stats.atlasBakeMs = this.atlases.lastBakeMs;
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
    const [ox, oy] = subCellOffset(cam, atlas.cellW, atlas.cellH);
    this.ctx.putImageData(this.image, -ox, -oy);
    this.stats.blitMs = t1 - t0;
    this.stats.putMs = performance.now() - t1;
  }

  cellAt(px: number, py: number, cam: Camera): [number, number] { return cellAtPixel(px, py, cam); }

  dispose(): void { this.image = null; this.pixels = new Uint32Array(0); }
}
