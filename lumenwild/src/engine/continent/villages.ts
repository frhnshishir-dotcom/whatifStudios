import { SIZE, Water, type Building, type BuildingType, type Pt, type Rect, type Resident, type Village, type Territory, type Habitat, type River } from './types';
import { CULTURES, SPECS, type Culture, type VillageDesign, type Zone } from './cultures';
import { Rng } from '../core/rng';
import { protectedAt } from './wilds';

/** Occupancy codes shared by everything placed on the continent. */
export const OCC_BUILDING = 1, OCC_LANE = 2, OCC_FIELD = 3, OCC_SITE = 4;

export interface PlaceContext {
  seed: number;
  height: Float32Array;
  water: Uint8Array;
  forest: Uint8Array;
  occ: Uint8Array;
  rivers: River[];
  territories: Territory[];
  habitats: Habitat[];
}

const W = SIZE;
const inB = (x: number, y: number) => x >= 1 && y >= 1 && x < W - 1 && y < W - 1;

/** Height range over a rectangle (m), or Infinity if it leaves the map. */
function rectRange(ctx: PlaceContext, r: Rect): number {
  let lo = Infinity, hi = -Infinity;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    if (!inB(x, y)) return Infinity;
    const h = ctx.height[y * W + x];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo;
}

/** Distance (cells, capped) from (x, y) to the nearest water of the given kinds. */
function waterDist(ctx: PlaceContext, x: number, y: number, kinds: Water[], cap = 12): number {
  for (let r = 0; r <= cap; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !inB(x + dx, y + dy)) continue;
      if (kinds.includes(ctx.water[(y + dy) * W + x + dx])) return r;
    }
  }
  return cap + 1;
}

const ANY_WATER = [Water.River, Water.Lake, Water.Marsh];

/** Direction of the nearest river near (x, y): [angle, distance]. */
function riverNear(ctx: PlaceContext, x: number, y: number): [number, number, Pt] {
  let best = 1e9, ang = 0, at: Pt = [x, y];
  for (const r of ctx.rivers) {
    for (let k = 1; k < r.points.length - 1; k += 2) {
      const p = r.points[k], d = Math.hypot(p[0] - x, p[1] - y);
      if (d < best) {
        best = d; at = p;
        const q = r.points[k + 1], o = r.points[k - 1];
        ang = Math.atan2(q[1] - o[1], q[0] - o[0]);
      }
    }
  }
  return [ang, best, at];
}

function findCentre(ctx: PlaceContext, d: VillageDesign, cul: Culture): Pt {
  for (let r = 0; r <= 24; r++) {
    for (let a = 0; a < Math.max(1, r * 8); a++) {
      const ang = (a / Math.max(1, r * 8)) * Math.PI * 2;
      const x = Math.round(d.at[0] + Math.cos(ang) * r), y = Math.round(d.at[1] + Math.sin(ang) * r);
      let ok = true;
      for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3 && ok; dx++) {
        if (!inB(x + dx, y + dy) || ctx.water[(y + dy) * W + x + dx] !== Water.None) ok = false;
      }
      if (ok && rectRange(ctx, { x: x - 3, y: y - 3, w: 7, h: 7 }) <= cul.flatTol + 1) return [x, y];
    }
  }
  return [d.at[0], d.at[1]];
}

/** Walk a lane outward, steering around water, steep ground and (in the grove) great trees. */
function walkLane(ctx: PlaceContext, cul: Culture, start: Pt, centre: Pt, angle: number, rng: Rng): Pt[] {
  const out: Pt[] = [];
  let x = start[0], y = start[1], th = angle;
  const marsh = cul.id === 'marsh-stilt', grove = cul.id === 'elder-grove';
  for (let step = 0; step < cul.lanes.length * 1.4 && out.length < cul.lanes.length; step++) {
    let best = Infinity, bx = 0, by = 0, bth = th;
    for (const off of [-0.6, -0.3, 0, 0.3, 0.6]) {
      const t = th + off, nx = x + Math.cos(t), ny = y + Math.sin(t);
      const ix = Math.round(nx), iy = Math.round(ny);
      if (!inB(ix, iy)) continue;
      const i = iy * W + ix, w = ctx.water[i];
      if (ctx.occ[i] === OCC_BUILDING || ctx.occ[i] === OCC_FIELD || ctx.occ[i] === OCC_SITE) continue;
      if (w !== Water.None && !(marsh && w === Water.Marsh)) continue;
      if (grove && ctx.forest[i] >= 215) continue;
      const dh = Math.abs(ctx.height[i] - ctx.height[Math.round(y) * W + Math.round(x)]);
      const c = dh * (cul.lanes.follow === 'contour' ? 7 : 3) + Math.abs(off) * 0.5 + Math.abs(Math.atan2(Math.sin(t - angle), Math.cos(t - angle))) * (1.2 - cul.lanes.wind)
        + (grove ? ctx.forest[i] / 255 : 0) + (w === Water.Marsh ? 0.4 : 0) + rng.float() * cul.lanes.wind * 2;
      if (c < best) { best = c; bx = nx; by = ny; bth = t; }
    }
    if (best === Infinity || Math.hypot(bx - centre[0], by - centre[1]) > cul.coreR + 6) break;
    x = bx; y = by; th = bth;
    const p: Pt = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

interface Cand { r: Rect; lane: number }

function laneCands(lanes: Pt[][], w: number, h: number): Cand[] {
  const out: Cand[] = [];
  for (const lane of lanes) {
    for (let i = 1; i < lane.length - 1; i++) {
      const [x, y] = lane[i];
      const dx = lane[i + 1][0] - lane[i - 1][0], dy = lane[i + 1][1] - lane[i - 1][1];
      if (Math.abs(dx) >= Math.abs(dy)) {
        const rx = x - (w >> 1);
        out.push({ r: { x: rx, y: y - 1 - h, w, h }, lane: i }, { r: { x: rx, y: y + 2, w, h }, lane: i });
      } else {
        const ry = y - (w >> 1);
        out.push({ r: { x: x - 1 - h, y: ry, w: h, h: w }, lane: i }, { r: { x: x + 2, y: ry, w: h, h: w }, lane: i });
      }
    }
  }
  return out;
}

const centreOf = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h / 2];

/** Lay out one village: centre, lanes, buildings by zone, farmland, pens, residents. Marks the shared occupancy grid. */
export function layoutVillage(ctx: PlaceContext, d: VillageDesign): Village {
  const cul = CULTURES[d.culture];
  const rng = new Rng('village', d.id, ctx.seed);
  const centre = findCentre(ctx, d, cul);
  const [rAng] = riverNear(ctx, centre[0], centre[1]);
  const [, , riverPt] = riverNear(ctx, centre[0], centre[1]);
  const toRiver = Math.atan2(riverPt[1] - centre[1], riverPt[0] - centre[0]);
  const plaza = cul.architecture.layout === 'square-and-lanes' ? 4 : 2;

  // Reserve the centre (square, fire pit, deck or glade) so lanes start at its edge.
  for (let dy = -plaza; dy <= plaza; dy++) for (let dx = -plaza; dx <= plaza; dx++) {
    if (dx * dx + dy * dy <= plaza * plaza) ctx.occ[(centre[1] + dy) * W + centre[0] + dx] = OCC_LANE;
  }
  const lanes: Pt[][] = [];
  const n = cul.lanes.count;
  const base = cul.lanes.follow === 'river' ? rAng : d.id === 'greenhaven' ? toRiver : rng.float() * Math.PI * 2;
  const angles = cul.lanes.follow === 'river' && n >= 2
    ? [base, base + Math.PI, ...Array.from({ length: n - 2 }, (_, k) => toRiver + Math.PI + (k - (n - 3) / 2) * 0.8)]
    : Array.from({ length: n }, (_, k) => base + (k / n) * Math.PI * 2 + rng.range(-0.25, 0.25));
  for (const a of angles) {
    const start: Pt = [Math.round(centre[0] + Math.cos(a) * plaza), Math.round(centre[1] + Math.sin(a) * plaza)];
    const lane = walkLane(ctx, cul, start, centre, a, rng);
    if (lane.length > 3) { lanes.push(lane); for (const [x, y] of lane) ctx.occ[y * W + x] = OCC_LANE; }
  }

  const buildings: Building[] = [];
  const marsh = cul.id === 'marsh-stilt', grove = cul.id === 'elder-grove';
  /** Stilt buildings over the marsh and tree houses: they stand above the ground and clear nothing. */
  const isRaised = (type: BuildingType) => (marsh && (type === 'stilt-house' || type === 'longhouse' || type === 'fishing-hut' || type === 'net-shed' || type === 'lantern-deck')) || type === 'tree-house';
  const valid = (type: BuildingType, r: Rect, zone: Zone): boolean => {
    const raised = isRaised(type);
    for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
      if (!inB(x, y)) return false;
      const i = y * W + x, inside = x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
      if (ctx.occ[i] === OCC_BUILDING || ctx.occ[i] === OCC_SITE) return false;
      if (!inside) continue;
      if (ctx.occ[i] !== 0) return false;
      const w = ctx.water[i];
      if (w !== Water.None && !(raised && marsh && w === Water.Marsh)) return false;
      if (grove && type !== 'tree-house' && ctx.forest[i] >= 215) return false;
    }
    if (rectRange(ctx, r) > (raised ? 4 : cul.flatTol)) return false;
    const [cx, cy] = centreOf(r);
    const dist = Math.hypot(cx - centre[0], cy - centre[1]);
    if (dist > (zone === 'outer' ? cul.fieldR * 0.75 : cul.coreR)) return false;
    if (protectedAt(cx, cy, ctx.territories, ctx.habitats)) return false;
    if (type === 'tree-house' && ctx.forest[Math.round(cy) * W + Math.round(cx)] < 175) return false;
    if (type === 'water-mill' && waterDist(ctx, Math.round(cx), Math.round(cy), [Water.River], 4) > 4) return false;
    if ((type === 'fishing-hut' || type === 'net-shed') && waterDist(ctx, Math.round(cx), Math.round(cy), ANY_WATER, 4) > 3) return false;
    if (marsh && type === 'stilt-house' && waterDist(ctx, Math.round(cx), Math.round(cy), ANY_WATER, 6) > 5) return false;
    return true;
  };
  const prominence = (x: number, y: number) => {
    let s = 0;
    for (let a = 0; a < 8; a++) s += ctx.height[Math.round(y + Math.sin(a * 0.785) * 12) * W + Math.round(x + Math.cos(a * 0.785) * 12)];
    return ctx.height[Math.round(y) * W + Math.round(x)] - s / 8;
  };

  const place = (type: BuildingType, zone: Zone): boolean => {
    const s = SPECS[type];
    const cands: Cand[] = laneCands(lanes, s.w, s.h);
    const rMax = zone === 'outer' ? cul.fieldR * 0.75 : cul.coreR;
    const rMin = zone === 'centre' ? plaza + 1 : zone === 'outer' ? cul.coreR * 0.5 : 3;
    for (let k = 0; k < 420; k++) {
      const a = rng.float() * Math.PI * 2, rr = rMin + (rMax - rMin) * (zone === 'centre' ? rng.float() ** 2 * 0.4 : rng.float());
      const flip = rng.chance(0.5), w = flip ? s.h : s.w, h = flip ? s.w : s.h;
      cands.push({ r: { x: Math.round(centre[0] + Math.cos(a) * rr - w / 2), y: Math.round(centre[1] + Math.sin(a) * rr - h / 2), w, h }, lane: 40 });
    }
    let best: Cand | null = null, bs = -Infinity;
    const nearType = zone.startsWith('near:') ? zone.slice(5) as BuildingType : null;
    const anchors = nearType ? buildings.filter((b) => b.type === nearType) : [];
    for (const c of cands) {
      const [cx, cy] = centreOf(c.r);
      const dist = Math.hypot(cx - centre[0], cy - centre[1]);
      let sc: number;
      if (zone === 'centre') sc = -dist;
      else if (zone === 'lane') sc = -Math.abs(c.lane - 10) * 0.25 - dist * 0.15;
      else if (zone === 'outer') sc = -Math.abs(dist - cul.coreR * 0.9) * 0.4;
      else if (zone === 'water') sc = -waterDist(ctx, Math.round(cx), Math.round(cy), ANY_WATER, 8) * 2 - dist * 0.2;
      else if (zone === 'tree') sc = ctx.forest[Math.round(cy) * W + Math.round(cx)] / 30 - dist * 0.15;
      else if (zone === 'high') sc = prominence(cx, cy) * 2 - Math.abs(dist - cul.coreR * 0.75) * 0.3;
      else sc = anchors.length ? -Math.min(...anchors.map((b) => Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy))) : -dist * 0.2;
      sc += rng.float() * 1.2;
      if (sc > bs && valid(type, c.r, zone)) { bs = sc; best = c; }
    }
    if (!best) return false;
    const r = best.r;
    const raised = isRaised(type);
    buildings.push({ id: `${d.id}-${type}-${buildings.filter((b) => b.type === type).length + 1}`, type, x: r.x, y: r.y, w: r.w, h: r.h, counts: s.counts, floors: s.floors, raised });
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = y * W + x;
      ctx.occ[i] = OCC_BUILDING;
      if (!raised) ctx.forest[i] = 0;
    }
    return true;
  };

  for (const [type, lo, hi, zone] of cul.program) {
    const count = rng.int(lo, hi);
    for (let k = 0; k < count; k++) place(type, zone);
  }

  // Farmland: fields, pastures, fish ponds or forest gardens. Plots grow as a patchwork from the farmsteads (each new
  // plot usually shares a hedge line with an existing one), so farmland forms a few compact blocks, not a scatter.
  const fields: Rect[] = [];
  let area = 0;
  const f = cul.farm;
  const farmSeeds = buildings.filter((b) => ['farmhouse', 'barn', 'longhouse', 'stilt-house', 'root-house', 'tree-house', 'fishing-hut'].includes(b.type));
  for (let k = 0; k < 9000 && area < f.target; k++) {
    const flip = rng.chance(0.5), w0 = rng.int(f.plot[0], f.plot[1]), h0 = rng.int(f.plot[2], f.plot[3]);
    const w = flip ? h0 : w0, h = flip ? w0 : h0;
    let r: Rect;
    if (fields.length && rng.chance(0.8)) {
      const b = fields[rng.int(0, fields.length - 1)], side = rng.int(0, 3);
      const ax = b.x + rng.int(-(w - 3), b.w - 3), ay = b.y + rng.int(-(h - 3), b.h - 3);
      r = side === 0 ? { x: b.x + b.w + 1, y: ay, w, h } : side === 1 ? { x: b.x - w - 1, y: ay, w, h } : side === 2 ? { x: ax, y: b.y + b.h + 1, w, h } : { x: ax, y: b.y - h - 1, w, h };
    } else if (farmSeeds.length && rng.chance(0.85)) {
      const b = farmSeeds[rng.int(0, farmSeeds.length - 1)], a = rng.float() * Math.PI * 2, rr = rng.range(4, 12);
      r = { x: Math.round(b.x + b.w / 2 + Math.cos(a) * rr - w / 2), y: Math.round(b.y + b.h / 2 + Math.sin(a) * rr - h / 2), w, h };
    } else {
      const a = rng.float() * Math.PI * 2, rr = cul.coreR * 0.5 + (cul.fieldR - cul.coreR * 0.5) * rng.float() ** 1.4;
      r = { x: Math.round(centre[0] + Math.cos(a) * rr - w / 2), y: Math.round(centre[1] + Math.sin(a) * rr - h / 2), w, h };
    }
    if (Math.hypot(r.x + r.w / 2 - centre[0], r.y + r.h / 2 - centre[1]) > cul.fieldR) continue;
    if (fieldOk(ctx, r, cul)) {
      fields.push(r); area += w * h;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { ctx.occ[y * W + x] = OCC_FIELD; ctx.forest[y * W + x] = 0; }
    }
  }
  const pens: Rect[] = [];
  const penAnchors = buildings.filter((b) => b.type === 'barn' || b.type === 'stable' || b.type === 'longhouse');
  for (let k = 0; k < 600 && pens.length < cul.pens && penAnchors.length; k++) {
    const b = penAnchors[k % penAnchors.length];
    const r: Rect = { x: b.x + rng.int(-9, 9), y: b.y + rng.int(-7, 7), w: 6, h: 5 };
    if (fieldOk(ctx, r, cul)) {
      pens.push(r);
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { ctx.occ[y * W + x] = OCC_FIELD; ctx.forest[y * W + x] = 0; }
    }
  }
  for (const lane of lanes) for (const [x, y] of lane) if (!grove || ctx.forest[y * W + x] < 215) ctx.forest[y * W + x] = Math.min(ctx.forest[y * W + x], grove ? 140 : 0);

  const shelter = buildings.find((b) => b.type === cul.shelter) ?? buildings.find((b) => b.counts && SPECS[b.type].residents[1] === 0) ?? buildings[0];
  const communalB = buildings.find((b) => b.type === cul.communal);
  const communal: Pt[] = [communalB ? [Math.round(communalB.x + communalB.w / 2), Math.round(communalB.y + communalB.h / 2)] : centre];
  if (shelter) communal.push([Math.round(shelter.x + shelter.w / 2), Math.round(shelter.y + shelter.h / 2)]);
  return { id: d.id, name: d.name, biome: d.biome, at: d.at, centre, culture: d.culture, buildings, lanes, fields, pens, communal, shelter: shelter?.id ?? '', residents: assignResidents(d.id, cul, buildings, rng), clearedAncient: 0 };
}

function fieldOk(ctx: PlaceContext, r: Rect, cul: Culture): boolean {
  let fsum = 0;
  for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
    if (!inB(x, y)) return false;
    const i = y * W + x;
    if (ctx.occ[i] !== 0 && ctx.occ[i] !== OCC_LANE) return false;
    const inside = x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    if (!inside) continue;
    if (ctx.occ[i] === OCC_LANE) return false;
    const w = ctx.water[i];
    if (w !== Water.None && !(cul.farm.kind === 'ponds' && w === Water.Marsh)) return false;
    fsum += ctx.forest[i];
  }
  if (fsum / (r.w * r.h) > cul.farm.maxForest) return false;
  if (rectRange(ctx, r) > ({ pasture: 9, gardens: 5, fields: 3, ponds: 3 } as const)[cul.farm.kind]) return false;
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]] as Pt[]) {
    if (protectedAt(x, y, ctx.territories, ctx.habitats, 2)) return false;
  }
  const lim = Math.ceil(Math.max(r.w, r.h) / 2) + 2;
  if (cul.farm.kind !== 'ponds' && waterDist(ctx, Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), [Water.River], lim) <= lim) return false;
  return true;
}

/** Households and jobs: building jobs are filled first, everyone else takes up the village's open trades. */
function assignResidents(vid: string, cul: Culture, buildings: Building[], rng: Rng): Resident[] {
  const people: Resident[] = [];
  const jobs: Array<{ occupation: string; work: string }> = [];
  for (const b of buildings) for (const j of SPECS[b.type].jobs) jobs.push({ occupation: j, work: b.id });
  const homes = buildings.filter((b) => SPECS[b.type].residents[1] > 0);
  const tradeTotal = cul.trades.reduce((s, t) => s + t[1], 0);
  for (const h of homes) {
    const [lo, hi] = SPECS[h.type].residents;
    const n = rng.int(lo, hi);
    for (let k = 0; k < n; k++) {
      const id = `${vid}-p${people.length + 1}`;
      let occupation: string, work: string;
      if (k >= 2 && rng.chance(0.55)) { occupation = 'child'; work = 'communal'; }
      else if (rng.chance(0.08)) { occupation = 'elder'; work = 'communal'; }
      else if (jobs.length) { const j = jobs.shift()!; occupation = j.occupation; work = j.work; }
      else {
        let t = rng.float() * tradeTotal, pick = cul.trades[0];
        for (const tr of cul.trades) { t -= tr[1]; if (t <= 0) { pick = tr; break; } }
        occupation = pick[0]; work = pick[2];
      }
      people.push({ id, occupation, home: h.id, work });
    }
  }
  return people;
}
