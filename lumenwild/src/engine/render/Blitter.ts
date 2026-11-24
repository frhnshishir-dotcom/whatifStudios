import type { CellBuffer } from './CellBuffer';
import type { GlyphAtlas } from './GlyphAtlas';

/**
 * Composes character cells into a 32-bit pixel buffer: for every pixel of a cell, the glyph's coverage mask blends
 * the foreground over the background. Cells identical to the previous frame (same glyph and colours at the same
 * position) are skipped, so static terrain costs nothing; a camera move or atlas change forces a full redraw.
 */
export class Blitter {
  private pGlyph = new Uint16Array(0);
  private pFg = new Uint32Array(0);
  private pBg = new Uint32Array(0);
  private valid = false;
  lastDrawnCells = 0;

  invalidate(): void { this.valid = false; }

  blit(buf: CellBuffer, atlas: GlyphAtlas, pixels: Uint32Array, pixW: number): number {
    const { cols, rows, n } = buf;
    if (this.pGlyph.length !== n) {
      this.pGlyph = new Uint16Array(n);
      this.pFg = new Uint32Array(n);
      this.pBg = new Uint32Array(n);
      this.valid = false;
    }
    const cw = atlas.cellW, ch = atlas.cellH, cp = atlas.cellPixels, masks = atlas.masks;
    const G = buf.glyph, F = buf.fg, B = buf.bg, PG = this.pGlyph, PF = this.pFg, PB = this.pBg;
    const all = !this.valid;
    let drawn = 0;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        const gl = G[i], fg = F[i], bg = B[i];
        if (!all && gl === PG[i] && fg === PF[i] && bg === PB[i]) continue;
        PG[i] = gl; PF[i] = fg; PB[i] = bg;
        drawn++;
        const fr = fg & 255, fgc = (fg >>> 8) & 255, fb = (fg >>> 16) & 255;
        const br = bg & 255, bgc = (bg >>> 8) & 255, bb = (bg >>> 16) & 255;
        const dr = fr - br, dg = fgc - bgc, db = fb - bb;
        let m = gl * cp;
        let row = cy * ch * pixW + cx * cw;
        if (gl === 0) { // space: background only
          for (let y = 0; y < ch; y++, row += pixW) pixels.fill(bg, row, row + cw);
          continue;
        }
        for (let y = 0; y < ch; y++, row += pixW) {
          for (let x = 0; x < cw; x++) {
            const a = masks[m++];
            if (a === 0) pixels[row + x] = bg;
            else if (a === 255) pixels[row + x] = fg;
            else {
              const r = br + ((dr * a) >> 8), gg = bgc + ((dg * a) >> 8), b = bb + ((db * a) >> 8);
              pixels[row + x] = (0xff000000 | (b << 16) | (gg << 8) | r) >>> 0;
            }
          }
        }
      }
    }
    this.valid = true;
    this.lastDrawnCells = drawn;
    return drawn;
  }
}
