import { fbm } from '../engine/core/noise';
import { smoothstep } from '../engine/core/math';
import { Mat } from '../engine/world/materials';

/**
 * Biome transitions (ecotones) on the continent: natural, irregular patches instead of per-cell random picks.
 *
 * Every function here is a pure function of continent position and local conditions, so regions generated apart
 * agree exactly and the same coordinates always give the same terrain. Nothing here runs per frame: it is used once
 * per cell when a region is generated.
 *
 *  shares   each region's weight from the blueprint, sharpened, then tilted by ecology (elevation, slope, wetness):
 *           forest spreads along damp ground, marsh into wet hollows, plains onto dry flats, peaks up steep slopes.
 *           Where one region's weight is near 1 (its core), ecology cannot bring another region in.
 *  patches  a cell takes the region whose cumulative share first exceeds a smooth, domain-warped noise value, so
 *           neighbouring cells usually agree and borders between patches are irregular contours, tens of metres
 *           across; the patches of a region thin out gradually as its share falls.
 *  clumps   ground cover within a biome comes in clumps (a few metres) rather than single random cells.
 */

/** Maps an fbm value to a uniform 0..1 rank (an empirical distribution, built once, deterministic). */
export class Uniformizer {
  private table = new Float32Array(1025);
  constructor(octaves: number, salt: number, scale = 7.3) {
    const N = 40_000, hist = new Float64Array(1024);
    for (let k = 0; k < N; k++) {
      // A fixed lattice of sample points, far apart relative to the noise scale.
      const v = fbm(((k % 200) * 13.37) / scale, (Math.floor(k / 200) * 11.71) / scale, octaves, salt);
      hist[Math.max(0, Math.min(1023, Math.floor(v * 1024)))]++;
    }
    let c = 0;
    for (let b = 0; b < 1024; b++) { this.table[b] = c / N; c += hist[b]; }
    this.table[1024] = 1;
  }
  /** Rank of v among fbm values: 0..1, about uniform. */
  at(v: number): number {
    const f = Math.max(0, Math.min(1, v)) * 1024, b = Math.min(1023, Math.floor(f));
    return this.table[b] + (this.table[b + 1] - this.table[b]) * (f - b);
  }
}

/**
 * How well a region's vegetation suits a spot (log-weight; 0 = neutral). Inputs: elevation (m), slope (rise per
 * metre), wetness (0 dry .. 1 water's edge).
 */
export function ecologyAffinity(id: string, e: number, sl: number, wet: number): number {
  switch (id) {
    case 'elderwood': return 1.4 * wet + 0.5 * smoothstep(0.04, 0.2, sl) * (1 - smoothstep(0.45, 0.8, sl)) - 1.5 * smoothstep(850, 1050, e) - 0.4;
    case 'heartlands': return 0.6 * (1 - Math.abs(wet - 0.35) * 2) - 1.4 * smoothstep(0.25, 0.55, sl);
    case 'golden-plains': return 1.1 * (1 - wet) - 1.0 * wet - 1.2 * smoothstep(0.15, 0.4, sl) - 0.3;
    case 'whispering-marshes': return 2.4 * wet - 3.0 * smoothstep(0.06, 0.18, sl) - 1.5 * smoothstep(60, 220, e) - 0.6;
    case 'hollow-lands': return 1.2 * smoothstep(0.15, 0.6, sl) + 0.8 * (1 - wet) - 0.6;
    case 'dragon-peaks': return 1.6 * smoothstep(450, 900, e) + 1.2 * smoothstep(0.2, 0.6, sl) - 0.8;
    default: return 0;
  }
}

/** Blueprint weight below which a region takes no part at a spot (a region a few km away does not send islands). */
export const SHARE_FLOOR = 0.08;

/**
 * Shares (sum 1) of each region at a spot: blueprint weights below SHARE_FLOOR are dropped (fading in just above
 * it, so nothing switches on at a line), the rest raised to the third power (as before, so cores and border widths
 * keep their size), then tilted by ecology.
 */
export function biomeShares(ids: readonly string[], w: ArrayLike<number>, e: number, sl: number, wet: number, out: Float64Array): void {
  let sum = 0;
  for (let r = 0; r < ids.length; r++) {
    const v = w[r] > SHARE_FLOOR ? w[r] * w[r] * w[r] * smoothstep(SHARE_FLOOR, SHARE_FLOOR * 2, w[r]) * Math.exp(ecologyAffinity(ids[r], e, sl, wet)) : 0;
    out[r] = v; sum += v;
  }
  if (sum > 0) for (let r = 0; r < ids.length; r++) out[r] /= sum;
}

/** The region whose cumulative share first reaches u (0..1); the strongest one when shares are all zero. */
export function pickBiome(shares: ArrayLike<number>, u: number): number {
  let c = 0, best = 0;
  for (let r = 0; r < shares.length; r++) {
    if (shares[r] > shares[best]) best = r;
    c += shares[r];
    if (shares[r] > 0 && u <= c) return r;
  }
  return best;
}

/**
 * Like pickBiome, and also how close u is to the nearest threshold between two patches (0 at a patch edge), so the
 * ground colour can be feathered across the edge.
 */
export function pickBiomeEdge(shares: ArrayLike<number>, u: number): [number, number] {
  let c = 0;
  for (let r = 0; r < shares.length; r++) {
    if (!(shares[r] > 0)) continue;
    const lo = c;
    c += shares[r];
    if (u <= c) return [r, Math.min(lo > 0 ? u - lo : Infinity, c < 0.999999 ? c - u : Infinity)];
  }
  return [pickBiome(shares, u), Infinity];
}

/** Materials that keep a crisp look of their own (no blending toward a neighbouring biome's ground). */
export const UNBLENDED = new Set<number>([Mat.Stone, Mat.Cliff, Mat.Snow, Mat.Scree, Mat.Path, Mat.Sand]);

/**
 * Pack a ground-colour blend: the cell's own material (the blend applies only while it is unchanged), the material
 * whose colour it leans toward, and how far (0..255).
 */
export const packBlend = (own: number, toward: number, amount: number): number => ((own & 255) << 16) | ((toward & 255) << 8) | Math.max(0, Math.min(255, Math.round(amount * 255)));
