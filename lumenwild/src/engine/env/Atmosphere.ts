import type { SceneLayer } from '../render/Composer';
import type { CellBuffer } from '../render/CellBuffer';
import type { Camera } from '../world/Camera';
import type { World } from '../world/World';
import type { ObjectStore } from '../objects/ObjectStore';
import { OBJECT_DEFS, type WorldObject } from '../objects/defs';
import { Particles, PK } from '../render/Particles';
import { Cover } from '../world/materials';
import { G } from '../render/glyphs';
import { mulberry32 } from '../core/rng';
import { valueNoise } from '../core/noise';
import type { Environment } from './Environment';

interface WaterRef {
  view: { depth: Float32Array; velX: Float32Array; velY: Float32Array };
  send(...cmds: Array<{ op: 'disturb'; x: number; y: number; r: number; strength: number }>): void;
}

/** Wind-bent variants of grass and flower glyphs (index -> index); built lazily from the registry. */
function swayMap(dir: number): Map<number, number> {
  const pairs: Array<[string, string]> = dir > 0
    ? [['|', '/'], ['¦', '/'], ['ψ', 'Ψ'], ['"', '\''], ['\'', '`'], ['ʬ', 'ψ'], [',', '’'], ['’', '`'], ['✿', '❀'], ['❀', '✿'], ['❁', '✾'], ['✾', '❁']]
    : [['|', '\\'], ['¦', '\\'], ['ψ', 'Ψ'], ['"', '`'], ['\'', '’'], ['ʬ', 'ψ'], [',', '`'], ['’', '\''], ['✿', '❀'], ['❀', '✿'], ['❁', '✾'], ['✾', '❁']];
  return new Map(pairs.map(([a, b]) => [G[a], G[b]]));
}
const SWAY_COVERS = new Set<number>([Cover.TallGrass, Cover.Reeds, Cover.Flowers, Cover.ShortGrass]);

/**
 * Weather, wind and light, drawn as the last scene pass (before the editor overlay):
 *  - particles: rain (rings on water, splashes on ground), leaves blown from trees (they float downstream when they
 *    land on water), fireflies at night, sparkles over glowing ground, pollen in a breeze;
 *  - wind: bands of tall grass, reeds and flowers bend as gusts travel across the land;
 *  - light: ambient colour for the time of day and weather, plus coloured point lights from windows, glowing
 *    mushrooms, rune stones, blossom and fireflies at night; emissive cells keep their glow;
 *  - fog: a drifting veil, thicker towards the back of the view and in low ground.
 */
export class Atmosphere implements SceneLayer {
  readonly env: Environment;
  readonly world: World;
  readonly particles: Particles;
  objects: ObjectStore;
  water: WaterRef | null = null;
  enabled = true;
  /** Particle density multiplier (low-performance mode lowers it). */
  density = 1;
  /** Depth attenuation: far (upper) rows fade slightly toward the sky haze. Off in low-performance mode. */
  aerial = true;
  private rowHaze = new Float32Array(0);
  private lastT = -1;
  private rand = mulberry32(4242);
  private swayR = swayMap(1);
  private swayL = swayMap(-1);
  private lr = new Float32Array(0);
  private lg = new Float32Array(0);
  private lb = new Float32Array(0);
  private list: WorldObject[] = [];
  private ripples: Array<{ op: 'disturb'; x: number; y: number; r: number; strength: number }> = [];
  private acc = { rain: 0, leaf: 0, fly: 0, spark: 0, pollen: 0 };
  /** Counters for tests and the perf readout. */
  readonly stats = { lights: 0, swayed: 0, fogged: 0 };

  constructor(env: Environment, world: World, objects: ObjectStore, particles: Particles) {
    this.env = env;
    this.world = world;
    this.objects = objects;
    this.particles = particles;
    particles.flowAt = (x, y, out) => {
      const v = this.water?.view;
      if (!v) return false;
      const ix = Math.min(world.w - 1, Math.max(0, x | 0)), iy = Math.min(world.h - 1, Math.max(0, y | 0)), i = iy * world.w + ix;
      out[0] = v.velX[i]; out[1] = v.velY[i]; out[2] = v.depth[i];
      return v.depth[i] > 0.05;
    };
    particles.onLand = (_k, x, y, wet) => {
      if (wet) {
        if (this.ripples.length < 24 && this.rand() < 0.5) this.ripples.push({ op: 'disturb', x: Math.floor(x), y: Math.floor(y), r: 0.8, strength: 0.18 + this.rand() * 0.12 });
        if (this.rand() < 0.25) particles.spawn(PK.Splash, x, y, this.ground(x, y) + 0.05, 0, 0, 1.2, 0.25, this.rand());
      } else if (this.rand() < 0.3) particles.spawn(PK.Splash, x, y, this.ground(x, y) + 0.05, (this.rand() - 0.5) * 0.4, 0, 1.6, 0.3, this.rand());
    };
  }

  private ground(x: number, y: number): number {
    const w = this.world, ix = Math.min(w.w - 1, Math.max(0, x | 0)), iy = Math.min(w.h - 1, Math.max(0, y | 0)), i = iy * w.w + ix;
    return w.elev[i] + (this.water ? this.water.view.depth[i] : 0);
  }

  prepare(cam: Camera, t: number): void {
    const dt = this.lastT < 0 ? 0 : Math.max(0, Math.min(0.1, t - this.lastT));
    this.lastT = t;
    const env = this.env, P = this.particles;
    env.update(dt, t);
    P.windX = env.windDir * env.gust * 2.4;
    P.windY = 0.15 * env.gust;
    if (dt > 0 && this.enabled) this.spawn(cam, dt);
    P.update(dt, t, (x, y) => this.ground(x, y));
    if (this.ripples.length && this.water) { this.water.send(...this.ripples); this.ripples.length = 0; }
  }

  private spawn(cam: Camera, dt: number): void {
    const env = this.env, P = this.particles, w = this.world, R = this.rand, D = this.density;
    const x0 = Math.max(0, Math.floor(cam.x)), x1 = Math.min(w.w - 1, Math.floor(cam.x) + cam.cols);
    // Terrain lifts far rows into view: spawn over the visible rows plus the lift.
    const y0 = Math.max(0, Math.floor(cam.y)), y1 = Math.min(w.h - 1, Math.floor(cam.y) + cam.rows + Math.round(cam.maxLift));
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    const pick = () => { const x = x0 + R() * (x1 - x0), y = y0 + R() * (y1 - y0); return [x, y]; };
    // Rain.
    this.acc.rain += env.rain * area * 0.12 * D * dt;
    while (this.acc.rain >= 1) {
      this.acc.rain--;
      const [x, y] = pick();
      const gz = this.ground(x, y);
      P.spawn(PK.Rain, x - P.windX * 0.5, y, gz + 4 + R() * 5, 0, 0, -13 - R() * 3, 2, R());
    }
    // Leaves from trees in view (more in wind).
    this.acc.leaf += (0.02 + env.gust * 0.9) * D * dt * 6;
    if (this.acc.leaf >= 1) {
      const trees = this.objects.inRect(x0, y0, x1, y1, this.list).filter((o) => o.kind === 'tree');
      while (this.acc.leaf >= 1) {
        this.acc.leaf--;
        if (!trees.length) break;
        const o = trees[Math.floor(R() * trees.length)];
        const z = w.elevAt(o.x, o.y) + 2 + (o.props.size ?? 2) * 0.9;
        P.spawn(PK.Leaf, o.x + 0.5 + (R() - 0.5) * 2, o.y + 0.5, z, 0, 0, 0, 7 + R() * 5, R());
      }
    }
    // Fireflies at night near plants, water and glowing ground; sparkles over glowing ground at any time.
    const want = Math.round(70 * env.night * (1 - env.rain * 0.8) * D);
    let flies = 0;
    for (let k = 0; k < P.n; k++) if (P.kind[k] === PK.Firefly) flies++;
    this.acc.fly += Math.max(0, want - flies) * dt * 0.6;
    while (this.acc.fly >= 1) {
      this.acc.fly--;
      for (let tries = 0; tries < 6; tries++) {
        const [x, y] = pick();
        const i = Math.floor(y) * w.w + Math.floor(x);
        const lush = w.cover[i] !== Cover.None || w.magic[i] > 0 || w.moisture[i] > 170;
        if (!lush) continue;
        P.spawn(PK.Firefly, x, y, this.ground(x, y) + 0.6 + R() * 1.4, 0, 0, 0, 8 + R() * 8, R());
        break;
      }
    }
    this.acc.spark += (0.4 + env.night * 2) * D * dt * 10;
    while (this.acc.spark >= 1) {
      this.acc.spark--;
      const [x, y] = pick();
      const i = Math.floor(y) * w.w + Math.floor(x);
      if (w.magic[i] < 60) continue;
      P.spawn(PK.Spark, x, y, this.ground(x, y) + 0.3 + R() * 1.5, 0, 0, 0.25, 1.5 + R() * 2, R());
    }
    // Pollen drifting over meadows by day in a breeze.
    this.acc.pollen += env.daylight * env.gust * (1 - env.rain) * D * dt * 12;
    while (this.acc.pollen >= 1) {
      this.acc.pollen--;
      const [x, y] = pick();
      const i = Math.floor(y) * w.w + Math.floor(x);
      if (w.cover[i] !== Cover.Flowers && w.cover[i] !== Cover.TallGrass) continue;
      P.spawn(PK.Pollen, x, y, this.ground(x, y) + 0.5 + R(), 0, 0, 0, 4 + R() * 4, R());
    }
  }

  after(buf: CellBuffer, cam: Camera, t: number): void {
    if (!this.enabled) return;
    this.sway(buf, t);
    this.light(buf, cam, t);
  }

  /** Travelling gust bands bend tall grass, reeds and flowers. */
  private sway(buf: CellBuffer, t: number): void {
    const env = this.env, w = this.world;
    let n = 0;
    if (env.gust > 0.12) {
      const map = env.windDir > 0 ? this.swayR : this.swayL;
      const speed = (1.1 + env.gust * 2.6) * env.windDir, thr = 1 - Math.min(0.85, env.gust * 0.75);
      for (let k = 0; k < buf.n; k++) {
        if (buf.kind[k] !== 1) continue;
        const p = buf.pick[k];
        if (p < 0 || !SWAY_COVERS.has(w.cover[p])) continue;
        const x = p % w.w, y = (p / w.w) | 0;
        if (Math.sin(x * 0.23 + y * 0.09 - t * speed + valueNoise(x * 0.05, y * 0.05, 3) * 3) < thr) continue;
        const alt = map.get(buf.glyph[k]);
        if (alt !== undefined) { buf.glyph[k] = alt; n++; }
      }
    }
    this.stats.swayed = n;
  }

  /** Ambient light, point lights at night and fog. */
  private light(buf: CellBuffer, cam: Camera, t: number): void {
    const env = this.env, w = this.world, n = buf.n;
    const [ar, ag, ab] = env.ambient;
    const night = env.night, fog = env.fog;
    const neutral = Math.abs(ar - 1) < 0.01 && Math.abs(ag - 1) < 0.01 && Math.abs(ab - 1) < 0.01;
    this.stats.lights = 0;
    this.stats.fogged = 0;
    const lit = !(neutral && night < 0.02);
    if (!lit && fog < 0.01 && !this.aerial) return;
    this.cols = buf.cols;
    if (this.lr.length !== n) { this.lr = new Float32Array(n); this.lg = new Float32Array(n); this.lb = new Float32Array(n); }
    const lr = this.lr, lg = this.lg, lb = this.lb;
    if (lit) { lr.fill(ar); lg.fill(ag); lb.fill(ab); }
    const cols = buf.cols, rows = buf.rows;
    // Depth haze per row: strongest at the top (farthest) of the view, none in the lower part.
    if (this.rowHaze.length !== rows) this.rowHaze = new Float32Array(rows);
    const hz = this.aerial ? 0.16 * (0.55 + 0.45 * env.daylight) * (1 - fog * 0.6) : 0;
    for (let r = 0; r < rows; r++) { const u = Math.max(0, 1 - r / (rows * 0.8)); this.rowHaze[r] = hz * u * u; }
    const [hr, hg, hb] = env.haze;
    if (lit && night > 0.05) {
      // Point lights from objects in (and just around) the view.
      const x0 = Math.floor(cam.x), y0 = Math.floor(cam.y), hs = cam.heightScale;
      const list = this.objects.inRect(x0 - 8, y0 - 8, x0 + cols + 8, y0 + rows + Math.round(cam.maxLift) + 8, this.list);
      for (const o of list) {
        const L = OBJECT_DEFS[o.kind].light?.(o);
        if (!L) continue;
        const z = w.elevAt(o.x, o.y);
        const cc = o.x + 0.5 - x0 + (o.kind === 'cottage' ? 2 : o.kind === 'mill' ? 1.5 : 0);
        const cr = o.y + (o.kind === 'cottage' || o.kind === 'mill' ? 2 : 0) - y0 - Math.round(z * hs) - L.up;
        const flick = o.kind === 'cottage' || o.kind === 'mill' ? 0.92 + 0.08 * Math.sin(t * 7 + o.id) * Math.sin(t * 3.1) : 0.85 + 0.15 * Math.sin(t * 1.7 + o.id);
        this.addLight(cc, cr, L.r, (L.color[0] / 255) * L.intensity * night * flick, (L.color[1] / 255) * L.intensity * night * flick, (L.color[2] / 255) * L.intensity * night * flick);
        this.stats.lights++;
      }
      // Fireflies light a small halo.
      const P = this.particles;
      for (let k = 0; k < P.n; k++) {
        if (P.kind[k] !== PK.Firefly) continue;
        const c = Math.floor(P.x[k]) - x0, r = Math.floor(P.y[k]) - y0 - Math.round(P.z[k] * hs);
        if (c < -2 || r < -2 || c > cols + 2 || r > rows + 2) continue;
        this.addLight(c + 0.5, r + 0.5, 2.6, 0.2 * night, 0.19 * night, 0.07 * night);
      }
      // Glowing ground lights itself.
      for (let k = 0; k < n; k++) {
        const p = buf.pick[k];
        if (p < 0 || buf.kind[k] !== 1) continue;
        const m = w.magic[p];
        if (m) { const a = (m / 255) * night * 0.55; lr[k] += a * 0.35; lg[k] += a * 1.0; lb[k] += a * 0.85; }
      }
    }
    const fogA = fog > 0.01;
    const [fr, fgc, fb] = env.fogColor;
    const fg = buf.fg, bg = buf.bg, emit = buf.light;
    let fogged = 0;
    for (let k = 0; k < n; k++) {
      let r = lr[k], g = lg[k], b = lb[k];
      const e = emit[k] / 255;
      // Background (surfaces) takes the light; emissive glyphs keep at least their own brightness.
      let B = bg[k], F = fg[k];
      if (lit) {
        B = mul(B, r, g, b);
        if (e > 0) { r = Math.max(r, e * 1.05); g = Math.max(g, e * 1.05); b = Math.max(b, e); }
        F = mul(F, r, g, b);
      }
      if (hz > 0 && buf.pick[k] >= 0) {
        const a = this.rowHaze[(k / cols) | 0] * (e > 0 ? 0.4 : 1);
        if (a > 0.004) { B = mixTo(B, hr, hg, hb, a); F = mixTo(F, hr, hg, hb, a * 0.85); }
      }
      if (fogA) {
        const row = (k / cols) | 0;
        const p = buf.pick[k];
        const col = k - row * cols;
        // Thicker towards the back (top of the view) and in low ground; slow drifting noise.
        const back = 1 - row / rows;
        const low = p >= 0 ? Math.max(0, 1 - (w.elev[p] - 4) / 22) : 0.5;
        const drift = valueNoise(col * 0.06 + t * 0.05, row * 0.12 + t * 0.013, 77);
        const a = Math.min(0.88, fog * (0.25 + 0.45 * back + 0.25 * low) * (0.65 + 0.7 * drift) * (e > 0 ? 0.5 : 1));
        if (a > 0.02) { B = mixTo(B, fr, fgc, fb, a); F = mixTo(F, fr, fgc, fb, a * 1.1 > 1 ? 1 : a * 1.1); fogged++; }
      }
      bg[k] = B; fg[k] = F;
    }
    this.stats.fogged = fogged;
  }

  private addLight(cx: number, cy: number, radius: number, r: number, g: number, b: number): void {
    const cols = this.lastCols(), rows = this.lr.length / cols;
    const R = Math.ceil(radius);
    for (let y = Math.floor(cy) - R; y <= Math.floor(cy) + R; y++) {
      if (y < 0 || y >= rows) continue;
      for (let x = Math.floor(cx) - R; x <= Math.floor(cx) + R; x++) {
        if (x < 0 || x >= cols) continue;
        const d = Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) * 1.25) / radius;
        if (d >= 1) continue;
        const f = (1 - d * d) * (1 - d * d); // soft pool: bright core, gentle edge
        const k = y * cols + x;
        this.lr[k] += r * f; this.lg[k] += g * f; this.lb[k] += b * f;
      }
    }
  }

  private cols = 1;
  private lastCols(): number { return this.cols; }
}

function mul(c: number, r: number, g: number, b: number): number {
  const R = Math.min(255, (c & 255) * r), Gc = Math.min(255, ((c >>> 8) & 255) * g), B = Math.min(255, ((c >>> 16) & 255) * b);
  return ((0xff << 24) | (B << 16) | (Gc << 8) | R) >>> 0;
}

function mixTo(c: number, r: number, g: number, b: number, a: number): number {
  const R = (c & 255) + (r - (c & 255)) * a, Gc = ((c >>> 8) & 255) + (g - ((c >>> 8) & 255)) * a, B = ((c >>> 16) & 255) + (b - ((c >>> 16) & 255)) * a;
  return ((0xff << 24) | (B << 16) | (Gc << 8) | R) >>> 0;
}
