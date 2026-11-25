import type { Activity, ActivityPlace, Pt, Resident, Village } from './types';

/** A day plan: from each start hour until the next entry, do `activity` at `place`. */
type Plan = Array<[hour: number, activity: Activity, place: ActivityPlace]>;

const WORKER: Plan = [[0, 'sleep', 'home'], [5.5, 'eat', 'home'], [6.5, 'work', 'work'], [12, 'eat', 'communal'], [13, 'work', 'work'], [18, 'gather', 'communal'], [21, 'rest', 'home'], [22, 'sleep', 'home']];
const KEEPER: Plan = [[0, 'sleep', 'home'], [6.5, 'eat', 'home'], [7, 'work', 'work'], [12.5, 'eat', 'work'], [13, 'trade', 'work'], [22.5, 'rest', 'home'], [23, 'sleep', 'home']];
const TRADER: Plan = [[0, 'sleep', 'home'], [6, 'eat', 'home'], [7, 'trade', 'market'], [12, 'eat', 'communal'], [13, 'trade', 'market'], [18, 'gather', 'communal'], [21, 'sleep', 'home']];
const HUNTER: Plan = [[0, 'sleep', 'home'], [4.5, 'eat', 'home'], [5, 'work', 'wilds'], [14, 'work', 'work'], [17, 'eat', 'communal'], [18, 'gather', 'communal'], [21.5, 'sleep', 'home']];
const FISHER: Plan = [[0, 'sleep', 'home'], [4, 'work', 'water'], [11, 'eat', 'home'], [12, 'work', 'work'], [16, 'rest', 'home'], [18, 'gather', 'communal'], [21, 'sleep', 'home']];
const LOOKOUT: Plan = [[0, 'sleep', 'home'], [6, 'eat', 'home'], [7, 'patrol', 'work'], [13, 'eat', 'communal'], [14, 'patrol', 'work'], [20, 'gather', 'communal'], [22, 'sleep', 'home']];
const CHILD: Plan = [[0, 'sleep', 'home'], [7, 'eat', 'home'], [8, 'gather', 'communal'], [12, 'eat', 'home'], [13, 'forage', 'communal'], [18, 'eat', 'home'], [19, 'rest', 'home'], [20.5, 'sleep', 'home']];
const ELDER: Plan = [[0, 'sleep', 'home'], [7, 'rest', 'home'], [10, 'gather', 'communal'], [17, 'rest', 'home'], [21, 'sleep', 'home']];

const PLANS: Record<string, Plan> = {
  innkeeper: KEEPER, brewer: KEEPER, cook: KEEPER, merchant: TRADER, trader: TRADER, carter: TRADER,
  hunter: HUNTER, trapper: HUNTER, guide: HUNTER, fisher: FISHER, 'reed-cutter': FISHER,
  lookout: LOOKOUT, child: CHILD, elder: ELDER,
};

export const planFor = (occupation: string): Plan => PLANS[occupation] ?? WORKER;

/** Places that are out in the open (weather sends people indoors from these). */
const OUTDOOR = new Set<string>(['fields', 'water', 'forest', 'wilds', 'communal', 'market']);
const OUTDOOR_WORK = new Set(['fields', 'water', 'forest', 'wilds', 'mine']);
/** People who stand their ground (or keep watch) when danger comes. */
const GUARDS = new Set(['lookout', 'hunter', 'guide', 'trapper']);

export interface Conditions {
  /** 0..1 */
  rain: number;
  storm: boolean;
  /** Nearby danger: wildlife (wolves, bears) or a dragon. */
  threat: 'none' | 'wildlife' | 'dragon';
}

export interface Doing { activity: Activity; place: ActivityPlace }

/**
 * What a resident is doing at an hour of the day, given weather and danger. Pure and deterministic: the future
 * entity system steps NPCs toward `placeOf(...)` for the result.
 */
export function activityAt(r: Resident, hour: number, c: Conditions): Doing {
  const plan = planFor(r.occupation);
  const h = ((hour % 24) + 24) % 24;
  let cur = plan[0];
  for (const e of plan) if (e[0] <= h) cur = e;
  let activity: Activity = cur[1];
  let place: ActivityPlace = cur[2] === 'work' && OUTDOOR_WORK.has(r.work) ? (r.work as ActivityPlace) : cur[2];
  if (place === 'communal' && r.work === 'communal' && activity === 'work') activity = 'gather';

  if (c.threat === 'dragon') {
    if (activity === 'sleep') return { activity: 'sleep', place: 'home' };
    return GUARDS.has(r.occupation) ? { activity: 'patrol', place: 'communal' } : { activity: 'shelter', place: 'shelter' };
  }
  if (c.threat === 'wildlife') {
    if (r.occupation === 'child' || r.occupation === 'elder') return activity === 'sleep' ? { activity, place } : { activity: 'shelter', place: 'shelter' };
    if (GUARDS.has(r.occupation)) return { activity: 'patrol', place: 'wilds' };
    if (OUTDOOR_WORK.has(place)) return { activity: 'gather', place: 'communal' };
  }
  if ((c.storm || c.rain >= 0.6) && OUTDOOR.has(place) && activity !== 'sleep') {
    // Outdoor work stops; gatherings and trade move under the shelter roof.
    if (activity === 'work' || activity === 'forage' || activity === 'patrol') return { activity: 'rest', place: 'home' };
    return { activity, place: 'shelter' };
  }
  return { activity, place };
}

const mid = (b: { x: number; y: number; w: number; h: number }): Pt => [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];

/** Where a place is, for one resident of a village. Areas resolve to the village's nearest matching spot. */
export function placeOf(v: Village, r: Resident, place: ActivityPlace, spots: { water: Pt; forest: Pt; wilds: Pt }): Pt {
  const byId = (id: string) => v.buildings.find((b) => b.id === id);
  switch (place) {
    case 'home': { const b = byId(r.home); return b ? mid(b) : v.centre; }
    case 'shelter': { const b = byId(v.shelter); return b ? mid(b) : v.centre; }
    case 'communal': return v.communal[0] ?? v.centre;
    case 'market': {
      const b = v.buildings.find((q) => q.type === 'market-hall' || q.type === 'trading-post');
      return b ? mid(b) : v.communal[0] ?? v.centre;
    }
    case 'work': { const b = byId(r.work); return b ? mid(b) : v.centre; }
    case 'fields': {
      const all = [...v.fields, ...v.pens];
      if (!all.length) return v.centre;
      const k = Math.abs(hashStr(r.id)) % all.length;
      return mid(all[k]);
    }
    case 'mine': { const b = v.buildings.find((q) => q.type === 'mine-head'); return b ? mid(b) : spots.wilds; }
    case 'water': return spots.water;
    case 'forest': return spots.forest;
    default: return spots.wilds;
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
