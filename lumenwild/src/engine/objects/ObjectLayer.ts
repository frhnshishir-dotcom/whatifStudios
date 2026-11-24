import type { SceneLayer } from '../render/Composer';
import type { CellBuffer } from '../render/CellBuffer';
import type { Camera } from '../world/Camera';
import type { World } from '../world/World';
import type { WaterView } from '../water/WaterSim';
import type { ObjectStore } from './ObjectStore';
import { Anim, type WorldObject } from './defs';
import { g } from '../render/glyphs';
import { hash2 } from '../core/rng';

// Wheel rim glyphs by ring position (clockwise from top-left) and the paddle glyph; paddles rotate around the rim.
const RIM = ['╭', '─', '╮', '│', '╯', '─', '╰', '│'].map((c) => g(c));
const PADDLE = g('■');
const HUB = [g('✱'), g('✻')];

/**
 * Draws object sprites after terrain and water, back to front by ground row, with a depth test against the cell
 * buffer (nearer terrain hides objects behind it). Animation is applied per cell at draw time: canopy sway with the
 * wind, glow pulses, lit windows at night, the mill wheel turning with the water speed under it.
 */
export class ObjectLayer implements SceneLayer {
  readonly world: World;
  readonly store: ObjectStore;
  water: WaterView | null;
  /** Wind strength 0..1 and direction sign (set by the weather system). */
  wind = 0.35;
  windDir = 1;
  /** 0 = day, 1 = night: windows glow. */
  night = 0;
  /** Global light multiplier (day/night) for sprite colours. */
  light = 1;
  selectedId = 0;
  private list: WorldObject[] = [];
  private wheelPhase = new Map<number, number>();
  private lastT = 0;
  drawn = 0;

  constructor(world: World, store: ObjectStore, water: WaterView | null) {
    this.world = world;
    this.store = store;
    this.water = water;
  }

  after(buf: CellBuffer, cam: Camera, t: number): void {
    const w = this.world, s = this.store;
    const dt = Math.max(0, Math.min(0.1, t - this.lastT));
    this.lastT = t;
    const x0 = Math.floor(cam.x), y0 = Math.floor(cam.y), hs = cam.heightScale;
    const cols = buf.cols, rows = buf.rows;
    // Objects can stand up to ~10 rows tall and the terrain lifts far cells: query a generous rectangle.
    const lift = 40;
    s.inRect(x0 - 8, y0 - 6, x0 + cols + 8, y0 + rows + lift, this.list);
    this.list.sort((a, b) => a.y - b.y || a.x - b.x);
    let drawn = 0;
    for (const o of this.list) {
      const cells = s.sprite(o);
      const z = o.kind === 'bridge' ? o.props.z ?? w.elevAt(o.x, o.y) : w.elevAt(o.x, o.y);
      const sel = o.id === this.selectedId;
      let phase = 0;
      if (o.kind === 'mill') {
        const wv = this.wheelCellSpeed(o);
        phase = (this.wheelPhase.get(o.id) ?? 0) + dt * (0.6 + wv * 3);
        this.wheelPhase.set(o.id, phase);
      }
      for (const c of cells) {
        const wx = o.x + c.dx, wy = o.y + c.dy;
        let col = wx - x0;
        const row = wy - y0 - Math.round(z * hs) - c.up;
        let gl = c.g, fg = c.fg, bg = c.bg;
        const base = c.anim & 15;
        if (base === Anim.Sway || base === Anim.SwayStrand) {
          // Gentle sway: upper canopy cells lean one column in gusts, deterministic per object.
          const gust = Math.sin(t * 1.3 + o.x * 0.21 + o.y * 0.13) * 0.6 + Math.sin(t * 0.47 + o.id) * 0.4;
          if (this.wind * gust > (base === Anim.SwayStrand ? 0.18 : 0.32) && c.up >= 2) col += this.windDir;
        } else if (base === Anim.Glow) {
          const k = 0.75 + 0.25 * Math.sin(t * 2.1 + o.id * 1.7 + c.dx);
          fg = scale(fg, k * (1 + this.night * 0.35));
        } else if (base === Anim.Window) {
          fg = scale(fg, 0.75 + this.night * 0.6);
          bg = scale(bg, 1 + this.night * 1.6);
        } else if (base === Anim.Spark) {
          if (hash2(o.id, Math.floor(t * 3), 1) < 0.5) continue;
        } else if (base === Anim.Wheel) {
          const k = (c.anim >> 4) - 1, frame = Math.floor(phase * 3);
          if (k < 0) gl = HUB[frame & 1];
          else if (((k + frame) & 1) === 0) { gl = PADDLE; fg = 0xff6fa6d8; }
          else gl = RIM[k];
        }
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        const k = row * cols + col;
        if (buf.depth[k] > wy + 0.85) continue; // nearer terrain covers this
        buf.glyph[k] = gl;
        buf.fg[k] = this.light === 1 ? fg : scale(fg, this.light);
        if (bg) buf.bg[k] = this.light === 1 ? bg : scale(bg, this.light);
        if (sel) { buf.bg[k] = mixPacked(buf.bg[k], 0xff60c090, 0.35); }
        buf.depth[k] = wy + 0.7;
        buf.kind[k] = 5;
        buf.pick[k] = wy * w.w + wx;
        drawn++;
      }
    }
    this.drawn = drawn;
  }

  private wheelCellSpeed(o: WorldObject): number {
    if (!this.water) return 0;
    const side = (o.props.wheelSide ?? 1) > 0 ? 5 : -2;
    const x = o.x + side, y = o.y + 2;
    if (!this.world.inBounds(x, y)) return 0;
    const i = y * this.world.w + x;
    return Math.min(3, Math.hypot(this.water.velX[i], this.water.velY[i]));
  }
}


function scale(p: number, k: number): number {
  const r = Math.min(255, (p & 255) * k), gg = Math.min(255, ((p >>> 8) & 255) * k), b = Math.min(255, ((p >>> 16) & 255) * k);
  return ((0xff << 24) | (b << 16) | (gg << 8) | r) >>> 0;
}

function mixPacked(a: number, b: number, t: number): number {
  const r = (a & 255) + (((b & 255) - (a & 255)) * t), gg = ((a >>> 8) & 255) + ((((b >>> 8) & 255) - ((a >>> 8) & 255)) * t), bb = ((a >>> 16) & 255) + ((((b >>> 16) & 255) - ((a >>> 16) & 255)) * t);
  return ((0xff << 24) | (bb << 16) | (gg << 8) | r) >>> 0;
}
