import { g } from '../render/glyphs';
import { hex, pack, type RGB } from '../core/color';
import { hash2 } from '../core/rng';
import { CELL_ASPECT } from '../world/Camera';

/** World y is drawn 1 row per cell and rows are taller than columns: compress the creature's lateral extent so its
 *  proportions are true on screen. */
export const ASPECT = Math.min(1, 1.28 / CELL_ASPECT);

/**
 * The dragon's body and wings as cached character poses. A small 2.5D anatomical model (local frame: +x forward,
 * +y right wing, +z up) is posed for a mode and wing angle, rotated to one of 24 headings, scaled, projected
 * (z lifts rows by the relief) and rasterised with 4 x 4 samples per cell: edge cells take a quadrant block glyph
 * matching the covered quarters (crisp silhouette), interior cells a texture glyph for their part (membrane,
 * finger bones, scales, dorsal ridge, claws). Shading: light from the upper left, translucent membranes, a lighter
 * underside along the lower edge of the body. Neck, head and tail are drawn live by the renderer.
 */

export const DIRS = 24;
export const FRAMES = 8;
/** Flap angle (rad) for each flight frame: fully down ... fully raised. */
export const FRAME_ANGLES = Array.from({ length: FRAMES }, (_, k) => -0.85 + (k / (FRAMES - 1)) * 1.85);
/** Apparent scale by altitude level (low ... high). */
export const SIZES = [1.3, 1.15, 1.0, 0.86];
export const enum Mode { Flight = 0, Glide = 1, Landing = 2, Standing = 3, Lying = 4 }
export const enum Part { None = 0, Membrane = 1, Bone = 2, Body = 3, Ridge = 4, Claw = 5, Arm = 6 }

export interface PoseCell { dx: number; dy: number; g: number; fg: number; bg: number; alpha: number; part: number }
export interface ShadowCell { dx: number; dy: number; a: number }

const C = (s: string) => hex(s);
/** Obsidian scales, crimson wing membranes, ember ridge and amber eyes: dark, clean, and distinct from the grass. */
export const PAL = {
  scaleDark: C('#07080b'), scale: C('#1b2028'), scaleLit: C('#56637a'), belly: C('#4a2a22'), ridge: C('#ff7a2c'),
  membrane: C('#3c0d14'), membraneLit: C('#7a1c26'), membraneEdge: C('#050506'), bone: C('#050506'), boneLit: C('#2a2e36'),
  claw: C('#c9bea2'), clawDark: C('#2a2a24'), horn: C('#c8bc9e'), eye: C('#ffb22e'), eyeLit: C('#ffe08a'), charcoal: C('#0b0c0f'),
};

export type Palette = typeof PAL;

/**
 * How a dragon is built and coloured. The Valley's dragon uses CLASSIC (unchanged); the continent's five dragons
 * each have their own palette and size, a longer wing with a third finger, a lit leading edge, and bank into turns.
 */
export interface DragonStyle {
  pal: Palette;
  /** Overall scale, wingspan and body multipliers. */
  scale: number; span: number; body: number;
  /** A third finger bone (a more articulated, bat-like wing). */
  fingers3: boolean;
  /** Bank into turns (roll poses) and a lit leading edge. */
  bank: boolean; rim: boolean;
}
export const CLASSIC: DragonStyle = { pal: PAL, scale: 1, span: 1, body: 1, fingers3: false, bank: false, rim: false };

type P3 = [number, number, number];
interface Poly { pts: P3[]; part: Part }
interface Line { a: P3; b: P3; part: Part; w: number }

const QUAD = ['', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'].map((c) => (c ? g(c) : 0));
const MEMBRANE = ['▓', '▓', '▓', '▒'].map(g);
const SOLID = g('█'), SHEEN = g('▓');
const LINE_GLYPH = ['─', '╲', '│', '╱'].map(g);
const RIDGE = g('▴');

/** Wing outline for one side (s = +1 right, -1 left) in a given mode and flap angle. */
function wing(s: number, mode: Mode, theta: number, st: DragonStyle = CLASSIC): { poly: P3[]; bones: Array<[P3, P3]> } {
  // Base outline (extended): shoulder S, wrist W, tip T, finger tips F2/F3, trailing root R.
  let S: number[] = [1.1, 1.2], W = [3.2, 5.6], T = [-0.6, 12.6], F2 = [-5.6, 10.6], F3 = [-6.2, 6.6], R = [-3.3, 1.3];
  if (st.span !== 1) { const k = st.span; W = [W[0], 1.2 + (W[1] - 1.2) * k]; T = [T[0] + 0.4, 1.2 + (T[1] - 1.2) * k]; F2 = [F2[0], 1.2 + (F2[1] - 1.2) * k]; F3 = [F3[0], 1.2 + (F3[1] - 1.2) * k]; }
  let F1: number[] | null = st.fingers3 ? [(T[0] + F2[0]) / 2 - 0.9, (T[1] + F2[1]) / 2 + 0.3] : null;
  let zs = [0, 0, 0, 0, 0, 0];
  if (mode === Mode.Standing || mode === Mode.Lying) {
    const k = mode === Mode.Lying ? 0.5 : 1;
    S = [0.9, 1.1]; W = [1.3, 2.5]; T = [-3.9, 3.1]; F2 = [-4.3, 2.5]; F3 = [-3.4, 1.9]; R = [-2.3, 1.2];
    zs = [0.4, 2.2 * k, 1.1 * k, 0.9 * k, 0.7 * k, 0.4 * k];
  }
  if (F1 && (mode === Mode.Standing || mode === Mode.Lying)) F1 = [(T[0] + F2[0]) / 2, (T[1] + F2[1]) / 2];
  const pts0 = F1 ? [S, W, T, F2, F3, R, F1] : [S, W, T, F2, F3, R];
  if (F1) zs.push((zs[2] + zs[3]) / 2);
  const out: P3[] = pts0.map((p, k) => {
    let [x, y] = p as [number, number];
    let z = zs[k];
    if (mode === Mode.Flight || mode === Mode.Glide || mode === Mode.Landing) {
      const span = y - 1.1;
      const th = mode === Mode.Glide ? 0.12 : mode === Mode.Landing ? 0.95 : theta;
      const c = Math.max(0.22, Math.cos(th));
      y = 1.1 + span * c;
      z = Math.sin(th) * span * 0.85;
      if (mode === Mode.Glide) x -= (span / 11) * 0.6;
      if (mode === Mode.Landing) x -= (span / 11) * 2.6;
      // Downstroke: tips reach slightly forward; upstroke: slightly back.
      if (mode === Mode.Flight) x += -Math.sin(th) * (span / 11) * 0.8;
    }
    return [x, y * s, z];
  });
  const [Sp, Wp, Tp, F2p, F3p, Rp, F1p] = out;
  // Scalloped trailing edge: midpoints between finger tips pulled toward the wrist.
  const pull = (a: P3, b: P3, k: number): P3 => {
    const m: P3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return [m[0] + (Wp[0] - m[0]) * k, m[1] + (Wp[1] - m[1]) * k, m[2] + (Wp[2] - m[2]) * k];
  };
  const folded = mode === Mode.Standing || mode === Mode.Lying;
  if (F1p) {
    const poly: P3[] = [Sp, Wp, Tp, pull(Tp, F1p, 0.3), F1p, pull(F1p, F2p, 0.32), F2p, pull(F2p, F3p, 0.33), F3p, pull(F3p, Rp, 0.26), Rp];
    return { poly, bones: folded ? [[Sp, Wp], [Wp, Tp]] : [[Sp, Wp], [Wp, Tp], [Wp, F1p], [Wp, F2p], [Wp, F3p]] };
  }
  const poly: P3[] = [Sp, Wp, Tp, pull(Tp, F2p, 0.36), F2p, pull(F2p, F3p, 0.33), F3p, pull(F3p, Rp, 0.26), Rp];
  return { poly, bones: folded ? [[Sp, Wp], [Wp, Tp]] : [[Sp, Wp], [Wp, Tp], [Wp, F2p], [Wp, F3p]] };
}

function body(mode: Mode, st: DragonStyle = CLASSIC): { polys: Poly[]; lines: Line[] } {
  const r = classicBody(mode);
  if (st.body === 1) return r;
  const k = st.body, f = (p: P3): P3 => [p[0] * k, p[1] * (0.85 + k * 0.15), p[2]];
  return { polys: r.polys.map((q) => ({ ...q, pts: q.pts.map(f) })), lines: r.lines.map((l) => ({ ...l, a: f(l.a), b: f(l.b) })) };
}

function classicBody(mode: Mode): { polys: Poly[]; lines: Line[] } {
  const zb = mode === Mode.Standing ? 1.2 : mode === Mode.Lying ? 0.35 : 0.6;
  const pts: P3[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, cx = Math.cos(a), sy = Math.sin(a);
    // Broad chest, tapering hips.
    const half = 1.6 * (cx > 0 ? 1 : 0.8) + (cx > 0.3 && cx < 0.9 ? 0.2 : 0);
    pts.push([0.2 + 3.1 * cx, half * sy, zb]);
  }
  const lines: Line[] = [{ a: [2.7, 0, zb + 0.3], b: [-2.8, 0, zb + 0.3], part: Part.Ridge, w: 0.3 }];
  // Legs: tucked in flight, reaching down to land, planted on the ground.
  const legsDown = mode === Mode.Landing ? -1.7 : mode === Mode.Standing ? -zb : mode === Mode.Lying ? -0.2 : null;
  // Legs are scaled limbs (body colour) with pale claws only at the feet.
  for (const s of [-1, 1]) {
    if (legsDown === null) {
      lines.push({ a: [-1.8, 1.1 * s, zb], b: [-3.0, 1.4 * s, zb - 0.2], part: Part.Body, w: 0.35 });
      lines.push({ a: [-3.0, 1.4 * s, zb - 0.2], b: [-3.5, 1.45 * s, zb - 0.25], part: Part.Claw, w: 0.22 });
    } else {
      for (const [hx, fx] of [[1.0, 1.5], [-1.6, -1.4]]) {
        const foot: P3 = [fx, 1.95 * s, zb + legsDown];
        lines.push({ a: [hx, 1.3 * s, zb], b: foot, part: Part.Body, w: 0.42 });
        if (fx > 0) lines.push({ a: foot, b: [foot[0] + 0.35, foot[1], foot[2]], part: Part.Claw, w: 0.08 });
      }
    }
  }
  return { polys: [{ pts, part: Part.Body }], lines };
}

function inPoly(px: number, py: number, xs: Float32Array, ys: Float32Array, n: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if ((ys[i] > py) !== (ys[j] > py) && px < ((xs[j] - xs[i]) * (py - ys[i])) / (ys[j] - ys[i]) + xs[i]) inside = !inside;
  }
  return inside;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

export const lineGlyph = (dx: number, dy: number): number => {
  let a = Math.atan2(dy, dx);
  if (a < 0) a += Math.PI;
  return LINE_GLYPH[Math.round(a / (Math.PI / 4)) % 4];
};

const shade = (c: RGB, k: number) => pack(c[0] * k, c[1] * k, c[2] * k);
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class DragonPoses {
  constructor(readonly style: DragonStyle = CLASSIC) {}
  private cache = new Map<number, PoseCell[]>();
  private shadows = new Map<number, ShadowCell[]>();
  private hs = 0.75;
  built = 0;

  /** Rows per metre changed (relief slider): cached poses are invalid. */
  setRelief(hs: number): void {
    if (Math.abs(hs - this.hs) < 1e-3) return;
    this.hs = hs;
    this.cache.clear();
  }

  static key(dir: number, mode: Mode, frame: number, size: number): number { return ((dir * 8 + mode) * 16 + frame) * 8 + size; }
  has(dir: number, mode: Mode, frame: number, size: number): boolean { return this.cache.has(DragonPoses.key(dir, mode, frame, size)); }

  /** A pose; `bank` (-2..2) rolls the body into a turn (styles that bank only). */
  get(dir: number, mode: Mode, frame: number, size: number, bank = 0): PoseCell[] {
    const b = this.style.bank && (mode === Mode.Flight || mode === Mode.Glide) ? Math.max(-2, Math.min(2, Math.round(bank))) : 0;
    const key = DragonPoses.key(dir, mode, frame, size) * 5 + b + 2;
    let p = this.cache.get(key);
    if (!p) { p = this.build(dir, mode, frame, size, false, b) as PoseCell[]; this.cache.set(key, p); this.built++; }
    return p;
  }

  /** Flat silhouette (no height) for the ground shadow. */
  shadow(dir: number, mode: Mode, size: number): ShadowCell[] {
    const flat = mode === Mode.Flight ? Mode.Glide : mode;
    const key = (dir * 8 + flat) * 8 + size;
    let p = this.shadows.get(key);
    if (!p) { p = this.build(dir, flat, 0, size, true) as ShadowCell[]; this.shadows.set(key, p); }
    return p;
  }

  private build(dir: number, mode: Mode, frame: number, size: number, flat: boolean, bank = 0): PoseCell[] | ShadowCell[] {
    const st = this.style, PAL = st.pal;
    const h = (dir / DIRS) * Math.PI * 2, ch = Math.cos(h), sh = Math.sin(h), sc = SIZES[size] * st.scale, hs = flat ? 0 : this.hs;
    const theta = FRAME_ANGLES[frame];
    // Bank: roll about the body's long axis (the inside wing dips, the outside one rises).
    const roll = bank * 0.21, cr = Math.cos(roll), sr = Math.sin(roll);
    const proj = (p0: P3): [number, number] => {
      const p: P3 = roll ? [p0[0], p0[1] * cr - p0[2] * sr, p0[1] * sr + p0[2] * cr] : p0;
      return [(p[0] * ch - p[1] * sh) * sc, (p[0] * sh + p[1] * ch) * sc * ASPECT - p[2] * sc * hs];
    };
    const B = body(mode, st);
    const wings = [wing(-1, mode, theta, st), wing(1, mode, theta, st)];
    // Projected shapes, in drawing priority (later wins).
    const polys: Array<{ xs: Float32Array; ys: Float32Array; part: Part }> = [];
    for (const wg of wings) {
      const xs = new Float32Array(wg.poly.length), ys = new Float32Array(wg.poly.length);
      wg.poly.forEach((p, k) => { [xs[k], ys[k]] = proj(p); });
      polys.push({ xs, ys, part: Part.Membrane });
    }
    for (const bp of B.polys) {
      const xs = new Float32Array(bp.pts.length), ys = new Float32Array(bp.pts.length);
      bp.pts.forEach((p, k) => { [xs[k], ys[k]] = proj(p); });
      polys.push({ xs, ys, part: bp.part });
    }
    const lines: Array<{ ax: number; ay: number; bx: number; by: number; part: Part; w: number }> = [];
    for (const wg of wings) wg.bones.forEach(([a, b], k) => { const [ax, ay] = proj(a), [bx, by] = proj(b); lines.push({ ax, ay, bx, by, part: k === 0 ? Part.Arm : Part.Bone, w: (k === 0 ? 0.5 : 0.28) * Math.max(0.8, sc) }); });
    for (const l of B.lines) { const [ax, ay] = proj(l.a), [bx, by] = proj(l.b); lines.push({ ax, ay, bx, by, part: l.part, w: l.w * sc }); }
    // Bounding box.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (let k = 0; k < p.xs.length; k++) { x0 = Math.min(x0, p.xs[k]); x1 = Math.max(x1, p.xs[k]); y0 = Math.min(y0, p.ys[k]); y1 = Math.max(y1, p.ys[k]); }
    for (const l of lines) { x0 = Math.min(x0, l.ax, l.bx); x1 = Math.max(x1, l.ax, l.bx); y0 = Math.min(y0, l.ay, l.by); y1 = Math.max(y1, l.ay, l.by); }
    const cx0 = Math.floor(x0) - 1, cx1 = Math.ceil(x1) + 1, cy0 = Math.floor(y0) - 1, cy1 = Math.ceil(y1) + 1;
    // Body extent (for shading and the underside).
    const bpoly = polys[polys.length - 1];
    let bcx = 0, bcy = 0;
    for (let k = 0; k < bpoly.xs.length; k++) { bcx += bpoly.xs[k]; bcy += bpoly.ys[k]; }
    bcx /= bpoly.xs.length; bcy /= bpoly.xs.length;
    const out: PoseCell[] = [], shadowOut: ShadowCell[] = [];
    const counts = new Uint8Array(7);
    const bodyLow = new Map<number, number>(); // lowest body row per column (underside)
    const cells: Array<{ dx: number; dy: number; part: Part; cov: number; mask: number; line?: { dx: number; dy: number } }> = [];
    // Prefilter boxes.
    const pbox = polys.map((p) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (let k = 0; k < p.xs.length; k++) { a = Math.min(a, p.xs[k]); c = Math.max(c, p.xs[k]); b = Math.min(b, p.ys[k]); d = Math.max(d, p.ys[k]); } return [a, b, c, d]; });
    const lbox = lines.map((l) => [Math.min(l.ax, l.bx) - l.w - 0.2, Math.min(l.ay, l.by) - l.w - 0.2, Math.max(l.ax, l.bx) + l.w + 0.2, Math.max(l.ay, l.by) + l.w + 0.2]);
    const quad = new Uint8Array(4);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      counts.fill(0); quad.fill(0);
      let union = 0, lineHit: { dx: number; dy: number } | undefined;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = cx + (sx + 0.5) / 4, py = cy + (sy + 0.5) / 4;
        let part = Part.None;
        for (let k = 0; k < polys.length; k++) {
          const b = pbox[k];
          if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
          if (inPoly(px, py, polys[k].xs, polys[k].ys, polys[k].xs.length)) part = polys[k].part;
        }
        for (let k = 0; k < lines.length; k++) {
          const b = lbox[k], l = lines[k];
          if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
          if (segDist(px, py, l.ax, l.ay, l.bx, l.by) < l.w + 0.18) {
            if (l.part === Part.Ridge && part !== Part.Body) continue;
            if ((l.part === Part.Bone || l.part === Part.Arm) && part === Part.Body) continue;
            part = l.part; lineHit = { dx: l.bx - l.ax, dy: l.by - l.ay };
          }
        }
        if (part) { counts[part]++; union++; quad[(sy >> 1) * 2 + (sx >> 1)]++; }
      }
      if (!union) continue;
      let top = Part.None;
      for (const pr of [Part.Membrane, Part.Bone, Part.Arm, Part.Body, Part.Claw, Part.Ridge]) if (counts[pr] >= 2) top = pr;
      if (top === Part.None) for (const pr of [Part.Membrane, Part.Body, Part.Bone, Part.Arm, Part.Claw, Part.Ridge]) if (counts[pr]) top = pr;
      // Quadrant mask: a quarter counts when at least 2 of its 4 samples are covered.
      let qmask = 0;
      for (let q = 0; q < 4; q++) if (quad[q] >= 2) qmask |= 1 << q;
      if (flat) { shadowOut.push({ dx: cx, dy: cy, a: union / 16 }); continue; }
      if (!qmask) continue;
      cells.push({ dx: cx, dy: cy, part: top, cov: union / 16, mask: qmask, line: lineHit });
      if (top === Part.Body) bodyLow.set(cx, Math.max(bodyLow.get(cx) ?? -1e9, cy));
    }
    if (flat) return shadowOut;
    const span = Math.max(4, (x1 - x0) / 2);
    const lift = mode === Mode.Flight ? Math.sin(theta) : mode === Mode.Landing ? 0.8 : 0.1;
    for (const c of cells) {
      const ux = (c.dx + 0.5 - bcx) / span, uy = (c.dy + 0.5 - bcy) / span;
      const light = Math.max(0.6, Math.min(1.35, 1 - ux * 0.4 - uy * 0.55));
      const hsh = hash2(c.dx * 7 + dir, c.dy * 5 + mode, 91);
      const full = c.mask === 15 && c.cov > 0.7;
      let gl: number, fg: number, bg: number, alpha: number;
      switch (c.part) {
        case Part.Membrane: {
          // Dense crimson skin, lighter toward the light and when the wing lifts; the silhouette edge is a black rim.
          const k = (0.88 + lift * 0.16) * light;
          const col = mixc(PAL.membrane, PAL.membraneLit, Math.min(1, Math.max(0, (light - 0.7) * 1.3)));
          gl = full ? MEMBRANE[Math.floor(hsh * MEMBRANE.length)] : QUAD[c.mask];
          fg = full ? shade(col, k * 1.08) : shade(PAL.membraneEdge, 1);
          bg = shade(col, k * 0.72);
          alpha = full ? 1 : 0;
          break;
        }
        case Part.Bone: case Part.Arm: {
          // Finger bones and the leading edge: dark strokes, as in the silhouette of a bat wing.
          gl = c.part === Part.Arm && full ? SOLID : c.line ? lineGlyph(c.line.dx, c.line.dy) : QUAD[c.mask];
          fg = c.part === Part.Arm ? shade(PAL.boneLit, light * (st.rim ? 1.45 : 1)) : shade(PAL.bone, st.rim ? 1.25 : 1);
          bg = shade(mixc(PAL.membrane, PAL.bone, 0.35), 0.8 * light);
          alpha = full ? 1 : 0;
          break;
        }
        case Part.Ridge: {
          gl = RIDGE; fg = shade(PAL.ridge, Math.min(1.05, light)); bg = shade(PAL.scale, light * 0.9); alpha = 1;
          break;
        }
        case Part.Claw: {
          gl = c.line ? lineGlyph(c.line.dx, c.line.dy) : QUAD[c.mask];
          fg = shade(mixc(PAL.claw, PAL.scale, 0.3), Math.min(1.05, light)); bg = shade(PAL.charcoal, 1); alpha = full ? 1 : 0;
          break;
        }
        default: {
          // Scales: lit from the upper left; the lowest body row in each column shows the lighter underside.
          // Solid obsidian, shaded smoothly; lit cells show a steel sheen, the underside a dark ember-brown.
          const under = bodyLow.get(c.dx) === c.dy;
          const sheen = light > 1.08 && hsh > 0.35;
          const base = under ? mixc(PAL.scale, PAL.belly, 0.8) : mixc(PAL.scale, PAL.scaleLit, Math.max(0, light - 1) * 1.6);
          gl = full ? (sheen ? SHEEN : SOLID) : QUAD[c.mask];
          fg = shade(base, full ? light : light * 1.05);
          bg = shade(under ? mixc(PAL.scaleDark, PAL.belly, 0.4) : PAL.scale, light * 0.82);
          alpha = full ? 1 : 0;
        }
      }
      out.push({ dx: c.dx, dy: c.dy, g: gl, fg, bg, alpha, part: c.part });
    }
    return out;
  }
}
