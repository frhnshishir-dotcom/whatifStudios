// World data model (schema version 1). The JSON files in `lumenwild/world/` are the source of truth; this module
// gives them types and validates them (stable ids, references, coordinate ranges). Geography checks that need the
// elevation design (rivers flowing downhill, road grades, flight clearance) live in `blueprint.ts`.

export type MapPt = [number, number];

export interface WorldConfig { id: string; name: string; schemaVersion: number; seed: number; status: string; notes?: string }

export interface Coordinates {
  map: { min: number; max: number; x: string; y: string; north: string };
  metresPerMapUnit: number;
  metresPerMapUnitStatus?: string;
  elevationUnit: 'metre';
  terrainCellMetres: number;
  chunkCells: number;
  regionCells: number;
  renderTileMetres: number;
  creatureCellMetres: number;
  navCellMetres: number;
  blueprintSampleUnits: number;
  prototypeGrid: number;
}

export interface Region {
  id: string; name: string;
  /** [x0, y0, x1, y1] approximate bounds from the specification. */
  bounds: [number, number, number, number];
  /** Design elevation range (m). */
  elevation: [number, number];
  colour: string;
  /** Points whose neighbourhood belongs to this region (warped nearest-anchor membership, soft blended). */
  anchors: MapPt[];
  /** Regional base surface: a tilted plane, metres at `at`, metres per map unit along x and y. */
  base: { at: MapPt; elevation: number; gradient: [number, number] };
  terrain: string[]; biomes: string[]; wildlife: string[];
}

export interface Coastline { notes?: string; raggedness: number; points: MapPt[] }
export interface MountainRange { id: string; name: string; region: string; style: 'alpine' | 'volcanic' | 'jagged' | 'rounded'; halfWidth: number; crest: Array<[number, number, number]> }
export interface ElevationDesign {
  notes?: string;
  coastFalloff: number;
  detail: { amplitude: number; scale: number };
  basins: Array<{ id: string; at: MapPt; radius: number; floor: number }>;
  plateaus: Array<{ id: string; at: MapPt; radius: number; elevation: number; note?: string }>;
  fissures: Array<{ id: string; line: MapPt[]; depth: number; width: number }>;
}
export interface Lake { id: string; name: string; region: string; at: MapPt; radius: number; kind: string }
export interface River {
  id: string; name: string;
  /** Lake it drains, or the parent river it branches from (distributary). */
  source?: string; from?: string;
  /** Channel width in map units at the source and at the mouth. */
  width: [number, number];
  path: MapPt[];
  /** 'sea', 'split' (divides into distributaries), a river id or a lake id. */
  mouth: string;
  /** Authored waterfalls: the water surface steps down by `drop` metres at `at`. */
  falls?: Array<{ id: string; at: MapPt; drop: number; note?: string }>;
  added?: boolean; note?: string;
}
export type SettlementKind = 'city' | 'village' | 'outpost';
export interface Settlement {
  id: string; name: string; kind: SettlementKind; region: string; at: MapPt; footprintRadius: number;
  population: [number, number]; roles: string[]; status: 'spec' | 'proposed'; note?: string;
}
export type Discovery = 'known' | 'rumoured' | 'hidden';
export interface Landmark {
  id: string; name: string; region: string; at: MapPt; kind: string; discovery: Discovery;
  visibleFrom?: number; fantastical?: string; lake?: string; note?: string;
}
export interface Road { id: string; name: string; class: 'major' | 'minor' | 'trail'; via: Array<string | MapPt>; pass?: boolean; status?: string; note?: string }
export interface Habitat { id: string; region: string; at: MapPt; radius: number; species: string[]; density: 'low' | 'medium' | 'high' }
export interface Territory {
  id: string; name: string; kind: 'nest' | 'corridor'; centre: MapPt; radius: number; nest?: MapPt;
  dragon?: { id: string; name: string; species: string; size: 'medium' | 'large' | 'huge'; note?: string };
  /** Preferred height above ground while flying (m). */
  preferredAltitude: [number, number];
  awarenessRadius: number; huntingGrounds: string[]; note?: string;
}
export interface FlightRoutes { notes?: string; clearance: number; ceiling: number; settlementMinAGL: number; edges: Array<[string, string]> }
export interface DiscoveryConfig {
  fogCellUnits: number; playerRevealRadius: number; start: { at: MapPt; revealRadius: number };
  knownAtStart: string[]; rumourRadius: number; notes?: string;
}

export interface WorldData {
  world: WorldConfig; coordinates: Coordinates; regions: Region[];
  coastline: Coastline; ranges: MountainRange[]; elevation: ElevationDesign; lakes: Lake[]; rivers: River[];
  settlements: Settlement[]; landmarks: Landmark[]; roads: Road[]; habitats: Habitat[];
  territories: Territory[]; flight: FlightRoutes; discovery: DiscoveryConfig;
}

export interface Validation { errors: string[]; warnings: string[] }

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Structural validation: ids (unique, stable kebab-case), references, coordinate ranges and region bounds. */
export function validateWorld(d: WorldData): Validation {
  const errors: string[] = [], warnings: string[] = [];
  const max = d.coordinates.map.max;
  const seen = new Map<string, string>();
  const id = (kind: string, v: string) => {
    if (!ID.test(v)) errors.push(`${kind} id "${v}" is not kebab-case`);
    if (seen.has(v)) errors.push(`duplicate id "${v}" (${kind} and ${seen.get(v)})`);
    seen.set(v, kind);
  };
  const pt = (where: string, p: unknown) => {
    if (!Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n))) { errors.push(`${where}: not a point`); return; }
    if (p[0] < 0 || p[0] > max || p[1] < 0 || p[1] > max) errors.push(`${where}: (${p[0]}, ${p[1]}) is outside 0-${max}`);
  };
  if (d.world.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${d.world.schemaVersion}`);
  if (!(d.coordinates.metresPerMapUnit > 0) || !(d.coordinates.terrainCellMetres > 0)) errors.push('coordinates: scales must be positive');

  const regions = new Set(d.regions.map((r) => r.id));
  for (const r of d.regions) {
    id('region', r.id);
    if (r.elevation[0] >= r.elevation[1]) errors.push(`region ${r.id}: elevation range is empty`);
    if (!r.anchors.length) errors.push(`region ${r.id}: needs at least one anchor`);
    r.anchors.forEach((a, k) => pt(`region ${r.id} anchor ${k}`, a));
  }
  if (d.regions.length !== 6) warnings.push(`expected 6 regions, found ${d.regions.length}`);
  const inRegion = (kind: string, idv: string, region: string, at: MapPt) => {
    if (!regions.has(region)) { errors.push(`${kind} ${idv}: unknown region "${region}"`); return; }
    const b = d.regions.find((r) => r.id === region)!.bounds;
    if (at[0] < b[0] - 30 || at[0] > b[2] + 30 || at[1] < b[1] - 30 || at[1] > b[3] + 30) warnings.push(`${kind} ${idv} lies outside the approximate bounds of ${region}`);
  };
  d.coastline.points.forEach((p, k) => pt(`coastline point ${k}`, p));
  for (const m of d.ranges) {
    id('range', m.id);
    if (!regions.has(m.region)) errors.push(`range ${m.id}: unknown region`);
    if (m.crest.length < 2) errors.push(`range ${m.id}: a crest needs two or more points`);
    m.crest.forEach((c, k) => pt(`range ${m.id} crest ${k}`, c));
  }
  for (const f of [...d.elevation.basins, ...d.elevation.plateaus]) { id('elevation feature', f.id); pt(f.id, f.at); }
  for (const f of d.elevation.fissures) { id('elevation feature', f.id); f.line.forEach((p, k) => pt(`${f.id} ${k}`, p)); }
  const lakes = new Set(d.lakes.map((l) => l.id));
  for (const l of d.lakes) { id('lake', l.id); pt(`lake ${l.id}`, l.at); inRegion('lake', l.id, l.region, l.at); }
  const rivers = new Set(d.rivers.map((r) => r.id));
  for (const r of d.rivers) {
    id('river', r.id);
    r.path.forEach((p, k) => pt(`river ${r.id} point ${k}`, p));
    if (r.path.length < 2) errors.push(`river ${r.id}: path needs two or more points`);
    if (r.source && !lakes.has(r.source)) errors.push(`river ${r.id}: unknown source lake "${r.source}"`);
    if (r.from && !rivers.has(r.from)) errors.push(`river ${r.id}: unknown parent river "${r.from}"`);
    if (!['sea', 'split'].includes(r.mouth) && !rivers.has(r.mouth) && !lakes.has(r.mouth)) errors.push(`river ${r.id}: unknown mouth "${r.mouth}"`);
    if (r.mouth === 'split' && !d.rivers.some((q) => q.from === r.id)) errors.push(`river ${r.id}: splits but has no branches`);
    for (const f of r.falls ?? []) { id('waterfall', f.id); pt(`fall ${f.id}`, f.at); if (!(f.drop > 0)) errors.push(`fall ${f.id}: drop must be positive`); }
  }
  for (const s of d.settlements) { id('settlement', s.id); pt(`settlement ${s.id}`, s.at); inRegion('settlement', s.id, s.region, s.at); }
  for (const l of d.landmarks) {
    id('landmark', l.id); pt(`landmark ${l.id}`, l.at); inRegion('landmark', l.id, l.region, l.at);
    if (l.lake && !lakes.has(l.lake)) errors.push(`landmark ${l.id}: unknown lake`);
  }
  const places = new Set([...d.settlements.map((s) => s.id), ...d.landmarks.map((l) => l.id)]);
  for (const r of d.roads) {
    id('road', r.id);
    if (r.via.length < 2) errors.push(`road ${r.id}: needs two or more stops`);
    for (const v of r.via) {
      if (typeof v === 'string') { if (!places.has(v)) errors.push(`road ${r.id}: unknown stop "${v}"`); }
      else pt(`road ${r.id} waypoint`, v);
    }
  }
  const habitats = new Set(d.habitats.map((h) => h.id));
  for (const h of d.habitats) { id('habitat', h.id); pt(`habitat ${h.id}`, h.at); inRegion('habitat', h.id, h.region, h.at); }
  const terr = new Set(d.territories.map((t) => t.id));
  const creatureIds = new Set<string>();
  for (const t of d.territories) {
    id('territory', t.id); pt(`territory ${t.id}`, t.centre);
    if (t.kind === 'nest') {
      if (!t.nest) errors.push(`territory ${t.id}: a nest territory needs a nest`);
      else if (Math.hypot(t.nest[0] - t.centre[0], t.nest[1] - t.centre[1]) > t.radius) errors.push(`territory ${t.id}: nest outside the territory`);
      if (!t.dragon) errors.push(`territory ${t.id}: a nest territory needs a resident dragon`);
    }
    if (t.dragon) {
      if (!ID.test(t.dragon.id)) errors.push(`dragon id "${t.dragon.id}" is not kebab-case`);
      if (creatureIds.has(t.dragon.id)) errors.push(`duplicate creature id ${t.dragon.id}`);
      creatureIds.add(t.dragon.id);
    }
    for (const h of t.huntingGrounds) if (!habitats.has(h)) errors.push(`territory ${t.id}: unknown hunting ground "${h}"`);
    if (t.preferredAltitude[0] >= t.preferredAltitude[1]) errors.push(`territory ${t.id}: empty altitude range`);
  }
  for (const [a, b] of d.flight.edges) if (!terr.has(a) || !terr.has(b)) errors.push(`flight edge ${a}-${b}: unknown territory`);
  for (const k of d.discovery.knownAtStart) if (!places.has(k) && !d.roads.some((r) => r.id === k)) errors.push(`discovery: unknown known-at-start id "${k}"`);
  pt('discovery start', d.discovery.start.at);
  return { errors, warnings };
}
