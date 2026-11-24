import { clamp } from '../core/math';

/** Cell sizes (px) for each zoom step. Height/width ~1.6 like a terminal cell. */
export const ZOOM_STEPS = [5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28] as const;
export const CELL_ASPECT = 1.6;

/**
 * Oblique camera over the world grid. (x, y) = world coordinates (cells, fractional) shown at the top-left of the
 * view; sub-cell offsets give smooth panning. `heightScale` = screen rows per metre of elevation (cliff faces).
 */
export class Camera {
  x = 0;
  y = 0;
  zoomIndex = 4; // 9 px cells: ~120 x 60 characters on a laptop screen
  heightScale = 0.55;
  /** Viewport size in device pixels (set by the renderer). */
  viewW = 1;
  viewH = 1;

  get cellW(): number { return ZOOM_STEPS[this.zoomIndex]; }
  get cellH(): number { return Math.round(this.cellW * CELL_ASPECT); }
  /** Visible cells (rounded up; one extra row/column is drawn for sub-cell scrolling). */
  get cols(): number { return Math.ceil(this.viewW / this.cellW); }
  get rows(): number { return Math.ceil(this.viewH / this.cellH); }

  setViewport(w: number, h: number): void {
    this.viewW = Math.max(1, Math.floor(w));
    this.viewH = Math.max(1, Math.floor(h));
  }

  /** Pan by a drag delta in device pixels. */
  panPixels(dx: number, dy: number, worldW: number, worldH: number): void {
    this.x -= dx / this.cellW;
    this.y -= dy / this.cellH;
    this.clampTo(worldW, worldH);
  }

  /** Zoom one step in (+1) or out (-1), keeping the world point under (px, py) fixed. */
  zoomAt(px: number, py: number, dir: number, worldW: number, worldH: number): boolean {
    const next = clamp(this.zoomIndex + dir, 0, ZOOM_STEPS.length - 1);
    if (next === this.zoomIndex) return false;
    const wx = this.x + px / this.cellW, wy = this.y + py / this.cellH;
    this.zoomIndex = next;
    this.x = wx - px / this.cellW;
    this.y = wy - py / this.cellH;
    this.clampTo(worldW, worldH);
    return true;
  }

  centerOn(wx: number, wy: number, worldW: number, worldH: number): void {
    this.x = wx - this.viewW / this.cellW / 2;
    this.y = wy - this.viewH / this.cellH / 2;
    this.clampTo(worldW, worldH);
  }

  /** Keep the view over the world (with a small margin; the elevation offset can lift far cells into view). */
  clampTo(worldW: number, worldH: number): void {
    const visW = this.viewW / this.cellW, visH = this.viewH / this.cellH;
    const m = 4;
    this.x = visW >= worldW ? (worldW - visW) / 2 : clamp(this.x, -m, worldW - visW + m);
    this.y = visH >= worldH ? (worldH - visH) / 2 : clamp(this.y, -m - 8, worldH - visH + m);
  }
}
