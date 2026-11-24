import type { SceneLayer } from '../render/Composer';
import type { CellBuffer } from '../render/CellBuffer';
import type { Camera } from '../world/Camera';
import type { Editor, EditTool } from './Editor';
import { OBJECT_DEFS, type WorldObject } from '../objects/defs';
import { g } from '../render/glyphs';

const BRUSH = new Set<EditTool>(['terrain', 'raise', 'lower', 'water', 'channel', 'waterfall', 'flowers', 'eraser', 'tree', 'mushroom']);
const FOOTPRINT: Partial<Record<EditTool, { kind: 'cottage' | 'mill' | 'rock'; w: number; h: number }>> = {
  cottage: { kind: 'cottage', w: 5, h: 3 }, mill: { kind: 'mill', w: 4, h: 3 },
};
const SRC = g('✺'), DRN = g('◍');
const OK = 0xff97d43f, BAD = 0xff5a5ae0, ERASE = 0xff6a7ae8; // ABGR: emerald, red, coral

/**
 * Editor feedback drawn on top of the scene: the brush disc (outline stronger), the footprint a building would
 * take (green when it fits, red when blocked), source and drain markers, and the hovered object outline.
 */
export class EditorOverlay implements SceneLayer {
  readonly editor: Editor;
  tool: EditTool = 'select';
  /** World cell under the pointer (-1 = none). */
  hover = -1;
  visible = true;
  private fp = new Set<number>();

  constructor(editor: Editor) { this.editor = editor; }

  after(buf: CellBuffer, _cam: Camera, t: number): void {
    if (!this.visible) return;
    const ed = this.editor, w = ed.world, W = w.w;
    const hx = this.hover >= 0 ? this.hover % W : -999, hy = this.hover >= 0 ? (this.hover / W) | 0 : -999;
    const brush = this.hover >= 0 && BRUSH.has(this.tool);
    const r = this.tool === 'waterfall' ? Math.max(2, ed.options.radius) : ed.options.radius;
    const color = this.tool === 'eraser' ? ERASE : OK;
    // Footprint preview for buildings.
    this.fp.clear();
    let fpOk = true;
    const spec = FOOTPRINT[this.tool];
    if (spec && this.hover >= 0) {
      const o = { kind: spec.kind, x: hx - (spec.w >> 1), y: hy - 1, variant: OBJECT_DEFS[spec.kind].variants[0], props: {} } as Omit<WorldObject, 'id'>;
      fpOk = ed.objects.canPlace(o) === null;
      for (let y = o.y; y < o.y + spec.h; y++) for (let x = o.x; x < o.x + spec.w; x++) if (w.inBounds(x, y)) this.fp.add(y * W + x);
    }
    const hoverObj = this.tool === 'select' && this.hover >= 0 ? ed.objects.occ[this.hover] : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    for (let k = 0; k < buf.n; k++) {
      const p = buf.pick[k];
      if (p < 0) continue;
      const kind = buf.kind[k];
      if (ed.sources.size && (kind === 1 || kind === 3) && ed.sources.has(p)) {
        buf.glyph[k] = SRC; buf.fg[k] = mixTo(0xffffffff, 0xfff0e070, pulse); continue;
      }
      if (ed.drains.size && (kind === 1 || kind === 3) && ed.drains.has(p)) {
        buf.glyph[k] = DRN; buf.fg[k] = 0xffd88a6a; continue;
      }
      if (brush && kind !== 6) {
        const px = p % W, py = (p / W) | 0;
        const d = Math.hypot(px - hx, py - hy);
        if (d <= r + 0.01) buf.bg[k] = mixTo(buf.bg[k], color, d > r - 0.9 ? 0.45 : 0.16);
      } else if (this.fp.size && this.fp.has(p) && kind !== 6) {
        buf.bg[k] = mixTo(buf.bg[k], fpOk ? OK : BAD, 0.4);
      } else if (this.hover === p && !brush && this.tool !== 'select' && (kind === 1 || kind === 3)) {
        buf.bg[k] = mixTo(buf.bg[k], OK, 0.45);
      }
      if (hoverObj && kind === 5 && ed.objects.occ[p] === hoverObj && hoverObj !== ed.selectedId) buf.bg[k] = mixTo(buf.bg[k], 0xffffffff, 0.18);
    }
  }
}

function mixTo(a: number, b: number, t: number): number {
  const r = (a & 255) + ((b & 255) - (a & 255)) * t;
  const gg = ((a >>> 8) & 255) + (((b >>> 8) & 255) - ((a >>> 8) & 255)) * t;
  const bb = ((a >>> 16) & 255) + (((b >>> 16) & 255) - ((a >>> 16) & 255)) * t;
  return ((0xff << 24) | (bb << 16) | (gg << 8) | r) >>> 0;
}
