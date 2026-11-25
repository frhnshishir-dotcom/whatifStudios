import type { Camera } from '../world/Camera';
import type { CellBuffer } from './CellBuffer';
import type { GlyphAtlas } from './GlyphAtlas';
import { AtlasCache, backingSize, cellAtPixel, subCellOffset, type Presenter } from './Presenter';

const VERT = `#version 300 es
void main() {
  // One triangle covering the viewport; no vertex buffers.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Integer re-implementation of Blitter.blit, per output pixel: the same cell lookup, sub-cell offset and
 * `bg + floor((fg - bg) * a / 256)` blend, so the output matches the Canvas 2D presenter exactly.
 */
const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uGlyph;  // R16UI, cols x rows
uniform usampler2D uFg;     // RGBA8UI, cols x rows
uniform usampler2D uBg;     // RGBA8UI, cols x rows
uniform usampler2D uAtlas;  // R8UI, glyph masks in a grid of perRow x n rows
uniform ivec2 uCell;        // cell size in pixels
uniform ivec2 uGrid;        // cols, rows
uniform ivec2 uOffset;      // sub-cell scroll offset
uniform int uCanvasH;
uniform int uPerRow;
out vec4 outColor;
int fdiv256(int d) { return d >= 0 ? (d >> 8) : -(((-d) + 255) >> 8); }
void main() {
  int ix = int(gl_FragCoord.x) + uOffset.x;
  int iy = (uCanvasH - 1 - int(gl_FragCoord.y)) + uOffset.y;
  int cx = ix / uCell.x, cy = iy / uCell.y;
  if (ix < 0 || iy < 0 || cx >= uGrid.x || cy >= uGrid.y) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  ivec2 c = ivec2(cx, cy);
  int g = int(texelFetch(uGlyph, c, 0).r);
  ivec3 bg = ivec3(texelFetch(uBg, c, 0).rgb);
  ivec3 col = bg;
  if (g != 0) {
    ivec3 fg = ivec3(texelFetch(uFg, c, 0).rgb);
    ivec2 ap = ivec2((g % uPerRow) * uCell.x + (ix - cx * uCell.x), (g / uPerRow) * uCell.y + (iy - cy * uCell.y));
    int a = int(texelFetch(uAtlas, ap, 0).r);
    if (a == 255) col = fg;
    else if (a != 0) {
      ivec3 d = (fg - bg) * a;
      col = bg + ivec3(fdiv256(d.r), fdiv256(d.g), fdiv256(d.b));
    }
  }
  outColor = vec4(vec3(col) / 255.0, 1.0);
}`;

const CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
  preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false,
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function intTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  // Integer textures are only complete with NEAREST filtering.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

type Uniforms = Record<'uGlyph' | 'uFg' | 'uBg' | 'uAtlas' | 'uCell' | 'uGrid' | 'uOffset' | 'uCanvasH' | 'uPerRow', WebGLUniformLocation | null>;

/**
 * GPU presenter (WebGL2): uploads the CellBuffer's glyph, foreground and background arrays as integer textures each
 * frame (about 10 bytes per cell) and composes every pixel in a fragment shader from the glyph-mask atlas. Removes
 * the CPU blit and putImageData. Handles context loss by rebuilding its resources when the context is restored.
 */
export class WebGLPresenter implements Presenter {
  readonly kind = 'webgl2' as const;
  readonly canvas: HTMLCanvasElement;
  resolutionScale = 1;
  stats = { blitMs: 0, putMs: 0, drawnCells: 0, atlasBakeMs: 0 };
  /** True between webglcontextlost and webglcontextrestored: draws are skipped. */
  lost = false;
  readonly info: { renderer: string; vendor: string; maxTextureSize: number };

  private gl: WebGL2RenderingContext;
  private atlases: AtlasCache;
  private prog!: WebGLProgram;
  private u!: Uniforms;
  private tGlyph!: WebGLTexture;
  private tFg!: WebGLTexture;
  private tBg!: WebGLTexture;
  private tAtlas!: WebGLTexture;
  private gridCols = 0;
  private gridRows = 0;
  private atlasFor: GlyphAtlas | null = null;
  private perRow = 1;
  private onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private onRestored = () => { this.init(); this.lost = false; };

  /** Throws if WebGL2 is unavailable or the shaders fail; check `WebGLPresenter.probe()` first to keep the canvas usable. */
  constructor(canvas: HTMLCanvasElement, atlases = new AtlasCache()) {
    this.canvas = canvas;
    this.atlases = atlases;
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRS);
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.info = WebGLPresenter.describe(gl);
    this.init();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  /**
   * Can this browser run the presenter? Compiles the program on a throwaway canvas, so a failure leaves the real
   * canvas free for the Canvas 2D fallback. Returns null when supported, otherwise the reason.
   */
  static probe(): string | null {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2', CONTEXT_ATTRS);
      if (!gl) return 'WebGL2 is not available';
      link(gl);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  static describe(gl: WebGL2RenderingContext): { renderer: string; vendor: string; maxTextureSize: number } {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    };
  }

  private init(): void {
    const gl = this.gl;
    this.prog = link(gl);
    const u = {} as Uniforms;
    for (const k of ['uGlyph', 'uFg', 'uBg', 'uAtlas', 'uCell', 'uGrid', 'uOffset', 'uCanvasH', 'uPerRow'] as const) u[k] = gl.getUniformLocation(this.prog, k);
    this.u = u;
    this.tGlyph = intTexture(gl);
    this.tFg = intTexture(gl);
    this.tBg = intTexture(gl);
    this.tAtlas = intTexture(gl);
    this.gridCols = this.gridRows = 0;
    this.atlasFor = null;
    gl.useProgram(this.prog);
    gl.uniform1i(u.uGlyph, 0);
    gl.uniform1i(u.uFg, 1);
    gl.uniform1i(u.uBg, 2);
    gl.uniform1i(u.uAtlas, 3);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
  }

  resize(cssW: number, cssH: number, dpr: number, cam: Camera): void {
    const [w, h] = backingSize(cssW, cssH, dpr, this.resolutionScale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    cam.setViewport(w, h);
  }

  /** Every frame repaints every pixel on the GPU, so there is nothing to invalidate. */
  invalidate(): void {}

  /** Lay the glyph masks out in a grid (glyph g at column g % perRow, row g / perRow) and upload them once. */
  private uploadAtlas(atlas: GlyphAtlas): void {
    const gl = this.gl, cw = atlas.cellW, ch = atlas.cellH;
    const perRow = Math.max(1, Math.min(atlas.count, Math.floor(Math.min(4096, this.info.maxTextureSize) / cw)));
    const rowsN = Math.ceil(atlas.count / perRow), W = perRow * cw, H = rowsN * ch;
    const data = new Uint8Array(W * H);
    for (let g = 0; g < atlas.count; g++) {
      const ox = (g % perRow) * cw, oy = Math.floor(g / perRow) * ch, src = g * atlas.cellPixels;
      for (let y = 0; y < ch; y++) data.set(atlas.masks.subarray(src + y * cw, src + (y + 1) * cw), (oy + y) * W + ox);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.tAtlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, W, H, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    this.perRow = perRow;
    this.atlasFor = atlas;
  }

  draw(buf: CellBuffer, cam: Camera): void {
    if (this.lost || this.gl.isContextLost()) return;
    const gl = this.gl;
    const atlas = this.atlases.get(cam.cellW, cam.cellH);
    this.stats.atlasBakeMs = this.atlases.lastBakeMs;
    const t0 = performance.now();
    if (atlas !== this.atlasFor) this.uploadAtlas(atlas);
    const { cols, rows } = buf;
    const fg8 = new Uint8Array(buf.fg.buffer, buf.fg.byteOffset, buf.n * 4);
    const bg8 = new Uint8Array(buf.bg.buffer, buf.bg.byteOffset, buf.n * 4);
    const realloc = cols !== this.gridCols || rows !== this.gridRows;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tGlyph);
    if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, cols, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, buf.glyph);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED_INTEGER, gl.UNSIGNED_SHORT, buf.glyph);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tFg);
    if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, cols, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, fg8);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, fg8);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tBg);
    if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, cols, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, bg8);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, bg8);
    this.gridCols = cols; this.gridRows = rows;

    const [ox, oy] = subCellOffset(cam, atlas.cellW, atlas.cellH);
    const u = this.u;
    gl.useProgram(this.prog);
    gl.uniform2i(u.uCell, atlas.cellW, atlas.cellH);
    gl.uniform2i(u.uGrid, cols, rows);
    gl.uniform2i(u.uOffset, ox, oy);
    gl.uniform1i(u.uCanvasH, this.canvas.height);
    gl.uniform1i(u.uPerRow, this.perRow);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.blitMs = performance.now() - t0;
    this.stats.putMs = 0;
    this.stats.drawnCells = buf.n;
  }

  cellAt(px: number, py: number, cam: Camera): [number, number] { return cellAtPixel(px, py, cam); }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.gl.isContextLost()) return;
    const gl = this.gl;
    for (const t of [this.tGlyph, this.tFg, this.tBg, this.tAtlas]) gl.deleteTexture(t);
    gl.deleteProgram(this.prog);
  }
}
