import { Mat } from './materials';

export const CHUNK = 16;

type Grid = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int32Array;

/**
 * Move a w x h grid's contents in place so that new[x, y] = old[x + sx, y + sy] (streaming: the window moved by
 * (sx, sy) cells). Cells uncovered at the far edge keep stale values; the caller overwrites them.
 */
export function shiftGrid(a: Grid, w: number, h: number, sx: number, sy: number): void {
  if (!sx && !sy) return;
  const x0 = Math.max(0, -sx), x1 = Math.min(w, w - sx);
  if (x1 <= x0 || Math.abs(sy) >= h) return;
  const row = (y: number) => a.copyWithin(y * w + x0, (y + sy) * w + x0 + sx, (y + sy) * w + x1 + sx);
  if (sy > 0) for (let y = 0; y < h - sy; y++) row(y);
  else if (sy < 0) for (let y = h - 1; y >= -sy; y--) row(y);
  else for (let y = 0; y < h; y++) row(y);
}

/** Buffer factory: ordinary ArrayBuffer, or SharedArrayBuffer when the page is cross-origin isolated. */
export type Alloc = (bytes: number) => ArrayBuffer | SharedArrayBuffer;
export const heapAlloc: Alloc = (bytes) => new ArrayBuffer(bytes);
export const sharedAlloc: Alloc = (bytes) => new SharedArrayBuffer(bytes);
export const canShare = (): boolean => typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

/**
 * The world grid: one cell = 1 m x 1 m. Terrain and decoration layers are typed arrays (row-major, i = y * w + x).
 * Water, objects and simulation state live in their own modules and reference the same dimensions.
 * Chunks (16 x 16) carry dirty flags so cached terrain shading and active water regions update locally.
 */
export class World {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  name = 'Untitled world';
  seed = 1;
  /** Terrain height in metres (bedrock + soil). */
  readonly elev: Float32Array;
  readonly mat: Uint8Array;
  /** Vegetation / ground cover and a per-cell variant (flower colour, grass species...). */
  readonly cover: Uint8Array;
  readonly coverVar: Uint8Array;
  /** Moisture 0..255 (generation + water proximity), drives grass colour and moss. */
  readonly moisture: Uint8Array;
  /** Magic 0..255 (glowing areas). */
  readonly magic: Uint8Array;
  /**
   * Optional ground-colour blend per cell (continent mode only; null in the Valley): own material << 16 | material
   * whose colour the cell leans toward << 8 | amount (0..255). Applied only while the cell keeps its own material.
   */
  blend: Uint32Array | null = null;
  /** 1 = blocked by an object (rocks, buildings): water flows around it. Shared with the water worker. */
  readonly solid: Uint8Array;
  readonly chunksX: number;
  readonly chunksY: number;
  /** 1 = terrain cache must be rebuilt for this chunk. */
  readonly terrainDirty: Uint8Array;
  /** Incremented on any terrain change (renderers and serializers can detect edits). */
  terrainVersion = 0;

  /** alloc: buffer factory; pass one that returns SharedArrayBuffer so a simulation worker can read the terrain. */
  constructor(w = 256, h = 256, alloc: Alloc = heapAlloc) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.elev = new Float32Array(alloc(this.n * 4));
    this.mat = new Uint8Array(this.n).fill(Mat.Grass);
    this.cover = new Uint8Array(this.n);
    this.coverVar = new Uint8Array(this.n);
    this.moisture = new Uint8Array(this.n);
    this.magic = new Uint8Array(this.n);
    this.solid = new Uint8Array(alloc(this.n));
    this.chunksX = Math.ceil(w / CHUNK);
    this.chunksY = Math.ceil(h / CHUNK);
    this.terrainDirty = new Uint8Array(this.chunksX * this.chunksY).fill(1);
  }

  idx(x: number, y: number): number { return y * this.w + x; }
  inBounds(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  /** Elevation with edge clamping (safe for neighbourhood reads). */
  elevAt(x: number, y: number): number {
    const cx = x < 0 ? 0 : x >= this.w ? this.w - 1 : x;
    const cy = y < 0 ? 0 : y >= this.h ? this.h - 1 : y;
    return this.elev[cy * this.w + cx];
  }

  /** Mark the chunks touching a rectangle (inclusive, with a 1-cell margin for neighbour-dependent shading). */
  markTerrainDirty(x0: number, y0: number, x1: number, y1: number): void {
    const cx0 = Math.max(0, Math.floor((x0 - 1) / CHUNK)), cy0 = Math.max(0, Math.floor((y0 - 1) / CHUNK));
    const cx1 = Math.min(this.chunksX - 1, Math.floor((x1 + 1) / CHUNK)), cy1 = Math.min(this.chunksY - 1, Math.floor((y1 + 1) / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.terrainDirty[cy * this.chunksX + cx] = 1;
    this.terrainVersion++;
  }

  markAllDirty(): void {
    this.terrainDirty.fill(1);
    this.terrainVersion++;
  }
}
