import type { Coordinates, MapPt } from './schema';

/**
 * The one place where coordinate systems meet. Gameplay code converts through these functions only.
 *
 *  map        0..1000 design units, x east, y south (the specification's coordinates)
 *  metres     map x metresPerMapUnit (proposed 10 m: a 10 km continent)
 *  world3D    Three.js style: x east (m), y up (m, elevation), z south (m)
 *  cell       terrain/simulation cell of terrainCellMetres (2 m, the valley's cell)
 *  chunk      chunkCells x chunkCells cells (16: the existing dirty/water/object chunk)
 *  region     regionCells x regionCells cells (256: one valley-sized simulation region, the streaming unit)
 *  prototype  a single prototypeGrid x prototypeGrid World covering the whole map (coarse first prototype)
 *  blueprint  design grid of blueprintSampleUnits per sample (elevation design and previews)
 */
export class WorldCoords {
  readonly c: Coordinates;
  readonly mapMax: number;
  readonly metresPerUnit: number;
  /** Size of the continent in terrain cells, chunks and regions (per side). */
  readonly cells: number;
  readonly chunks: number;
  readonly regions: number;

  constructor(c: Coordinates) {
    this.c = c;
    this.mapMax = c.map.max;
    this.metresPerUnit = c.metresPerMapUnit;
    this.cells = Math.ceil((this.mapMax * this.metresPerUnit) / c.terrainCellMetres);
    this.chunks = Math.ceil(this.cells / c.chunkCells);
    this.regions = Math.ceil(this.cells / c.regionCells);
  }

  mapToMetres(p: MapPt): MapPt { return [p[0] * this.metresPerUnit, p[1] * this.metresPerUnit]; }
  metresToMap(m: MapPt): MapPt { return [m[0] / this.metresPerUnit, m[1] / this.metresPerUnit]; }

  mapToWorld3D(p: MapPt, elevation: number): { x: number; y: number; z: number } {
    return { x: p[0] * this.metresPerUnit, y: elevation, z: p[1] * this.metresPerUnit };
  }
  world3DToMap(w: { x: number; z: number }): MapPt { return [w.x / this.metresPerUnit, w.z / this.metresPerUnit]; }

  /** Terrain cell containing a map point. */
  mapToCell(p: MapPt): MapPt {
    const k = this.metresPerUnit / this.c.terrainCellMetres;
    return [Math.min(this.cells - 1, Math.max(0, Math.floor(p[0] * k))), Math.min(this.cells - 1, Math.max(0, Math.floor(p[1] * k)))];
  }
  /** Map point at the centre of a terrain cell. */
  cellToMap(c: MapPt): MapPt {
    const k = this.c.terrainCellMetres / this.metresPerUnit;
    return [(c[0] + 0.5) * k, (c[1] + 0.5) * k];
  }
  cellToChunk(c: MapPt): MapPt { return [Math.floor(c[0] / this.c.chunkCells), Math.floor(c[1] / this.c.chunkCells)]; }
  /** Region holding a cell, and the cell's position inside it. */
  cellToRegion(c: MapPt): { region: MapPt; local: MapPt } {
    const R = this.c.regionCells;
    return { region: [Math.floor(c[0] / R), Math.floor(c[1] / R)], local: [c[0] % R, c[1] % R] };
  }
  regionId(r: MapPt): string { return `r${r[0]}-${r[1]}`; }
  mapToRegionId(p: MapPt): string { return this.regionId(this.cellToRegion(this.mapToCell(p)).region); }

  /** Cell of the single-World prototype (the whole map in one prototypeGrid x prototypeGrid grid). */
  mapToPrototype(p: MapPt, grid = this.c.prototypeGrid): MapPt {
    const k = grid / this.mapMax;
    return [Math.min(grid - 1, Math.max(0, Math.floor(p[0] * k))), Math.min(grid - 1, Math.max(0, Math.floor(p[1] * k)))];
  }
  prototypeToMap(c: MapPt, grid = this.c.prototypeGrid): MapPt { const k = this.mapMax / grid; return [(c[0] + 0.5) * k, (c[1] + 0.5) * k]; }
  /** Metres per prototype cell (the prototype is coarse: about 39 m at 10 m per unit). */
  prototypeCellMetres(grid = this.c.prototypeGrid): number { return (this.mapMax * this.metresPerUnit) / grid; }

  /** Blueprint design grid: samples per side and conversions. */
  get blueprintN(): number { return Math.round(this.mapMax / this.c.blueprintSampleUnits); }
  mapToBlueprint(p: MapPt): MapPt { const s = this.c.blueprintSampleUnits; return [p[0] / s, p[1] / s]; }
  blueprintToMap(i: number, j: number): MapPt { const s = this.c.blueprintSampleUnits; return [(i + 0.5) * s, (j + 0.5) * s]; }

  /** Horizontal distance between two map points, in metres. */
  metresBetween(a: MapPt, b: MapPt): number { return Math.hypot(a[0] - b[0], a[1] - b[1]) * this.metresPerUnit; }
}
