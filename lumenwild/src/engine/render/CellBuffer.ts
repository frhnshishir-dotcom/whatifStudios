/**
 * The screen as a grid of character cells. Each cell carries the glyph, foreground and background colour
 * (packed RGBA), plus the scene data that produced it: depth (world row, for occlusion of objects/particles),
 * pick (world cell index, -1 = none), material, quantised elevation, light level and animation state.
 */
export class CellBuffer {
  cols = 0;
  rows = 0;
  n = 0;
  glyph = new Uint16Array(0);
  fg = new Uint32Array(0);
  bg = new Uint32Array(0);
  depth = new Float32Array(0);
  pick = new Int32Array(0);
  mat = new Uint8Array(0);
  elev = new Uint8Array(0);
  /** Emissive strength 0..255 (lit windows, glowing mushrooms, fireflies): the night lighting doesn't darken it. */
  light = new Uint8Array(0);
  anim = new Uint8Array(0);
  /** Per-cell kind for the inspector/debug: 0 void, 1 terrain top, 2 face, 3 water, 4 waterfall, 5 object, 6 particle. */
  kind = new Uint8Array(0);

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.n = cols * rows;
    this.glyph = new Uint16Array(this.n);
    this.fg = new Uint32Array(this.n);
    this.bg = new Uint32Array(this.n);
    this.depth = new Float32Array(this.n);
    this.pick = new Int32Array(this.n);
    this.mat = new Uint8Array(this.n);
    this.elev = new Uint8Array(this.n);
    this.light = new Uint8Array(this.n);
    this.anim = new Uint8Array(this.n);
    this.kind = new Uint8Array(this.n);
  }

  /** Reset to the void background: one packed colour per row (vertical gradient). */
  clear(rowBg: Uint32Array): void {
    const { cols, rows } = this;
    this.glyph.fill(0);
    this.fg.fill(0);
    this.depth.fill(-1e9);
    this.pick.fill(-1);
    this.kind.fill(0);
    this.anim.fill(0);
    this.light.fill(0);
    for (let r = 0; r < rows; r++) this.bg.fill(rowBg[Math.min(r, rowBg.length - 1)], r * cols, (r + 1) * cols);
  }
}
