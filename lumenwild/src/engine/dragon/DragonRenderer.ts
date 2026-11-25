import type { SceneLayer } from '../render/Composer';
import type { CellBuffer } from '../render/CellBuffer';
import type { Camera } from '../world/Camera';
import type { Dragon } from './Dragon';
import { DragonPoses, DIRS, FRAME_ANGLES, Mode, PAL, ASPECT, SIZES, lineGlyph, type PoseCell } from './DragonPoses';
import { NECK_BASE, TAIL_BASE } from './DragonAnimation';
import { DRAGON } from './DragonConfig';
import { g } from '../render/glyphs';
import { pack, type RGB } from '../core/color';

/** Cell kind written for dragon cells (picking: clicking the dragon opens its panel). */
export const KIND_DRAGON = 7;
const SOLID = g('█'), SHEEN = g('▓');
const EYE_BIG = g('●'), EYE = g('•'), TIP = g('◆'), HORN_TIP = g('▴');
const shadeP = (c: RGB, k: number) => pack(c[0] * k, c[1] * k, c[2] * k);

function mixPacked(a: number, b: number, t: number): number {
  const r = (a & 255) + ((b & 255) - (a & 255)) * t, gg = ((a >>> 8) & 255) + (((b >>> 8) & 255) - ((a >>> 8) & 255)) * t, bb = ((a >>> 16) & 255) + (((b >>> 16) & 255) - ((a >>> 16) & 255)) * t;
  return ((0xff << 24) | (bb << 16) | (gg << 8) | r) >>> 0;
}
function darken(c: number, k: number): number {
  return ((0xff << 24) | ((((c >>> 16) & 255) * k) << 16) | ((((c >>> 8) & 255) * k) << 8) | ((c & 255) * k)) >>> 0;
}

/**
 * Draws the dragon after objects and particles and before weather and light (so it takes the time of day and fog):
 * its ground shadow (softer, fainter, smaller with altitude), the tail (a tapering stroke along the animated chain),
 * the cached body-and-wings pose for its heading, wing frame and apparent size, then neck, head, horns and glowing
 * amber eyes. In the air it is drawn over everything; on the ground it is depth-tested like an object.
 */
export class DragonRenderer implements SceneLayer {
  readonly dragon: Dragon;
  readonly poses = new DragonPoses();
  visible = true;
  /** Apparent size level (0 = full size), with hysteresis so it doesn't flicker at thresholds. */
  sizeLevel = 0;
  readonly stats = { cells: 0, shadow: 0, dir: 0, frame: 0, mode: 0 };
  private buf!: CellBuffer;
  private ground = false;
  private worldY = 0;
  private pick = -1;

  constructor(dragon: Dragon) { this.dragon = dragon; }

  /** Apparent scale for an altitude above ground (smaller when higher). */
  static levelFor(alt: number, prev: number): number {
    const edges = [9, 20, 34];
    let l = 0;
    while (l < 3 && alt > edges[l] + (l < prev ? -2 : 2)) l++;
    return l;
  }

  after(buf: CellBuffer, cam: Camera, t: number): void {
    if (!this.visible) return;
    const d = this.dragon, e = d.e, s = d.senses, w = s.world;
    this.buf = buf;
    this.poses.setRelief(cam.heightScale);
    const x0 = Math.floor(cam.x), y0 = Math.floor(cam.y), hs = cam.heightScale;
    const gz = s.ground(e.x, e.y), alt = Math.max(0, e.z - gz);
    this.sizeLevel = DragonRenderer.levelFor(alt, this.sizeLevel);
    const size = this.sizeLevel, sc = SIZES[size];
    const st = e.state;
    const mode = st === 'SLEEPING' || st === 'RESTING' ? Mode.Lying : !e.airborne ? Mode.Standing : st === 'LANDING' ? Mode.Landing
      : e.wingAmp < 0.12 ? Mode.Glide : Mode.Flight;
    let frame = 0, best = Infinity;
    if (mode === Mode.Flight) FRAME_ANGLES.forEach((a, k) => { const dd = Math.abs(a - e.flap); if (dd < best) { best = dd; frame = k; } });
    const dir = ((Math.round((e.heading / (Math.PI * 2)) * DIRS) % DIRS) + DIRS) % DIRS;
    this.stats.dir = dir; this.stats.frame = frame; this.stats.mode = mode;
    this.ground = !e.airborne || alt < 1.5;
    this.worldY = e.y + 0.8;
    this.pick = Math.min(w.h - 1, Math.max(0, Math.floor(e.y))) * w.w + Math.min(w.w - 1, Math.max(0, Math.floor(e.x)));
    const col = (wx: number) => wx - x0, row = (wy: number, wz: number) => wy - y0 - wz * hs;
    let drawn = 0;

    // Shadow on the ground under the dragon.
    const op = this.ground ? 0.45 : Math.max(0.1, 0.5 - alt * 0.011);
    const soft = Math.min(0.6, alt / 60);
    const gc = Math.floor(col(e.x)), gr = Math.floor(row(e.y, gz));
    let sh = 0;
    for (const c of this.poses.shadow(dir, mode, size)) {
      const k = (gr + c.dy) * buf.cols + gc + c.dx;
      if (gc + c.dx < 0 || gr + c.dy < 0 || gc + c.dx >= buf.cols || gr + c.dy >= buf.rows) continue;
      const kind = buf.kind[k];
      if (kind === 0 || kind === KIND_DRAGON || kind === 6) continue;
      const a = op * Math.min(1, c.a * (1.25 - soft));
      if (a < 0.02) continue;
      buf.bg[k] = darken(buf.bg[k], 1 - a); buf.fg[k] = darken(buf.fg[k], 1 - a * 0.8);
      sh++;
    }
    this.stats.shadow = sh;

    // Tail: tapering stroke along the chain (scaled about the body like the pose).
    const sx = (wx: number) => e.x + (wx - e.x) * sc, sy = (wy: number) => e.y + (wy - e.y) * sc * ASPECT, sz = (wz: number) => e.z + (wz - e.z) * sc;
    const ch = Math.cos(e.heading), shh = Math.sin(e.heading);
    let ax = col(sx(e.x - ch * TAIL_BASE)), ay = row(sy(e.y - shh * TAIL_BASE), e.z);
    const N = e.tailX.length;
    for (let k = 0; k < N; k++) {
      const bx = col(sx(e.tailX[k])), by = row(sy(e.tailY[k]), sz(e.tailZ[k]));
      const r = (1.15 - (0.85 * k) / N) * sc;
      drawn += this.stroke(ax, ay, bx, by, r, k, N, t);
      ax = bx; ay = by;
    }
    // Spaded tip.
    drawn += this.put(Math.floor(ax), Math.floor(ay), TIP, shadeP(PAL.membraneLit, 1.3), 0, 0, 0);

    // Body and wings: the cached pose for this heading, wing frame and size (built on first use).
    const pose: PoseCell[] = this.poses.get(dir, mode, frame, size);
    const pc = Math.floor(col(e.x)), pr = Math.floor(row(e.y, e.z));
    // The dorsal ridge glows faintly (a hint of magic, and visible at night).
    for (const c of pose) drawn += this.put(pc + c.dx, pr + c.dy, c.g, c.fg, c.bg, c.alpha, c.part === 4 ? 150 : 0);

    // Neck (three segments, turning with headYaw, dipping to drink) and head.
    let nx = e.x + ch * NECK_BASE * sc, ny = e.y + shh * NECK_BASE * sc * ASPECT, nz = e.z + 0.5 * sc;
    let a = e.heading;
    for (let k = 0; k < DRAGON.neckSegments; k++) {
      a = e.heading + e.headYaw * ((k + 1) / DRAGON.neckSegments);
      const mx = nx + Math.cos(a) * DRAGON.neckSeg * sc, my = ny + Math.sin(a) * DRAGON.neckSeg * sc * ASPECT;
      const mz = nz + (0.25 - e.headDip * 0.75) * sc;
      drawn += this.stroke(col(nx), row(ny, nz), col(mx), row(my, mz), (0.95 - k * 0.12) * sc, -1, 0, t);
      nx = mx; ny = my; nz = mz;
    }
    drawn += this.head(col(nx), row(ny, nz), a, sc, e.state === 'SLEEPING');
    this.stats.cells = drawn;
  }

  /** Write one dragon cell: alpha 0 keeps the background (edge glyph over the scene), 1 replaces it. */
  private put(c: number, r: number, gl: number, fg: number, bg: number, alpha: number, emissive: number): number {
    const b = this.buf;
    if (c < 0 || r < 0 || c >= b.cols || r >= b.rows) return 0;
    const k = r * b.cols + c;
    if (this.ground && b.depth[k] > this.worldY + 0.1 && b.kind[k] !== KIND_DRAGON) return 0;
    b.glyph[k] = gl;
    b.fg[k] = fg;
    if (alpha >= 1) b.bg[k] = bg; else if (alpha > 0) b.bg[k] = mixPacked(b.bg[k], bg, alpha);
    b.kind[k] = KIND_DRAGON;
    b.pick[k] = this.pick;
    b.depth[k] = this.ground ? this.worldY : 1e6;
    b.light[k] = emissive;
    return 1;
  }

  /** A thick tapering stroke between two screen points (tail and neck segments): scales inside, a line when thin. */
  private stroke(ax: number, ay: number, bx: number, by: number, r: number, k: number, n: number, t: number): number {
    let drawn = 0;
    const x0 = Math.floor(Math.min(ax, bx) - r - 1), x1 = Math.ceil(Math.max(ax, bx) + r + 1), y0 = Math.floor(Math.min(ay, by) - r - 1), y1 = Math.ceil(Math.max(ay, by) + r + 1);
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const u = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
      const dist = Math.hypot(px - ax - vx * u, py - ay - vy * u);
      if (dist > r + 0.3) continue;
      const lit = Math.max(0.65, Math.min(1.25, 1.05 - (py - (ay + vy * u)) * 0.25 - (px - (ax + vx * u)) * 0.15));
      const thin = r < 0.55;
      const top = py < ay + vy * u - r * 0.35;
      const gl = thin ? lineGlyph(vx, vy) : top && lit > 1 ? SHEEN : SOLID;
      const fade = k >= 0 ? 1 - (0.15 * k) / Math.max(1, n) : 1;
      const fg = shadeP(top ? PAL.scaleLit : PAL.scale, lit * fade * (top ? 0.8 : 1));
      drawn += this.put(x, y, gl, fg, shadeP(PAL.scale, lit * 0.8), thin ? 0 : 1, 0);
      void t;
    }
    return drawn;
  }

  /** Head: wedge snout, jaw, swept horns and amber eyes, oriented along angle a. */
  private head(cx: number, cy: number, a: number, sc: number, asleep: boolean): number {
    const ca = Math.cos(a), sa = Math.sin(a);
    const P = (x: number, y: number): [number, number] => [cx + (x * ca - y * sa) * sc, cy + (x * sa + y * ca) * sc * ASPECT];
    const poly = [P(1.8, 0), P(1.0, 0.55), P(-0.2, 0.75), P(-0.8, 0.45), P(-0.8, -0.45), P(-0.2, -0.75), P(1.0, -0.55)];
    let drawn = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let hits = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const px = x + 0.25 + sx * 0.5, py = y + 0.25 + sy * 0.5;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          if ((poly[i][1] > py) !== (poly[j][1] > py) && px < ((poly[j][0] - poly[i][0]) * (py - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) inside = !inside;
        }
        if (inside) hits++;
      }
      if (hits < 2) continue;
      drawn += this.put(x, y, y < cy ? SHEEN : SOLID, shadeP(y < cy ? PAL.scaleLit : PAL.scale, y < cy ? 0.85 : 1.05), shadeP(PAL.scale, 0.9), 1, 0);
    }
    // Horns sweep back from the brow.
    for (const s of [-1, 1]) {
      const [hx0, hy0] = P(-0.3, 0.5 * s), [hx1, hy1] = P(-1.8, 1.05 * s);
      drawn += this.put(Math.floor((hx0 + hx1) / 2), Math.floor((hy0 + hy1) / 2), lineGlyph(hx1 - hx0, hy1 - hy0), shadeP(PAL.horn, 1), 0, 0, 0);
      drawn += this.put(Math.floor(hx1), Math.floor(hy1), HORN_TIP, shadeP(PAL.horn, 1.05), 0, 0, 0);
    }
    // Eyes (amber, glowing; closed when asleep).
    for (const s of [-1, 1]) {
      const [ex, ey] = P(0.35, 0.42 * s);
      drawn += this.put(Math.floor(ex), Math.floor(ey), asleep ? g('─') : sc > 0.85 ? EYE_BIG : EYE, asleep ? shadeP(PAL.scaleLit, 0.7) : shadeP(PAL.eye, 1), shadeP(PAL.charcoal, 1), 1, asleep ? 0 : 230);
    }
    // Nostril glint at the snout.
    const [nx, ny] = P(1.7, 0);
    drawn += this.put(Math.floor(nx), Math.floor(ny), g('▸'), shadeP(PAL.scaleLit, 0.9), 0, 0, 0);
    return drawn;
  }
}
