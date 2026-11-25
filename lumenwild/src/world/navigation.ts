import { type Blueprint, W_SEA, W_LAKE, W_RIVER, W_MARSH } from './blueprint';
import { findPath } from '../engine/continent/trails';
import type { MapPt } from './schema';

/**
 * Long-distance navigation on the blueprint grid (4 map units per node): roads are cheap, open ground costs by slope,
 * rivers are crossed at bridges (elsewhere they are expensive fords), lakes and the sea are impassable, dragon nests
 * are avoided. Walking detail at 1 m comes from the streamed regions along the way.
 */
export class Navigator {
  readonly bp: Blueprint;
  readonly G: number;
  readonly step: number;
  private cost: Float32Array;

  constructor(bp: Blueprint) {
    this.bp = bp;
    this.G = bp.N / 2;
    this.step = bp.unit * 2;
    this.cost = this.build();
  }

  private build(): Float32Array {
    const { bp, G } = this, N = bp.N, c = new Float32Array(G * G);
    const nests = bp.data.territories.filter((t) => t.kind === 'nest');
    const bridges = bp.roads.flatMap((r) => r.bridges.map((b) => b.at));
    for (let gj = 0; gj < G; gj++) for (let gi = 0; gi < G; gi++) {
      const k = (gj * 2 + 1) * N + gi * 2 + 1, w = bp.water[k], x = (gi + 0.5) * this.step, y = (gj + 0.5) * this.step;
      if (w === W_SEA || w === W_LAKE || bp.region[k] < 0) { c[gj * G + gi] = Infinity; continue; }
      const g = bp.slope[k];
      let v = 1 + 400 * g * g + (w === W_MARSH ? 2 : 0);
      if (w === W_RIVER) v += bridges.some((b) => Math.hypot(b[0] - x, b[1] - y) < 6) ? 0 : 80;
      for (const t of nests) if (Math.hypot(x - t.centre[0], y - t.centre[1]) < t.radius * 0.8) v += 300;
      c[gj * G + gi] = v;
    }
    // Roads: travel along them is cheap.
    for (const r of bp.roads) for (let k = 0; k < r.pts.length - 1; k++) {
      const [ax, ay] = r.pts[k], [bx, by] = r.pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
      for (let s = 0; s <= n; s++) {
        const gi = Math.floor((ax + ((bx - ax) * s) / n) / this.step), gj = Math.floor((ay + ((by - ay) * s) / n) / this.step);
        if (gi >= 0 && gj >= 0 && gi < G && gj < G && c[gj * G + gi] !== Infinity) c[gj * G + gi] = Math.min(c[gj * G + gi], 0.45);
      }
    }
    return c;
  }

  /** A route between two map points (map units), smoothed; null if unreachable. */
  route(from: MapPt, to: MapPt): MapPt[] | null {
    const p = findPath(this.cost, from, to, { G: this.G, step: this.step, minCost: 0.45 });
    if (!p) return null;
    // Light smoothing (keeps the ends).
    let pts = p.pts;
    for (let it = 0; it < 2; it++) {
      const b: MapPt[] = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) b.push([pts[i][0] * 0.75 + pts[i + 1][0] * 0.25, pts[i][1] * 0.75 + pts[i + 1][1] * 0.25], [pts[i][0] * 0.25 + pts[i + 1][0] * 0.75, pts[i][1] * 0.25 + pts[i + 1][1] * 0.75]);
      b.push(pts[pts.length - 1]);
      pts = b;
    }
    return pts;
  }

  /** Length of a route in metres. */
  lengthOf(route: MapPt[]): number {
    let L = 0;
    for (let k = 1; k < route.length; k++) L += Math.hypot(route[k][0] - route[k - 1][0], route[k][1] - route[k - 1][1]);
    return L * this.bp.coords.metresPerUnit;
  }
}

/** Moves along a route at a speed (m/s): position in map units, progress in metres. */
export class Traveller {
  readonly route: MapPt[];
  readonly length: number;
  speed: number;
  progress = 0;
  private cum: number[] = [0];

  constructor(route: MapPt[], speed: number, metresPerUnit: number) {
    this.route = route; this.speed = speed;
    for (let k = 1; k < route.length; k++) this.cum.push(this.cum[k - 1] + Math.hypot(route[k][0] - route[k - 1][0], route[k][1] - route[k - 1][1]) * metresPerUnit);
    this.length = this.cum[this.cum.length - 1];
  }

  get done(): boolean { return this.progress >= this.length; }

  advance(dt: number): MapPt { this.progress = Math.min(this.length, this.progress + this.speed * dt); return this.position(); }

  position(): MapPt {
    const d = this.progress;
    let k = 1;
    while (k < this.cum.length - 1 && this.cum[k] < d) k++;
    const a = this.route[k - 1], b = this.route[k], seg = this.cum[k] - this.cum[k - 1] || 1, t = Math.max(0, Math.min(1, (d - this.cum[k - 1]) / seg));
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
}
