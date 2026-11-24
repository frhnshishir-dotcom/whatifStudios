import type { CellBuffer } from './CellBuffer';
import type { Camera } from '../world/Camera';
import { g } from './glyphs';
import { pack } from '../core/color';

export const PK = { Splash: 0, Mist: 1, Leaf: 2, Firefly: 3, Rain: 4, Pollen: 5, Spark: 6, FloatLeaf: 7 } as const;

/**
 * Pooled particle system (fixed-capacity typed arrays, no per-frame allocation). Positions are world metres:
 * x, y on the grid, z = height. Particles are drawn after terrain with a depth test against the cell buffer, so
 * terrain in front hides them. Kinds define glyph, colour and motion (splash arcs, mist, leaves, fireflies, rain).
 */
export class Particles {
  readonly cap: number;
  n = 0;
  readonly x: Float32Array; readonly y: Float32Array; readonly z: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly life: Float32Array; readonly maxLife: Float32Array; readonly seed: Float32Array;
  readonly kind: Uint8Array;
  /** Global wind (m/s), used by leaves, mist, pollen and rain. */
  windX = 0.4; windY = 0.1;
  /** Water under a point: writes [velX, velY, depth] and returns true when wet (leaves float, rain makes rings). */
  flowAt: ((x: number, y: number, out: Float32Array) => boolean) | null = null;
  /** A rain drop reached the ground or water. */
  onLand: ((kind: number, x: number, y: number, wet: boolean) => void) | null = null;
  private flow = new Float32Array(3);
  private glyphs = {
    splash: [g('·'), g('°'), g('˚'), g('∙'), g('*')],
    mist: [g('░'), g('·'), g('˚')],
    leaf: [g(','), g('’'), g('`'), g('\'')],
    floatLeaf: [g(','), g('’'), g('·'), g('`')],
    firefly: [g('·'), g('∙'), g('•'), g('✦')],
    rain: [g('│'), g('╎'), g('¦')],
    rainR: [g('/'), g('╱')],
    rainL: [g('\\'), g('╲')],
    pollen: [g('·'), g('˚'), g('°')],
    spark: [g('✧'), g('✦'), g('·'), g('˚')],
  };

  constructor(cap = 4000) {
    this.cap = cap;
    const f = () => new Float32Array(cap);
    this.x = f(); this.y = f(); this.z = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f(); this.seed = f();
    this.kind = new Uint8Array(cap);
  }

  spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, seed: number): void {
    if (this.n >= this.cap) return;
    const k = this.n++;
    this.x[k] = x; this.y[k] = y; this.z[k] = z; this.vx[k] = vx; this.vy[k] = vy; this.vz[k] = vz;
    this.life[k] = life; this.maxLife[k] = life; this.seed[k] = seed; this.kind[k] = kind;
  }

  /** Advance; `ground(x, y)` gives the surface height (terrain or water) so splashes land and rain stops. */
  update(dt: number, t: number, ground: (x: number, y: number) => number): void {
    let k = 0;
    while (k < this.n) {
      this.life[k] -= dt;
      const kind = this.kind[k];
      if (kind === PK.Splash) {
        this.vz[k] -= 14 * dt;
      } else if (kind === PK.Mist) {
        this.vz[k] = 0.35;
        this.vx[k] += (this.windX - this.vx[k]) * dt;
      } else if (kind === PK.Leaf) {
        const s = this.seed[k];
        this.vx[k] = this.windX * 1.6 + Math.sin(t * 1.7 + s * 20) * 0.6;
        this.vy[k] = this.windY + Math.cos(t * 1.3 + s * 13) * 0.3;
        this.vz[k] = -0.45 + Math.sin(t * 2.1 + s * 7) * 0.25;
      } else if (kind === PK.Firefly || kind === PK.Pollen) {
        const s = this.seed[k];
        this.vx[k] = Math.sin(t * 0.7 + s * 31) * 0.35 + this.windX * 0.2;
        this.vy[k] = Math.cos(t * 0.6 + s * 17) * 0.3;
        this.vz[k] = Math.sin(t * 0.9 + s * 11) * 0.25;
      } else if (kind === PK.Rain) {
        this.vx[k] = this.windX * 1.4;
      } else if (kind === PK.FloatLeaf) {
        // Carried by the current; a leaf washed ashore fades quickly.
        const f = this.flow, s = this.seed[k];
        if (this.flowAt && this.flowAt(this.x[k], this.y[k], f)) {
          this.vx[k] = f[0] * 0.85 + Math.sin(t * 0.9 + s * 9) * 0.06;
          this.vy[k] = f[1] * 0.85 + Math.cos(t * 0.8 + s * 7) * 0.06;
        } else { this.vx[k] *= 0.9; this.vy[k] *= 0.9; this.life[k] -= dt * 4; }
        this.vz[k] = 0;
      }
      this.x[k] += this.vx[k] * dt;
      this.y[k] += this.vy[k] * dt;
      this.z[k] += this.vz[k] * dt;
      const gz = ground(this.x[k], this.y[k]);
      if (kind === PK.Firefly || kind === PK.Pollen || kind === PK.Spark) { if (this.z[k] < gz + 0.4) { this.z[k] = gz + 0.4; } }
      else if (kind === PK.FloatLeaf) this.z[k] = gz;
      else if (this.z[k] < gz && (kind === PK.Splash || kind === PK.Rain || kind === PK.Leaf)) {
        const wet = !!this.flowAt && this.flowAt(this.x[k], this.y[k], this.flow);
        if (kind === PK.Leaf && wet) {
          // A falling leaf that lands on water floats away.
          this.kind[k] = PK.FloatLeaf; this.z[k] = gz; this.life[k] = this.maxLife[k] = 25 + this.seed[k] * 25;
        } else {
          if (kind === PK.Rain) this.onLand?.(kind, this.x[k], this.y[k], wet);
          this.life[k] = 0;
        }
      }
      if (this.life[k] <= 0) {
        // Swap-remove.
        const last = --this.n;
        if (k !== last) {
          this.x[k] = this.x[last]; this.y[k] = this.y[last]; this.z[k] = this.z[last];
          this.vx[k] = this.vx[last]; this.vy[k] = this.vy[last]; this.vz[k] = this.vz[last];
          this.life[k] = this.life[last]; this.maxLife[k] = this.maxLife[last]; this.seed[k] = this.seed[last]; this.kind[k] = this.kind[last];
        }
        continue;
      }
      k++;
    }
  }

  /** Draw into the cell buffer with a depth test (particles behind nearer terrain are hidden). */
  draw(buf: CellBuffer, cam: Camera, t: number, nightGlow = 0): void {
    const x0 = Math.floor(cam.x), y0 = Math.floor(cam.y), hs = cam.heightScale;
    const cols = buf.cols, rows = buf.rows;
    for (let k = 0; k < this.n; k++) {
      const px = this.x[k], py = this.y[k];
      const c = Math.floor(px) - x0;
      const r = Math.floor(py) - y0 - Math.round(this.z[k] * hs);
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const o = r * cols + c;
      if (buf.depth[o] > py + 0.75) continue; // something nearer covers this cell
      const life = this.life[k] / this.maxLife[k], s = this.seed[k], kind = this.kind[k];
      let gl: number, fg: number;
      switch (kind) {
        case PK.Splash: gl = this.glyphs.splash[(s * 5) | 0]; fg = pack(200 + 55 * life, 240, 250); break;
        case PK.Mist: gl = this.glyphs.mist[(s * 3) | 0]; fg = pack(170 + 40 * life, 210, 220); break;
        case PK.Leaf: gl = this.glyphs.leaf[(((t * 3 + s * 10) | 0) % 4 + 4) % 4]; fg = s < 0.5 ? pack(220, 150, 60) : pack(190, 110, 50); break;
        case PK.Firefly: {
          const blink = 0.5 + 0.5 * Math.sin(t * (2 + s * 3) + s * 40);
          if (blink < 0.25) continue;
          gl = this.glyphs.firefly[blink > 0.92 ? 3 : blink > 0.7 ? 2 : (s * 2) | 0];
          const b = 0.4 + 0.6 * blink * (0.4 + 0.6 * nightGlow);
          fg = pack(255 * b, 236 * b, 120 * b);
          break;
        }
        case PK.Rain: {
          const slant = this.windX > 0.9 ? this.glyphs.rainR : this.windX < -0.9 ? this.glyphs.rainL : null;
          gl = slant ? slant[(s * 2) | 0] : this.glyphs.rain[(s * 3) | 0];
          fg = pack(165, 192, 215);
          // A faint tail one row up makes the drop read as a streak.
          if (r > 0 && buf.depth[o - cols] <= py + 0.75 && buf.kind[o - cols] !== 6) {
            buf.glyph[o - cols] = gl; buf.fg[o - cols] = mixFg(buf.bg[o - cols], fg, 0.45);
          }
          break;
        }
        case PK.FloatLeaf: gl = this.glyphs.floatLeaf[(s * 4) | 0]; fg = s < 0.33 ? pack(232, 160, 60) : s < 0.66 ? pack(206, 112, 52) : pack(196, 176, 70); break;
        case PK.Pollen: gl = this.glyphs.pollen[(s * 3) | 0]; fg = pack(240, 230, 170); break;
        default: gl = this.glyphs.spark[(s * 4) | 0]; fg = pack(170 + 80 * life, 255, 235); break;
      }
      buf.light[o] = kind === PK.Firefly ? 255 : kind === PK.Spark ? 200 : 0;
      buf.glyph[o] = gl;
      buf.fg[o] = fg;
      buf.kind[o] = 6;
    }
  }
}

function mixFg(bg: number, fg: number, t: number): number {
  const r = (bg & 255) + ((fg & 255) - (bg & 255)) * t;
  const g2 = ((bg >>> 8) & 255) + (((fg >>> 8) & 255) - ((bg >>> 8) & 255)) * t;
  const b = ((bg >>> 16) & 255) + (((fg >>> 16) & 255) - ((bg >>> 16) & 255)) * t;
  return ((0xff << 24) | (b << 16) | (g2 << 8) | r) >>> 0;
}
