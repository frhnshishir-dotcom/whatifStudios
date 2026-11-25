import { Rng } from '../engine/core/rng';
import { CULTURES, SPECS, type Culture } from '../engine/continent/cultures';
import type { BuildingType, CultureId } from '../engine/continent/types';
import type { Settlement } from './schema';

/**
 * Villages on the 1 m continent. Each settlement in the world files gets a plan: a square with its communal feature,
 * lanes that leave along the roads (and a few more), buildings from its culture's programme (the draft village
 * engine's cultures: building types, sizes, lanes, farmland), and fields, pasture or gardens around it.
 *
 * A plan is a pure function of the world files and the ground (smooth heights and water from the continent terrain),
 * computed once per village and drawn into every region it touches, so neighbouring regions agree. Buildings sit on
 * levelled pads that never cross a region edge (each pad is levelled from its own region's ground).
 */

export interface SiteQuery {
  /** Smooth ground height (m). */
  z(x: number, y: number): number;
  /** Within `margin` m of water (river, lake, sea). */
  wet(x: number, y: number, margin: number): boolean;
}

export interface PlannedBuilding {
  type: BuildingType;
  /** Top-left cell (continent metres) and size. */
  x: number; y: number; w: number; d: number;
  floors: number;
  /** Levelled ground under it (stilt houses, tree houses and decks keep the ground). */
  pad: boolean;
  /** Water mill: which side the wheel turns on (toward the water). */
  wheelSide?: number;
}

export interface FieldPlot { x0: number; y0: number; x1: number; y1: number; dir: 0 | 1; kind: Culture['farm']['kind'] }

export interface VillagePlan {
  id: string; name: string; culture: CultureId;
  cx: number; cy: number; radius: number;
  square: { x: number; y: number; r: number };
  lanes: Array<Array<[number, number]>>;
  laneWidth: number;
  buildings: PlannedBuilding[];
  fields: FieldPlot[];
  /** Bounds (continent metres) of everything the plan draws. */
  bbox: [number, number, number, number];
  /** Counted buildings (wells, stalls, decks and fire pits are not). */
  counted: number;
}

/** Culture of each village: `culture` in the world files, or by region when a settlement does not say. */
const CULTURE_BY_REGION: Record<string, CultureId> = {
  heartlands: 'heartlands-timber', 'dragon-peaks': 'frost-lodge', 'golden-plains': 'plains-farmstead',
  'whispering-marshes': 'marsh-stilt', elderwood: 'elder-grove', 'hollow-lands': 'frost-lodge',
};
export const cultureOf = (s: Settlement): CultureId => s.culture ?? CULTURE_BY_REGION[s.region] ?? 'heartlands-timber';

/** Draft-engine distances (cells) to metres. */
const K = 2;
/** Types drawn without a levelled pad. */
const NO_PAD = new Set<BuildingType>(['stilt-house', 'fishing-hut', 'net-shed', 'lantern-deck', 'tree-house', 'well', 'market-stall', 'fire-pit', 'moonwell']);

export function planVillage(s: Settlement, q: SiteQuery, roads: Array<Array<[number, number]>>, mpu: number, regionCells: number): VillagePlan {
  const cul = CULTURES[cultureOf(s)], rng = new Rng('village', s.id);
  const radius = s.footprintRadius * mpu;
  // Local occupancy grid around the village (1 m): 1 lane/road/square, 2 building or its gap, 3 field.
  const G = Math.ceil(radius) * 2 + 20, gx0 = Math.round(s.at[0] * mpu) - (G >> 1), gy0 = Math.round(s.at[1] * mpu) - (G >> 1);
  const occ = new Uint8Array(G * G);
  const inG = (x: number, y: number) => x >= gx0 && y >= gy0 && x < gx0 + G && y < gy0 + G;
  const mark = (x: number, y: number, v: number) => { if (inG(x, y)) { const k = (y - gy0) * G + x - gx0; if (!occ[k] || v === 2) occ[k] = Math.max(occ[k], v); } };
  const slopeAt = (x: number, y: number) => Math.hypot(q.z(x + 4, y) - q.z(x - 4, y), q.z(x, y + 4) - q.z(x, y - 4)) / 8;

  // Centre: the settlement point, or the nearest dry, gentle spot within 60 m.
  let cx = s.at[0] * mpu, cy = s.at[1] * mpu;
  search: for (let r = 0; r <= 60; r += 4) for (let a = 0; a < 16; a++) {
    const x = cx + Math.cos((a / 16) * Math.PI * 2) * r, y = cy + Math.sin((a / 16) * Math.PI * 2) * r;
    if (!q.wet(x, y, 14) && slopeAt(x, y) < 0.15) { cx = Math.round(x); cy = Math.round(y); break search; }
    if (r === 0) break;
  }
  cx = Math.round(cx); cy = Math.round(cy);
  const core = Math.min(cul.coreR * K, radius - 12);
  const square = { x: cx, y: cy, r: cul.id === 'heartlands-timber' || cul.id === 'plains-farmstead' ? 9 : 7 };
  for (let y = -square.r; y <= square.r; y++) for (let x = -square.r; x <= square.r; x++) if (x * x + y * y <= square.r * square.r) mark(cx + x, cy + y, 1);

  // Roads through the village count as lanes (nothing is built on them).
  const laneW = cul.id === 'frost-lodge' || cul.id === 'elder-grove' ? 2 : 3;
  const stamp = (x: number, y: number, hw: number) => { for (let dy = -hw; dy <= hw; dy++) for (let dx = -hw; dx <= hw; dx++) mark(Math.round(x) + dx, Math.round(y) + dy, 1); };
  const exits: number[] = [];
  for (const pts of roads) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1], L = Math.hypot(bx - ax, by - ay), n = Math.ceil(L);
      for (let t = 0; t <= n; t++) {
        const x = ax + ((bx - ax) * t) / n, y = ay + ((by - ay) * t) / n, dd = Math.hypot(x - cx, y - cy);
        if (dd < radius + 10) stamp(x, y, 2);
        if (dd > radius * 0.55 && dd < radius * 0.65) exits.push(Math.atan2(y - cy, x - cx));
      }
    }
  }
  // Lane directions: toward each road exit, then into the widest gaps until the culture's lane count is met.
  const dirs: number[] = [];
  for (const a of exits) if (dirs.every((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) > 0.6)) dirs.push(a);
  while (dirs.length < cul.lanes.count + Math.min(2, dirs.length)) {
    if (!dirs.length) { dirs.push(rng.range(0, Math.PI * 2)); continue; }
    const sorted = [...dirs].sort((p, r) => p - r);
    let best = 0, gap = -1;
    for (let k = 0; k < sorted.length; k++) { const a = sorted[k], b = k + 1 < sorted.length ? sorted[k + 1] : sorted[0] + Math.PI * 2; if (b - a > gap) { gap = b - a; best = a + (b - a) / 2; } }
    dirs.push(best + rng.range(-0.2, 0.2));
  }
  const lanes: Array<Array<[number, number]>> = [];
  for (const a0 of dirs) {
    const lane: Array<[number, number]> = [];
    let a = a0, x = cx + Math.cos(a) * square.r, y = cy + Math.sin(a) * square.r;
    const len = Math.min(cul.lanes.length * K, core);
    for (let t = 0; t < len; t += 3) {
      if (q.wet(x, y, 6) || Math.hypot(x - cx, y - cy) > radius - 8) break;
      lane.push([Math.round(x), Math.round(y)]);
      a += (rng.float() - 0.5) * cul.lanes.wind;
      x += Math.cos(a) * 3; y += Math.sin(a) * 3;
    }
    if (lane.length > 2) lanes.push(lane);
  }
  for (const lane of lanes) for (let k = 0; k + 1 < lane.length; k++) {
    const [ax, ay] = lane[k], [bx, by] = lane[k + 1];
    for (let t = 0; t <= 6; t++) stamp(ax + ((bx - ax) * t) / 6, ay + ((by - ay) * t) / 6, laneW >> 1);
  }

  // Building programme: counts within the culture's ranges, then scaled into the settlement's building range.
  const prog = cul.program.map(([type, lo, hi, zone]) => ({ type, n: rng.int(lo, hi), zone }));
  const countOf = () => prog.reduce((a, p) => a + (SPECS[p.type].counts ? p.n : 0), 0);
  const filler = prog.filter((p) => SPECS[p.type].counts && p.zone === 'lane').sort((p, r) => r.n - p.n)[0] ?? prog[0];
  const want = rng.int(s.buildings[0], s.buildings[1]);
  while (countOf() < want) filler.n++;
  while (countOf() > want && filler.n > 1) filler.n--;

  const S = regionCells, buildings: PlannedBuilding[] = [];
  const fits = (x: number, y: number, w: number, d: number, pad: boolean): boolean => {
    // Inside the village, clear of lanes and other buildings (1 m gap), dry, gentle enough, one region per pad.
    if (pad && (Math.floor((x - 1) / S) !== Math.floor((x + w) / S) || Math.floor((y - 1) / S) !== Math.floor((y + d) / S))) return false;
    for (const [px, py] of [[x, y], [x + w - 1, y], [x, y + d - 1], [x + w - 1, y + d - 1]]) if (Math.hypot(px - cx, py - cy) > radius - 4) return false;
    for (let yy = y - 1; yy <= y + d; yy++) for (let xx = x - 1; xx <= x + w; xx++) { if (!inG(xx, yy)) return false; if (occ[(yy - gy0) * G + xx - gx0]) return false; }
    const zs = [q.z(x, y), q.z(x + w, y), q.z(x, y + d), q.z(x + w, y + d), q.z(x + w / 2, y + d / 2)];
    if (Math.max(...zs) - Math.min(...zs) > cul.flatTol) return false;
    const wetOk = !pad; // stilt houses and fishing huts may stand at the water's edge
    if (!wetOk) for (const [px, py] of [[x, y], [x + w, y], [x, y + d], [x + w, y + d], [x + w / 2, y + d / 2]]) if (q.wet(px, py, 4)) return false;
    return true;
  };
  const place = (type: BuildingType, x: number, y: number) => {
    const sp = SPECS[type], b: PlannedBuilding = { type, x, y, w: sp.w, d: sp.h, floors: Math.max(1, Math.min(3, sp.floors || 1)), pad: !NO_PAD.has(type) };
    buildings.push(b);
    for (let yy = y - 1; yy <= y + b.d; yy++) for (let xx = x - 1; xx <= x + b.w; xx++) mark(xx, yy, 2);
  };
  const tryAt = (type: BuildingType, cands: Array<[number, number]>): boolean => {
    const sp = SPECS[type], pad = !NO_PAD.has(type);
    for (const [px, py] of cands) {
      const x = Math.round(px - sp.w / 2), y = Math.round(py - sp.h / 2);
      if (fits(x, y, sp.w, sp.h, pad)) { place(type, x, y); return true; }
    }
    return false;
  };
  const ring = (r0: number, r1: number, n: number): Array<[number, number]> => { const out: Array<[number, number]> = []; for (let k = 0; k < n; k++) { const a = rng.range(0, Math.PI * 2), r = rng.range(r0, r1); out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return out; };
  const laneCands = (): Array<[number, number]> => {
    const out: Array<[number, number, number]> = [];
    for (const lane of lanes) for (let k = 1; k + 1 < lane.length; k++) {
      const [ax, ay] = lane[k - 1], [bx, by] = lane[k + 1], L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L, ny = (bx - ax) / L;
      for (const side of [-1, 1]) for (const off of [5, 6.5, 8]) out.push([lane[k][0] + nx * off * side, lane[k][1] + ny * off * side, Math.hypot(lane[k][0] - cx, lane[k][1] - cy) + rng.float() * 6]);
    }
    return out.sort((p, r) => p[2] - r[2]).map(([x, y]) => [x, y]);
  };
  const near = (type: BuildingType): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const b of buildings) if (b.type === type) for (let a = 0; a < 12; a++) { const ang = (a / 12) * Math.PI * 2; out.push([b.x + b.w / 2 + Math.cos(ang) * (b.w + 4), b.y + b.d / 2 + Math.sin(ang) * (b.d + 5)]); }
    return out;
  };
  const waterCands = (): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let k = 0; k < 400; k++) { const a = rng.range(0, Math.PI * 2), r = rng.range(square.r + 6, radius - 8), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; if (q.wet(x, y, 16) && !q.wet(x, y, 7)) out.push([x, y]); }
    return out;
  };
  for (const p of prog) {
    for (let i = 0; i < p.n; i++) {
      let ok = false;
      const z = p.zone;
      if (z === 'centre') ok = tryAt(p.type, ring(square.r + 3, square.r + 14, 80));
      else if (z === 'lane' || z === 'tree') ok = tryAt(p.type, laneCands());
      else if (z === 'outer') ok = tryAt(p.type, ring(core * 0.6, Math.min(radius - 10, core * 1.3), 120));
      else if (z === 'water') ok = tryAt(p.type, waterCands()); else if (z === 'high') {
        const c = ring(square.r + 10, Math.min(radius - 10, core * 1.4), 60).sort((a, b) => q.z(b[0], b[1]) - q.z(a[0], a[1]));
        ok = tryAt(p.type, c);
      } else if (z.startsWith('near:')) ok = tryAt(p.type, [...near(z.slice(5) as BuildingType), ...ring(square.r + 4, core, 40)]);
      // Anything that found no spot in its zone goes along the lanes, then anywhere in the core.
      if (!ok && SPECS[p.type].counts) ok = tryAt(p.type, laneCands()) || tryAt(p.type, ring(square.r + 4, radius - 10, 200));
    }
  }
  // The mill's wheel faces the water: check the side toward the nearest water.
  for (const b of buildings) if (b.type === 'water-mill') b.wheelSide = q.wet(b.x + b.w + 3, b.y + 2, 4) ? 1 : q.wet(b.x - 3, b.y + 2, 4) ? -1 : (b.wheelSide ?? 1);

  // Farmland around the core: plots in free, dry, gentle ground inside the village footprint (plus a little).
  const fields: FieldPlot[] = [];
  if (cul.farm.kind !== 'ponds') {
    const [w0, w1, h0, h1] = cul.farm.plot, target = cul.farm.target * (cul.farm.kind === 'gardens' ? 1 : K * K * 0.5);
    let area = 0;
    for (let tries = 0; tries < 600 && area < target; tries++) {
      const gardens = cul.farm.kind === 'gardens';
      const w = Math.round(rng.range(w0, w1) * (gardens ? 1 : K)), h = Math.round(rng.range(h0, h1) * (gardens ? 1 : K));
      const [px, py] = ring(gardens ? square.r + 8 : core * 0.75, radius + 20, 1)[0];
      const x0 = Math.round(px - w / 2), y0 = Math.round(py - h / 2);
      let free = true;
      for (let yy = y0 - 1; yy <= y0 + h && free; yy++) for (let xx = x0 - 1; xx <= x0 + w; xx++) { if (!inG(xx, yy) || occ[(yy - gy0) * G + xx - gx0]) { free = false; break; } }
      if (!free) continue;
      const zs = [q.z(x0, y0), q.z(x0 + w, y0), q.z(x0, y0 + h), q.z(x0 + w, y0 + h)];
      if (Math.max(...zs) - Math.min(...zs) > 4) continue;
      if ([[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h], [x0 + w / 2, y0 + h / 2]].some(([x, y]) => q.wet(x, y, 4))) continue;
      fields.push({ x0, y0, x1: x0 + w, y1: y0 + h, dir: w >= h ? 0 : 1, kind: cul.farm.kind });
      for (let yy = y0; yy < y0 + h; yy++) for (let xx = x0; xx < x0 + w; xx++) mark(xx, yy, 3);
      area += w * h;
    }
  }
  const counted = buildings.reduce((a, b) => a + (SPECS[b.type].counts ? 1 : 0), 0);
  return {
    id: s.id, name: s.name, culture: cul.id, cx, cy, radius, square, lanes, laneWidth: laneW, buildings, fields, counted,
    bbox: [gx0, gy0, gx0 + G, gy0 + G],
  };
}
