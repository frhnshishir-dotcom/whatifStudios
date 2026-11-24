import type { SceneLayer } from '../render/Composer';
import type { CellBuffer } from '../render/CellBuffer';
import type { Camera } from '../world/Camera';
import type { World } from '../world/World';
import type { TerrainShader } from '../render/TerrainShader';
import type { WaterView } from './WaterSim';
import { Particles, PK } from '../render/Particles';
import { Gradient, hex, pack, type RGB } from '../core/color';
import { hash2, mulberry32 } from '../core/rng';
import { g } from '../render/glyphs';

// Water look: turquoise shallows to deep blue-green (by depth), blended into the bank at the shore; ripple crests
// lighten and troughs darken the cell, with ring glyphs where a crest passes; moving water shows glyph stripes
// travelling along the local velocity (speed and foam follow the flow); calm water has a slow deterministic shimmer.
// Waterfalls: the cliff face under falling water becomes animated falling-water glyphs, density by flux.

export const RENDER_MIN_DEPTH = 0.025;
const RIPPLE_HEIGHT = 0.12;
const WATER = new Gradient([[0, '#3cbcb0'], [0.35, '#1f8f98'], [0.7, '#145f78'], [1, '#0b3a50']]);
const LIGHT: RGB = hex('#c9f3ee');
const FOAM: RGB = hex('#f4fffd');
const RING: RGB = hex('#e4fcff');
const FALL_BG: RGB = hex('#4f9fb0');
const DEEP: RGB = hex('#0d3d52');

const G = {
  tilde: g('~'), approx: g('≈'), triple: g('≋'), wave: g('∿'), dot: g('·'), spark: g('˚'), deg: g('°'),
  ring: g('○'), sring: g('◦'), shade: g('░'), mid: g('▒'),
  fall: [g('║'), g('┃'), g('│'), g('╎'), g('¦')],
};

export class WaterLayer implements SceneLayer {
  readonly world: World;
  readonly v: WaterView;
  readonly shader: TerrainShader;
  readonly particles: Particles;
  private c: RGB = [0, 0, 0];
  private lastT = -1;
  private rand = mulberry32(99);
  /** Global brightness multiplier (day/night, set by the lighting system). */
  light = 1;
  splashes = true;

  constructor(world: World, view: WaterView, shader: TerrainShader, particles: Particles) {
    this.world = world;
    this.v = view;
    this.shader = shader;
    this.particles = particles;
  }

  surfaceHeight(i: number): number {
    const d = this.v.depth[i];
    // Thin but fast water pouring over a drop is still drawn as water (the lip of a waterfall).
    if (d > RENDER_MIN_DEPTH || this.v.fall[i] > 0.02 || (d > 0.008 && Math.abs(this.v.velX[i]) + Math.abs(this.v.velY[i]) > 0.25)) {
      return this.world.elev[i] + d + this.v.ripple[i] * RIPPLE_HEIGHT;
    }
    return NaN;
  }

  prepare(cam: Camera, t: number): void {
    const dt = this.lastT < 0 ? 0 : Math.max(0, Math.min(0.1, t - this.lastT));
    this.lastT = t;
    if (dt <= 0 || !this.splashes) return;
    // Splash spawning from waterfalls in (and around) the view.
    const w = this.world, v = this.v, W = w.w, H = w.h;
    const x0 = Math.max(0, Math.floor(cam.x) - 2), x1 = Math.min(W - 1, Math.floor(cam.x) + cam.cols + 2);
    const y0 = Math.max(0, Math.floor(cam.y) - 4), y1 = Math.min(H - 1, Math.floor(cam.y) + cam.rows + 40);
    const P = this.particles;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x, f = v.fall[i];
        if (f < 0.06) continue;
        const to = v.fallTo[i];
        if (to < 0) continue;
        const n = f * dt * 3.2;
        let count = Math.floor(n) + (this.rand() < n - Math.floor(n) ? 1 : 0);
        const tx = to % W, ty = (to / W) | 0, gz = w.elev[to] + v.depth[to];
        while (count-- > 0) {
          const a = this.rand() * Math.PI * 2, sp = 0.6 + this.rand() * 1.4;
          P.spawn(PK.Splash, tx + 0.5 + Math.cos(a) * 0.4, ty + 0.5 + Math.sin(a) * 0.25, gz + 0.1, Math.cos(a) * sp, Math.sin(a) * sp * 0.5, 2.5 + this.rand() * 3 * Math.min(1, f / 2), 0.5 + this.rand() * 0.5, this.rand());
          if (this.rand() < 0.12) P.spawn(PK.Mist, tx + this.rand(), ty + this.rand() * 0.5, gz + 0.3, (this.rand() - 0.5) * 0.3, 0, 0.3, 1.5 + this.rand(), this.rand());
        }
      }
    }
    P.update(dt, t, (px, py) => {
      const ix = Math.min(W - 1, Math.max(0, px | 0)), iy = Math.min(H - 1, Math.max(0, py | 0));
      const i = iy * W + ix;
      return w.elev[i] + v.depth[i];
    });
  }

  drawSurface(i: number, x: number, y: number, o: number, buf: CellBuffer, t: number): void {
    const v = this.v, c = this.c;
    const d = v.depth[i], vx = v.velX[i], vy = v.velY[i], rip = v.ripple[i];
    const sp = Math.sqrt(vx * vx + vy * vy);
    WATER.sampleInto(c, d >= 1.4 ? 1 : Math.sqrt(d / 1.4));
    // Shore: shallow water shows the bed (blend with the terrain colour).
    if (d < 0.2) {
      const tb = this.shader.topBg[i], k = (1 - d / 0.2) * 0.55;
      c[0] += ((tb & 255) - c[0]) * k; c[1] += (((tb >>> 8) & 255) - c[1]) * k; c[2] += (((tb >>> 16) & 255) - c[2]) * k;
    }
    const sh = (1 + Math.max(-0.45, Math.min(0.6, rip * 1.6))) * this.light;
    const br = c[0] * sh, bgc = c[1] * sh, bb = c[2] * sh;
    let glyph = 0, fc: RGB = LIGHT, mixK = 0.55;
    const h1 = hash2(x, y, 3);
    const ar = rip < 0 ? -rip : rip;
    if (v.fall[i] > 0.05) {
      glyph = h1 < 0.5 ? G.triple : G.approx; fc = FOAM; mixK = 0.85;
    } else if (ar > 0.07) {
      glyph = rip > 0 ? (ar > 0.22 ? G.ring : G.sring) : G.dot; fc = RING; mixK = Math.min(0.95, 0.5 + ar * 2);
    } else if (sp > 0.06) {
      const ix = vx / sp, iy = vy / sp;
      const ph = (x * ix + y * iy) * 0.45 - t * (0.9 + Math.min(sp, 3) * 1.4) + h1 * 0.5;
      const f = ph - Math.floor(ph);
      if (f < 0.3) {
        glyph = sp > 1.5 ? G.triple : sp > 0.55 ? G.approx : G.tilde;
        mixK = 0.4 + Math.min(sp, 2) * 0.22;
        if (sp > 1.5) fc = FOAM;
      } else if (f < 0.36 && h1 > 0.55) glyph = G.dot;
    } else {
      const b = hash2(x, y, Math.floor(t * 0.7 + h1 * 7));
      if (b < 0.05) glyph = G.tilde;
      else if (b < 0.065) { glyph = G.spark; fc = FOAM; mixK = 0.8; }
      else if (d < 0.1 && h1 > 0.7) { glyph = G.shade; mixK = 0.25; }
    }
    buf.glyph[o] = glyph;
    buf.fg[o] = pack(br + (fc[0] * this.light - br) * mixK, bgc + (fc[1] * this.light - bgc) * mixK, bb + (fc[2] * this.light - bb) * mixK);
    buf.bg[o] = pack(br, bgc, bb);
    buf.kind[o] = 3;
  }

  drawFace(i: number, x: number, k: number, total: number, o: number, buf: CellBuffer, t: number): boolean {
    const v = this.v, W = this.world.w;
    const f = v.fall[i];
    const L = this.light;
    if (f > 0.02 && v.fallTo[i] === i + W) {
      const s = Math.min(1, f / 2.2);
      const ph = hash2(x, Math.floor(k - t * 11), 77);
      let gl: number;
      if (k >= total - 1 && total > 1) gl = ph < 0.5 ? G.triple : G.shade; // foam at the foot
      else if (s > 0.55) gl = ph < 0.45 ? G.fall[0] : ph < 0.8 ? G.fall[1] : G.fall[2];
      else if (s > 0.2) gl = ph < 0.6 ? G.fall[2] : G.fall[3];
      else gl = ph < 0.5 ? G.fall[3] : G.fall[4];
      const kk = 0.25 + s * 0.5;
      buf.glyph[o] = gl;
      buf.fg[o] = pack((200 + 55 * ph * s) * L, (235 + 20 * ph) * L, 245 * L);
      buf.bg[o] = pack((DEEP[0] + (FALL_BG[0] - DEEP[0]) * kk) * L, (DEEP[1] + (FALL_BG[1] - DEEP[1]) * kk) * L, (DEEP[2] + (FALL_BG[2] - DEEP[2]) * kk) * L);
      buf.kind[o] = 4;
      return true;
    }
    // A water edge above lower ground without a strong fall: a wet sheet over the bank.
    buf.glyph[o] = G.mid;
    buf.fg[o] = pack(40 * L, 120 * L, 135 * L);
    buf.bg[o] = pack(DEEP[0] * L, DEEP[1] * L, DEEP[2] * L);
    buf.kind[o] = 3;
    return true;
  }
}
