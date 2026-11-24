import { CHUNK, type Alloc, heapAlloc } from '../world/World';
import { mulberry32 } from '../core/rng';

/**
 * Shallow-water simulation on the world grid: the "virtual pipes" model (O'Brien & Hodgins 1995; Mei et al. 2007).
 * Each cell holds a water depth and four outflow fluxes (left, right, up = y-1, down = y+1). Fluxes accelerate with
 * the surface-height difference to each neighbour and are scaled so a cell never sends more than it holds: depth
 * stays non-negative and every transfer is exactly conservative (what leaves one cell enters its neighbour).
 * Velocities come from the net flux. Outflow over a terrain drop larger than `fallDrop` is recorded as a waterfall.
 *
 * Ripples are a separate damped 2D wave equation on a displacement field (visual only, no mass): dry neighbours
 * reflect, waves interfere linearly and fade with `rippleDamping`.
 *
 * Only active chunks (16 x 16 cells holding water or sources, dilated by one chunk) are processed.
 */
export interface WaterParams {
  gravity: number;
  pipe: number;
  fluxDamping: number;
  edgeDrain: boolean;
  evaporation: number;
  filmDepth: number;
  fallDrop: number;
  rippleC2: number;
  rippleDamping: number;
  rippleMinDepth: number;
  fallRipple: number;
}

export const DEFAULT_WATER: WaterParams = {
  gravity: 9.81 * 2.2, // stylised: snappier flow at miniature scale
  pipe: 1,
  fluxDamping: 0.996,
  edgeDrain: true,
  evaporation: 0.004,
  filmDepth: 0.004,
  fallDrop: 1.1,
  rippleC2: 0.42,
  rippleDamping: 0.982,
  rippleMinDepth: 0.03,
  fallRipple: 0.05,
};

/** Names and element sizes of every shared array (so a worker and the renderer can wrap the same memory). */
export const WATER_ARRAYS = {
  depth: 4, fL: 4, fR: 4, fU: 4, fD: 4, velX: 4, velY: 4, rippleA: 4, rippleB: 4, fall: 4, fallTo: 4, source: 4, drain: 4,
} as const;
export type WaterBuffers = Record<keyof typeof WATER_ARRAYS | 'header', ArrayBuffer | SharedArrayBuffer>;

export function allocWaterBuffers(n: number, alloc: Alloc = heapAlloc): WaterBuffers {
  const out = {} as WaterBuffers;
  for (const [k, size] of Object.entries(WATER_ARRAYS)) out[k as keyof typeof WATER_ARRAYS] = alloc(n * size);
  out.header = alloc(16 * 4); // [0] ripple parity
  return out;
}

/** Typed-array views over the water buffers: what the renderer reads (works for both worker and main-thread modes). */
export class WaterView {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  readonly depth: Float32Array;
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  readonly rippleA: Float32Array;
  readonly rippleB: Float32Array;
  readonly fall: Float32Array;
  readonly fallTo: Int32Array;
  readonly source: Float32Array;
  readonly drain: Float32Array;
  readonly header: Int32Array;
  constructor(w: number, h: number, b: WaterBuffers) {
    this.w = w; this.h = h; this.n = w * h;
    this.depth = new Float32Array(b.depth);
    this.velX = new Float32Array(b.velX);
    this.velY = new Float32Array(b.velY);
    this.rippleA = new Float32Array(b.rippleA);
    this.rippleB = new Float32Array(b.rippleB);
    this.fall = new Float32Array(b.fall);
    this.fallTo = new Int32Array(b.fallTo);
    this.source = new Float32Array(b.source);
    this.drain = new Float32Array(b.drain);
    this.header = new Int32Array(b.header);
  }
  /** The current ripple field (the simulation alternates between two arrays). */
  get ripple(): Float32Array { return this.header[0] ? this.rippleB : this.rippleA; }
}

export class WaterSim extends WaterView {
  readonly elev: Float32Array;
  /** Object obstacles (1 = wall). Optional: an all-zero mask when not given. */
  readonly solid: Uint8Array;
  readonly fL: Float32Array;
  readonly fR: Float32Array;
  readonly fU: Float32Array;
  readonly fD: Float32Array;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunkWater: Float32Array;
  readonly chunkSources: Int32Array;
  readonly active: Uint8Array;
  readonly params: WaterParams;
  /** Totals for conservation accounting (m^3): added by sources/brushes, removed by drains/edges/evaporation. */
  added = 0;
  removed = 0;
  steps = 0;
  activeChunks = 0;
  private sourceList: number[] = [];
  private drainList: number[] = [];
  private rand = mulberry32(12345);

  constructor(w: number, h: number, elev: Float32Array, buffers: WaterBuffers = allocWaterBuffers(w * h), params: Partial<WaterParams> = {}, solid?: Uint8Array) {
    super(w, h, buffers);
    this.elev = elev;
    this.solid = solid ?? new Uint8Array(w * h);
    this.fL = new Float32Array(buffers.fL);
    this.fR = new Float32Array(buffers.fR);
    this.fU = new Float32Array(buffers.fU);
    this.fD = new Float32Array(buffers.fD);
    this.params = { ...DEFAULT_WATER, ...params };
    this.chunksX = Math.ceil(w / CHUNK);
    this.chunksY = Math.ceil(h / CHUNK);
    this.chunkWater = new Float32Array(this.chunksX * this.chunksY);
    this.chunkSources = new Int32Array(this.chunksX * this.chunksY);
    this.active = new Uint8Array(this.chunksX * this.chunksY);
    this.fallTo.fill(-1);
    this.rebuildLists();
    this.activateAll();
  }

  /** Total water volume (m^3; cells are 1 m^2). */
  totalWater(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.depth[i];
    return s;
  }

  activateAll(): void {
    this.chunkWater.fill(1);
  }

  private chunkOf(i: number): number {
    const x = i % this.w, y = (i / this.w) | 0;
    return ((y / CHUNK) | 0) * this.chunksX + ((x / CHUNK) | 0);
  }

  private rebuildLists(): void {
    this.sourceList = [];
    this.drainList = [];
    this.chunkSources.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (this.source[i] > 0) { this.sourceList.push(i); this.chunkSources[this.chunkOf(i)]++; }
      if (this.drain[i] > 0) this.drainList.push(i);
    }
  }

  // ------------------------------------------------------------------ edits (applied between steps)
  /** Add `amount` m^3 spread over a disc of radius r (negative amount removes water). */
  addWater(cx: number, cy: number, r: number, amount: number): void {
    const cells: number[] = [];
    this.disc(cx, cy, r, (i) => cells.push(i));
    if (!cells.length) return;
    const per = amount / cells.length;
    for (const i of cells) {
      const before = this.depth[i];
      const after = Math.max(0, before + per);
      this.depth[i] = after;
      if (after > before) this.added += after - before; else this.removed += before - after;
      this.chunkWater[this.chunkOf(i)] += 1;
    }
  }

  setSource(x: number, y: number, rate: number): void {
    if (!this.inBounds(x, y)) return;
    this.source[y * this.w + x] = Math.max(0, rate);
    this.rebuildLists();
  }

  setDrain(x: number, y: number, rate: number): void {
    if (!this.inBounds(x, y)) return;
    this.drain[y * this.w + x] = Math.max(0, rate);
    this.rebuildLists();
  }

  /** Ripple impulse: a smooth bump (radius r, peak `strength`) with zero initial velocity, so it spreads as a ring. */
  disturb(cx: number, cy: number, r: number, strength: number): void {
    const cur = this.ripple, prev = this.header[0] ? this.rippleA : this.rippleB;
    const R = Math.max(1, r);
    this.disc(cx, cy, R + 1, (i, d2) => {
      if (this.depth[i] < this.params.rippleMinDepth) return;
      const v = strength * Math.exp(-d2 / (R * R * 0.5));
      cur[i] += v;
      prev[i] += v;
      this.chunkWater[this.chunkOf(i)] += 1;
    });
  }

  /** Replace the whole water state (load / new world): new depths (or none), no sources or drains, ledger reset. */
  reset(depth: Float32Array | null): void {
    for (const a of [this.depth, this.fL, this.fR, this.fU, this.fD, this.velX, this.velY, this.rippleA, this.rippleB, this.fall, this.source, this.drain]) a.fill(0);
    this.fallTo.fill(-1);
    if (depth && depth.length === this.n) this.depth.set(depth);
    this.added = 0; this.removed = 0;
    this.rebuildLists();
    this.activateAll();
  }

  clearWater(): void {
    this.removed += this.totalWater();
    for (const a of [this.depth, this.fL, this.fR, this.fU, this.fD, this.velX, this.velY, this.rippleA, this.rippleB, this.fall]) a.fill(0);
    this.fallTo.fill(-1);
  }

  /** Terrain or obstacles changed in a rectangle: wake the chunks there; water inside new obstacles is displaced. */
  terrainChanged(x0: number, y0: number, x1: number, y1: number): void {
    for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) {
      const i = y * this.w + x;
      if (this.solid[i] && this.depth[i] > 0) { this.removed += this.depth[i]; this.depth[i] = 0; this.fL[i] = this.fR[i] = this.fU[i] = this.fD[i] = 0; }
    }
    for (let cy = Math.max(0, (y0 / CHUNK) | 0); cy <= Math.min(this.chunksY - 1, (y1 / CHUNK) | 0); cy++)
      for (let cx = Math.max(0, (x0 / CHUNK) | 0); cx <= Math.min(this.chunksX - 1, (x1 / CHUNK) | 0); cx++) this.chunkWater[cy * this.chunksX + cx] += 1;
  }

  private inBounds(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  private disc(cx: number, cy: number, r: number, fn: (i: number, d2: number) => void): void {
    const R = Math.ceil(r);
    for (let y = Math.max(0, Math.floor(cy) - R); y <= Math.min(this.h - 1, Math.floor(cy) + R); y++)
      for (let x = Math.max(0, Math.floor(cx) - R); x <= Math.min(this.w - 1, Math.floor(cx) + R); x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 <= r * r + 0.25) fn(y * this.w + x, d2);
      }
  }

  // ------------------------------------------------------------------ step
  step(dt: number): void {
    const { w, h, elev, depth, fL, fR, fU, fD, solid, params: p } = this;
    // Active chunks: water or sources last step, dilated by one chunk (water moves < 1 cell per step).
    const CX = this.chunksX, CY = this.chunksY, act = this.active;
    act.fill(0);
    let nAct = 0;
    for (let cy = 0; cy < CY; cy++) for (let cx = 0; cx < CX; cx++) {
      const c = cy * CX + cx;
      if (this.chunkWater[c] > 1e-7 || this.chunkSources[c] > 0) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const ax = cx + dx, ay = cy + dy;
          if (ax >= 0 && ay >= 0 && ax < CX && ay < CY) act[ay * CX + ax] = 1;
        }
      }
    }
    for (let c = 0; c < act.length; c++) nAct += act[c];
    this.activeChunks = nAct;

    // Sources and drains.
    for (const i of this.sourceList) { const a = this.source[i] * dt; depth[i] += a; this.added += a; }
    for (const i of this.drainList) { const a = Math.min(depth[i], this.drain[i] * dt); depth[i] -= a; this.removed += a; }

    const k = dt * p.pipe * p.gravity, damp = p.fluxDamping, edge = p.edgeDrain, fallDrop = p.fallDrop;
    const EDGE_DROP = 3;
    // 1) Fluxes.
    for (let c = 0; c < act.length; c++) {
      if (!act[c]) continue;
      const x0 = (c % CX) * CHUNK, y0 = ((c / CX) | 0) * CHUNK;
      const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          const d = depth[i];
          this.fall[i] = 0;
          if (d <= 1e-7 || solid[i]) { fL[i] = 0; fR[i] = 0; fU[i] = 0; fD[i] = 0; continue; }
          const b = elev[i], hi = b + d;
          let l = 0, r = 0, u = 0, dn = 0;
          if (x > 0) l = fL[i] * damp + k * (hi - elev[i - 1] - depth[i - 1]); else if (edge) l = fL[i] * damp + k * EDGE_DROP;
          if (x < w - 1) r = fR[i] * damp + k * (hi - elev[i + 1] - depth[i + 1]); else if (edge) r = fR[i] * damp + k * EDGE_DROP;
          if (y > 0) u = fU[i] * damp + k * (hi - elev[i - w] - depth[i - w]); else if (edge) u = fU[i] * damp + k * EDGE_DROP;
          if (y < h - 1) dn = fD[i] * damp + k * (hi - elev[i + w] - depth[i + w]); else if (edge) dn = fD[i] * damp + k * EDGE_DROP;
          if (l < 0 || (x > 0 && solid[i - 1])) l = 0;
          if (r < 0 || (x < w - 1 && solid[i + 1])) r = 0;
          if (u < 0 || (y > 0 && solid[i - w])) u = 0;
          if (dn < 0 || (y < h - 1 && solid[i + w])) dn = 0;
          const sum = l + r + u + dn;
          if (sum * dt > d) { const s = d / (sum * dt); l *= s; r *= s; u *= s; dn *= s; }
          fL[i] = l; fR[i] = r; fU[i] = u; fD[i] = dn;
          // Waterfalls: outflow over a terrain drop. Record the strongest and where it lands.
          let best = 0, to = -1;
          if (dn > best && y < h - 1 && b - elev[i + w] > fallDrop) { best = dn; to = i + w; }
          if (l > best && x > 0 && b - elev[i - 1] > fallDrop) { best = l; to = i - 1; }
          if (r > best && x < w - 1 && b - elev[i + 1] > fallDrop) { best = r; to = i + 1; }
          if (u > best && y > 0 && b - elev[i - w] > fallDrop) { best = u; to = i - w; }
          this.fall[i] = best;
          this.fallTo[i] = to;
        }
      }
    }
    // 2) Depths and velocities.
    this.chunkWater.fill(0);
    for (let c = 0; c < act.length; c++) {
      if (!act[c]) continue;
      const x0 = (c % CX) * CHUNK, y0 = ((c / CX) | 0) * CHUNK;
      const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
      let cw = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          const inL = x > 0 ? fR[i - 1] : 0, inR = x < w - 1 ? fL[i + 1] : 0;
          const inU = y > 0 ? fD[i - w] : 0, inD = y < h - 1 ? fU[i + w] : 0;
          const out = fL[i] + fR[i] + fU[i] + fD[i];
          if (edge) {
            let off = 0;
            if (x === 0) off += fL[i];
            if (x === w - 1) off += fR[i];
            if (y === 0) off += fU[i];
            if (y === h - 1) off += fD[i];
            this.removed += off * dt;
          }
          const d0 = depth[i];
          let d1 = d0 + dt * (inL + inR + inU + inD - out);
          if (d1 < 0) d1 = 0;
          if (d1 > 0 && d1 < p.filmDepth) { const e = Math.min(d1, p.evaporation * dt); d1 -= e; this.removed += e; }
          depth[i] = d1;
          const dAvg = Math.max(0.05, (d0 + d1) * 0.5);
          this.velX[i] = (inL - fL[i] + fR[i] - inR) * 0.5 / dAvg;
          this.velY[i] = (inU - fU[i] + fD[i] - inD) * 0.5 / dAvg;
          cw += d1;
        }
      }
      this.chunkWater[c] = cw;
    }
    // 3) Ripples (wave equation) on wet cells; waterfall impacts keep pools rippling.
    this.stepRipples(act);
    this.steps++;
  }

  private stepRipples(act: Uint8Array): void {
    const { w, h, params: p } = this;
    const depth = this.depth;
    const par = this.header[0];
    const cur = par ? this.rippleB : this.rippleA, nxt = par ? this.rippleA : this.rippleB;
    const c2 = p.rippleC2, damp = p.rippleDamping, minD = p.rippleMinDepth, CX = this.chunksX;
    // Waterfall impacts: small deterministic disturbances at landing cells.
    for (let c = 0; c < act.length; c++) {
      if (!act[c]) continue;
      const x0 = (c % CX) * CHUNK, y0 = ((c / CX) | 0) * CHUNK;
      for (let y = y0; y < Math.min(h, y0 + CHUNK); y++) for (let x = x0; x < Math.min(w, x0 + CHUNK); x++) {
        const i = y * w + x, f = this.fall[i], to = this.fallTo[i];
        if (f > 0.05 && to >= 0 && depth[to] >= minD && this.rand() < 0.35) cur[to] += (this.rand() - 0.3) * p.fallRipple * Math.min(3, f);
      }
    }
    for (let c = 0; c < act.length; c++) {
      if (!act[c]) continue;
      const x0 = (c % CX) * CHUNK, y0 = ((c / CX) | 0) * CHUNK;
      const x1 = Math.min(w, x0 + CHUNK), y1 = Math.min(h, y0 + CHUNK);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (depth[i] < minD) { nxt[i] = 0; continue; }
          const v = cur[i];
          // Dry or out-of-bounds neighbours reflect (mirror the centre value).
          const l = x > 0 && depth[i - 1] >= minD ? cur[i - 1] : v;
          const r = x < w - 1 && depth[i + 1] >= minD ? cur[i + 1] : v;
          const u = y > 0 && depth[i - w] >= minD ? cur[i - w] : v;
          const d = y < h - 1 && depth[i + w] >= minD ? cur[i + w] : v;
          nxt[i] = (2 * v - nxt[i] + c2 * (l + r + u + d - 4 * v)) * damp;
        }
      }
    }
    this.header[0] = par ? 0 : 1;
  }
}
