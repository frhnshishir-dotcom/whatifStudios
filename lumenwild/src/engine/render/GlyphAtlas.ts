import { GLYPH_DEFS, FONT_STACK } from './glyphs';

/**
 * Glyph atlas for one cell size: an 8-bit coverage mask (cellW x cellH) per glyph, packed contiguously.
 * Font glyphs are rasterised once with fillText (fitted and centred so fallback fonts can never break the grid);
 * block, shade and line glyphs are generated procedurally. The blitter then composes cells from these masks.
 */
export class GlyphAtlas {
  readonly cellW: number;
  readonly cellH: number;
  readonly cellPixels: number;
  readonly masks: Uint8Array;
  readonly count: number;
  /** Average coverage per glyph (0..1), used for density-ordered glyph ramps and tests. */
  readonly coverage: Float32Array;

  constructor(cellW: number, cellH: number, masks: Uint8Array) {
    this.cellW = cellW;
    this.cellH = cellH;
    this.cellPixels = cellW * cellH;
    this.masks = masks;
    this.count = GLYPH_DEFS.length;
    this.coverage = new Float32Array(this.count);
    for (let gi = 0; gi < this.count; gi++) {
      let s = 0;
      const o = gi * this.cellPixels;
      for (let p = 0; p < this.cellPixels; p++) s += masks[o + p];
      this.coverage[gi] = s / (255 * this.cellPixels);
    }
  }

  /** Bake an atlas in the browser (needs a 2D canvas and loaded fonts). */
  static bake(cellW: number, cellH: number): GlyphAtlas {
    const cp = cellW * cellH;
    const masks = new Uint8Array(GLYPH_DEFS.length * cp);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cellW, cellH) : Object.assign(document.createElement('canvas'), { width: cellW, height: cellH });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    const fontPx = Math.max(4, Math.round(cellH * 0.84));
    const baseline = Math.round(cellH * 0.77);
    GLYPH_DEFS.forEach((d, gi) => {
      const out = masks.subarray(gi * cp, (gi + 1) * cp);
      if (d.mode === 'proc') { drawProcedural(d.ch, out, cellW, cellH); return; }
      if (d.ch === ' ') return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cellW, cellH);
      ctx.fillStyle = '#fff';
      ctx.font = `${fontPx}px ${FONT_STACK}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      const m = ctx.measureText(d.ch);
      if (d.mode === 'base') {
        const s = m.width > cellW ? cellW / m.width : 1;
        ctx.setTransform(s, 0, 0, 1, (cellW - m.width * s) / 2, 0);
        ctx.fillText(d.ch, 0, baseline);
      } else {
        const L = m.actualBoundingBoxLeft, R = m.actualBoundingBoxRight, A = m.actualBoundingBoxAscent, D = m.actualBoundingBoxDescent;
        const bw = Math.max(1, L + R), bh = Math.max(1, A + D);
        const s = Math.min(1.25, (cellW * 0.98) / bw, (cellH * 0.82) / bh) * (d.scale ?? 1);
        ctx.setTransform(s, 0, 0, s, cellW / 2, cellH / 2);
        ctx.fillText(d.ch, (L - R) / 2, (A - D) / 2);
      }
      const img = ctx.getImageData(0, 0, cellW, cellH).data;
      for (let p = 0; p < cp; p++) out[p] = img[p * 4 + 3];
    });
    return new GlyphAtlas(cellW, cellH, masks);
  }
}

/** Pixel-exact block, shade and line glyphs (identical on every OS and font). Exported for tests. */
export function drawProcedural(ch: string, out: Uint8Array, w: number, h: number): void {
  const set = (x: number, y: number, v = 255) => { if (x >= 0 && y >= 0 && x < w && y < h) out[y * w + x] = v; };
  const rect = (x0: number, y0: number, x1: number, y1: number, v = 255) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) out[y * w + x] = v;
  };
  const t = Math.max(1, Math.round(w / 8));
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  switch (ch) {
    case '░': for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x % 2 === 0 && y % 2 === 0) set(x, y); break;
    case '▒': for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + y) % 2 === 0) set(x, y); break;
    case '▓': for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!(x % 2 === 1 && y % 2 === 1)) set(x, y); break;
    case '█': rect(0, 0, w, h); break;
    case '▄': rect(0, h / 2, w, h); break;
    case '▀': rect(0, 0, w, h / 2); break;
    case '▌': rect(0, 0, w / 2, h); break;
    case '▐': rect(w / 2, 0, w, h); break;
    case '▖': rect(0, h / 2, w / 2, h); break;
    case '▗': rect(w / 2, h / 2, w, h); break;
    case '▘': rect(0, 0, w / 2, h / 2); break;
    case '▝': rect(w / 2, 0, w, h / 2); break;
    case '│': rect(cx - t / 2, 0, cx - t / 2 + t, h); break;
    case '┃': rect(cx - t, 0, cx + t, h); break;
    case '║': rect(w * 0.3 - t / 2, 0, w * 0.3 + t / 2 + 0.5, h); rect(w * 0.7 - t / 2, 0, w * 0.7 + t / 2 + 0.5, h); break;
    case '╎': for (let y = 0; y < h; y++) if (y % Math.max(2, Math.round(h / 4)) < Math.max(1, Math.round(h / 8))) rect(cx - t / 2, y, cx - t / 2 + t, y + 1); break;
    case '╏': for (let y = 0; y < h; y++) if (y % Math.max(2, Math.round(h / 4)) < Math.max(1, Math.round(h / 8))) rect(cx - t, y, cx + t, y + 1); break;
    case '─': rect(0, cy - t / 2, w, cy - t / 2 + t); break;
    case '═': rect(0, h * 0.4 - t / 2, w, h * 0.4 + t / 2 + 0.5); rect(0, h * 0.62 - t / 2, w, h * 0.62 + t / 2 + 0.5); break;
    case '｡': {
      const r = Math.max(1.2, w * 0.2), ox = w * 0.32, oy = h * 0.74;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - ox, y + 0.5 - oy);
        if (Math.abs(d - r) < 0.75) set(x, y);
      }
      break;
    }
    case '╱': case '╲': case '╳': {
      // Anti-aliased diagonal(s) corner to corner, thickness ~t.
      const diag = (up: boolean) => {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w, v = (y + 0.5) / h;
          const d = Math.abs(up ? u + v - 1 : u - v) * Math.min(w, h) / Math.SQRT2;
          const a = Math.max(0, Math.min(1, t * 0.75 + 0.5 - d));
          if (a > 0) out[y * w + x] = Math.max(out[y * w + x], Math.round(a * 255));
        }
      };
      if (ch !== '╲') diag(true);
      if (ch !== '╱') diag(false);
      break;
    }
    case '┼': case '┬': case '┴': case '├': case '┤': case '┌': case '┐': case '└': case '┘': {
      const L = '┼┬┴┤┐┘'.includes(ch), R = '┼┬┴├┌└'.includes(ch), U = '┼┴├┤└┘'.includes(ch), D = '┼┬├┤┌┐'.includes(ch);
      const x0 = cx - t / 2, y0 = cy - t / 2;
      if (L) rect(0, y0, x0 + t, y0 + t);
      if (R) rect(x0, y0, w, y0 + t);
      if (U) rect(x0, 0, x0 + t, y0 + t);
      if (D) rect(x0, y0, x0 + t, h);
      break;
    }
    case '╭': case '╮': case '╯': case '╰': {
      // Quarter arc joining two edge midpoints, centred on a cell corner.
      const ox = ch === '╭' || ch === '╰' ? w : 0, oy = ch === '╭' || ch === '╮' ? h : 0;
      const r = Math.min(w, h) / 2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot((x + 0.5 - ox) * (r / (w / 2)), (y + 0.5 - oy) * (r / (h / 2)));
        const a = Math.max(0, Math.min(1, t * 0.75 + 0.5 - Math.abs(d - r)));
        if (a > 0) out[y * w + x] = Math.round(a * 255);
      }
      break;
    }
    default: throw new Error(`no procedural drawing for ${ch}`);
  }
}
