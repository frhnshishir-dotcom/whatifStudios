import type { Camera } from '../world/Camera';
import type { CellBuffer } from './CellBuffer';
import { GlyphAtlas } from './GlyphAtlas';

export type PresenterKind = 'canvas2d' | 'webgl2';

export interface PresenterStats {
  /** Time to turn cells into pixels (CPU blit, or texture upload + draw call for the GPU presenter). */
  blitMs: number;
  /** Time to hand the pixels to the browser (putImageData; 0 for the GPU presenter). */
  putMs: number;
  drawnCells: number;
  atlasBakeMs: number;
}

/**
 * Turns a composed `CellBuffer` into pixels on a canvas. Composition (terrain, water, objects, dragon, atmosphere,
 * editor overlay) happens before this and never depends on which presenter is used, so presenters can be swapped
 * without touching the simulation or the layers. The Canvas 2D presenter is the reference; others must match it.
 */
export interface Presenter {
  readonly kind: PresenterKind;
  readonly canvas: HTMLCanvasElement;
  resolutionScale: number;
  readonly stats: PresenterStats;
  /** Size the backing store from CSS size, device pixel ratio and the resolution scale; updates the camera viewport. */
  resize(cssW: number, cssH: number, dpr: number, cam: Camera): void;
  draw(buf: CellBuffer, cam: Camera): void;
  /** Forget what was drawn: the next draw repaints every cell. */
  invalidate(): void;
  /** Screen cell under a device-pixel position (accounts for the sub-cell offset). */
  cellAt(px: number, py: number, cam: Camera): [number, number];
  /** Release GPU or other resources. The canvas itself is left in place. */
  dispose(): void;
}

/** Sub-cell scroll offset in device pixels: the image is drawn at (-ox, -oy) so panning is smooth. */
export function subCellOffset(cam: Camera, cellW: number, cellH: number): [number, number] {
  return [Math.round((cam.x - Math.floor(cam.x)) * cellW), Math.round((cam.y - Math.floor(cam.y)) * cellH)];
}

/** The cell-under-pixel rule shared by every presenter (picking must not depend on the presenter). */
export function cellAtPixel(px: number, py: number, cam: Camera): [number, number] {
  const ox = (cam.x - Math.floor(cam.x)) * cam.cellW, oy = (cam.y - Math.floor(cam.y)) * cam.cellH;
  return [Math.floor((px + ox) / cam.cellW), Math.floor((py + oy) / cam.cellH)];
}

/** Backing-store size for a CSS size: device pixel ratio times resolution scale, at least 1 x 1. */
export function backingSize(cssW: number, cssH: number, dpr: number, scale: number): [number, number] {
  const s = dpr * scale;
  return [Math.max(1, Math.round(cssW * s)), Math.max(1, Math.round(cssH * s))];
}

/** One glyph atlas per cell size, baked on first use and shared by whichever presenter asks. */
export class AtlasCache {
  private atlases = new Map<string, GlyphAtlas>();
  lastBakeMs = 0;

  get(cellW: number, cellH: number): GlyphAtlas {
    const key = `${cellW}x${cellH}`;
    let a = this.atlases.get(key);
    if (!a) {
      const t0 = performance.now();
      a = GlyphAtlas.bake(cellW, cellH);
      this.lastBakeMs = performance.now() - t0;
      this.atlases.set(key, a);
    }
    return a;
  }
}
