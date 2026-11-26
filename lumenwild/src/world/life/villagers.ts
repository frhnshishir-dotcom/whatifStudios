import { type Agent, type LifeClock, type TerrainQuery, SpatialHash, rngOf, inHours, walkToward } from './core';
import type { VillagePlan, PlannedBuilding } from '../villages';
import { SPECS, CULTURES } from '../../engine/continent/cultures';

/**
 * Living villages. Every village plan gets its residents: homes from the plan's houses (by the building's resident
 * range), jobs from its workplaces and its culture's trades, and a daily schedule (sleep, morning, work, midday at
 * the square or the inn, work, evening together, home). They walk along the lanes, work at their place (fields,
 * the water's edge, the forge, the stalls...), stop to talk when they meet, shelter from heavy rain, and run indoors
 * when a wolf, a bear or a low dragon comes near.
 *
 * Villages near a player are simulated in detail; others are not stepped: when one comes into range its people are
 * placed where their schedule puts them at that hour.
 */

export type VState = 'home' | 'walk' | 'work' | 'social' | 'chat' | 'shelter' | 'flee' | 'idle';

export interface Villager extends Agent {
  kind: 'villager';
  village: string;
  name: string;
  /** Job (farmer, fisher, merchant, blacksmith...): the agent's tag. */
  tag: string;
  culture: string;
  h: number;
  st: VState;
  /** Activity shown while working: hoe, fish, trade, forge, craft, mill, tend, watch, gather. */
  act: string;
  stT: number;
  home: [number, number];
  workAt: [number, number];
  /** Planned route (points) and the index walked to. */
  route: Array<[number, number]>;
  ri: number;
  /** What the walk is for. */
  goal: VState;
  /** Personal offset to the schedule (hours). */
  shift: number;
  /** Visible outdoors? (indoors at home, at the inn or in a workshop.) */
  out: boolean;
  chatWith: string | null;
  said: string;
  sayT: number;
  look: number;
}

const FIRST = ['Ada', 'Bram', 'Cora', 'Dain', 'Elin', 'Finn', 'Greta', 'Hal', 'Ivy', 'Jory', 'Kesta', 'Lorn', 'Mira', 'Ned', 'Orla', 'Pell', 'Quin', 'Rhea', 'Sten', 'Tamsin', 'Ulf', 'Vela', 'Wren', 'Yara'];
const LAST = ['Ashby', 'Brook', 'Cole', 'Dunmore', 'Fern', 'Hale', 'Marsh', 'Oakes', 'Reed', 'Stone', 'Thatch', 'Vale', 'Wick', 'Yew'];
/** Building type -> job done there. */
const JOB_AT: Record<string, string> = {
  inn: 'innkeeper', tavern: 'brewer', smithy: 'blacksmith', 'market-hall': 'merchant', 'market-stall': 'merchant', 'trading-post': 'trader',
  'water-mill': 'miller', windmill: 'miller', workshop: 'carpenter', woodcarver: 'woodcarver', shrine: 'shrine-keeper', herbalist: 'herbalist',
  'mine-head': 'miner', 'watch-post': 'lookout', smokehouse: 'smoker', 'net-shed': 'netmaker', stable: 'groom', 'elder-hall': 'warden', longhouse: 'cook',
};
/** Job -> activity glyph group. */
const ACT: Record<string, string> = {
  farmer: 'hoe', herder: 'tend', fisher: 'fish', 'reed-cutter': 'gather', gatherer: 'gather', forester: 'gather', beekeeper: 'tend', woodcutter: 'chop',
  hunter: 'watch', trapper: 'watch', guide: 'watch', miner: 'mine', merchant: 'trade', trader: 'trade', carter: 'trade', innkeeper: 'serve', brewer: 'serve', cook: 'serve',
  blacksmith: 'forge', carpenter: 'craft', woodcarver: 'craft', netmaker: 'craft', smoker: 'craft', miller: 'mill', 'shrine-keeper': 'tend', herbalist: 'gather',
  lookout: 'watch', groom: 'tend', warden: 'tend',
};
const LINES: Record<string, string[]> = {
  hoe: ['Good soil this year.', 'The rows won’t hoe themselves.'], fish: ['They’re biting today.', 'Quiet water, good catch.'],
  trade: ['Fresh goods from the road!', 'Fair prices, friend.'], forge: ['Mind the sparks.', 'Iron waits for no one.'],
  craft: ['Measure twice, cut once.', 'Almost finished this one.'], serve: ['Warm stew inside.', 'A bed for the night?'],
  mill: ['The wheel turns well today.'], tend: ['All in order here.'], gather: ['Plenty growing by the water.'], watch: ['Keep an eye on the treeline.'],
  mine: ['Good seam down there.'], chop: ['Good timber in these woods.'],
};

export interface VillageContext {
  q: TerrainQuery;
  clock: LifeClock;
  hash: SpatialHash;
}

/** A plan's lane graph: nodes (square centre and lane points), edges along lanes and from lane starts to the square. */
interface Graph { pts: Array<[number, number]>; adj: number[][] }

function laneGraph(p: VillagePlan): Graph {
  const pts: Array<[number, number]> = [[p.square.x, p.square.y]], adj: number[][] = [[]];
  for (const lane of p.lanes) {
    let prev = 0;
    for (const [x, y] of lane) {
      const i = pts.push([x, y]) - 1;
      adj.push([]);
      adj[i].push(prev); adj[prev].push(i);
      prev = i;
    }
  }
  return { pts, adj };
}

function nearestNode(g: Graph, x: number, y: number): number {
  let b = 0, bd = Infinity;
  g.pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; b = i; } });
  return b;
}

/** Route from a to b: to the nearest lane point, along the lanes (BFS), then off the lane to b. */
function route(g: Graph, a: [number, number], b: [number, number]): Array<[number, number]> {
  const s = nearestNode(g, a[0], a[1]), t = nearestNode(g, b[0], b[1]);
  const prev = new Int32Array(g.pts.length).fill(-1), seen = new Uint8Array(g.pts.length), queue = [s];
  seen[s] = 1;
  while (queue.length) { const u = queue.shift()!; if (u === t) break; for (const v of g.adj[u]) if (!seen[v]) { seen[v] = 1; prev[v] = u; queue.push(v); } }
  const path: number[] = [];
  for (let u = t; u !== -1; u = prev[u]) { path.push(u); if (u === s) break; }
  path.reverse();
  return [...path.map((i) => g.pts[i]), b];
}

const door = (b: PlannedBuilding): [number, number] => [b.x + Math.floor(b.w / 2), b.y + b.d + 1];

export class Villages {
  readonly people = new Map<string, Villager>();
  readonly active = new Set<string>();
  readonly stats = { villagers: 0, outdoors: 0, ms: 0 };
  private graphs = new Map<string, Graph>();
  private plans = new Map<string, VillagePlan>();
  private scratch: Agent[] = [];

  /** Make a village's people (once). */
  populate(p: VillagePlan, q: TerrainQuery, clock: LifeClock): void {
    if (this.plans.has(p.id)) return;
    this.plans.set(p.id, p);
    const g = laneGraph(p);
    this.graphs.set(p.id, g);
    const r = rngOf('villagers', p.id), cul = CULTURES[p.culture];
    // Homes: buildings with residents; workplaces: buildings with jobs.
    const homes: PlannedBuilding[] = [], work: Array<{ b: PlannedBuilding; job: string }> = [];
    for (const b of p.buildings) {
      const sp = SPECS[b.type];
      const n = sp.residents[1] > 0 ? sp.residents[0] + Math.floor(r() * (sp.residents[1] - sp.residents[0] + 1)) : 0;
      for (let k = 0; k < Math.min(n, 3); k++) homes.push(b);
      const job = JOB_AT[b.type];
      if (job) work.push({ b, job });
    }
    // Outdoor work sites: field plots, the water's edge, the edge of the woods.
    const fieldPt = (): [number, number] => {
      const f = p.fields.length ? p.fields[Math.floor(r() * p.fields.length)] : null;
      return f ? [f.x0 + 1 + r() * (f.x1 - f.x0 - 2), f.y0 + 1 + r() * (f.y1 - f.y0 - 2)] : [p.cx + (r() - 0.5) * p.radius, p.cy + (r() - 0.5) * p.radius];
    };
    const edgePt = (): [number, number] => { const a = r() * Math.PI * 2, d = p.radius * (0.85 + r() * 0.3); return [p.cx + Math.cos(a) * d, p.cy + Math.sin(a) * d]; };
    const waterPt = (): [number, number] | null => {
      for (let rr = 20; rr < p.radius + 120; rr += 10) for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2 + rr, x = p.cx + Math.cos(a) * rr, y = p.cy + Math.sin(a) * rr;
        if (q.water(x, y)) for (let b = 1; b < 6; b++) { const sx = x - Math.cos(a) * b, sy = y - Math.sin(a) * b; if (q.walkable(sx, sy)) return [sx, sy]; }
      }
      return null;
    };
    const trades = cul.trades.flatMap(([job, w, where]) => Array.from({ length: w }, () => ({ job, where })));
    let wi = 0;
    homes.forEach((hb, k) => {
      const id = `${p.id}-${k}`;
      let job: string, at: [number, number];
      if (wi < work.length && (k % 3 !== 2 || wi < 3)) { const w = work[wi++]; job = w.job; at = door(w.b); }
      else {
        const t = trades[Math.floor(r() * trades.length)] ?? { job: 'farmer', where: 'fields' as const };
        job = t.job;
        at = t.where === 'water' ? (waterPt() ?? fieldPt()) : t.where === 'fields' ? fieldPt() : t.where === 'market' ? [p.square.x + (r() - 0.5) * 6, p.square.y + (r() - 0.5) * 6] : edgePt();
      }
      const name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
      const home = door(hb);
      this.people.set(id, {
        id, kind: 'villager', tag: job, village: p.id, name, culture: p.culture, x: home[0], y: home[1], alt: 0, alive: true, h: 0, st: 'home', act: ACT[job] ?? 'tend',
        stT: 0, home, workAt: at, route: [], ri: 0, goal: 'home', shift: (r() - 0.5) * 1.2, out: false, chatWith: null, said: '', sayT: 0, look: r(),
      });
    });
    // Place everyone where the hour puts them.
    for (const v of this.people.values()) if (v.village === p.id) this.placeBySchedule(v, clock);
  }

  /** What a villager should be doing at an hour. */
  private planned(v: Villager, clock: LifeClock): VState {
    const h = (clock.hour - v.shift + 24) % 24;
    if (inHours(h, 21.5, 5.5)) return 'home';
    if (inHours(h, 5.5, 6.5) || inHours(h, 20, 21.5)) return 'idle';
    if (inHours(h, 12, 13) || inHours(h, 18, 20)) return 'social';
    return 'work';
  }

  private where(v: Villager, st: VState): [number, number] {
    const p = this.plans.get(v.village)!;
    if (st === 'work') return v.workAt;
    if (st === 'social') { const a = v.look * Math.PI * 2; return [p.square.x + Math.cos(a) * (p.square.r - 2), p.square.y + Math.sin(a) * (p.square.r - 2)]; }
    if (st === 'shelter') { const inn = p.buildings.find((b) => b.type === 'inn' || b.type === 'tavern' || b.type === 'longhouse' || b.type === 'elder-hall'); return inn ? door(inn) : v.home; }
    return v.home;
  }

  private placeBySchedule(v: Villager, clock: LifeClock): void {
    const st = this.planned(v, clock), [x, y] = this.where(v, st);
    v.x = x; v.y = y; v.st = st === 'idle' ? 'idle' : st; v.goal = st; v.out = st !== 'home'; v.route = []; v.stT = 0;
  }

  private go(v: Villager, goal: VState): void {
    const g = this.graphs.get(v.village)!, to = this.where(v, goal);
    v.route = route(g, [v.x, v.y], to); v.ri = 0; v.goal = goal; v.st = 'walk'; v.stT = 0; v.out = true;
  }

  update(dt: number, activeVillages: Set<string>, ctx: VillageContext): void {
    const t0 = performance.now();
    let n = 0, out = 0;
    for (const v of this.people.values()) {
      if (!activeVillages.has(v.village)) continue;
      n++;
      this.step(v, dt, ctx);
      if (v.out) out++;
    }
    this.stats.villagers = n; this.stats.outdoors = out; this.stats.ms = performance.now() - t0;
  }

  private step(v: Villager, dt: number, ctx: VillageContext): void {
    const q = ctx.q, clock = ctx.clock;
    v.stT += dt;
    if (v.sayT > 0) v.sayT -= dt;
    // Threats: wolves, bears, low dragons near -> run home (indoors) and stay a while.
    const near = ctx.hash.near(v.x, v.y, 90, this.scratch, v);
    for (const a of near) {
      const danger = (a.kind === 'creature' && (a.tag === 'wolf' || a.tag === 'bear') && Math.hypot(a.x - v.x, a.y - v.y) < 50) || (a.kind === 'dragon' && a.alt < 120);
      if (danger && a.alive && v.st !== 'flee' && v.out) { this.go(v, 'home'); v.st = 'flee'; v.said = a.kind === 'dragon' ? 'Dragon! Inside, quick!' : `A ${a.tag}! Get inside!`; v.sayT = 3; return; }
    }
    const planned = clock.rain > 0.55 && this.planned(v, clock) !== 'home' ? 'shelter' : this.planned(v, clock);
    switch (v.st) {
      case 'walk': case 'flee': {
        const p = v.route[v.ri];
        if (!p) { v.st = v.goal; v.stT = 0; v.out = v.goal !== 'home' && v.goal !== 'shelter' && !(v.goal === 'work' && ['serve', 'forge', 'craft', 'mill'].includes(v.act) && clock.rain > 0.55); break; }
        const speed = v.st === 'flee' ? 3.2 : 1.3;
        if (Math.hypot(p[0] - v.x, p[1] - v.y) < 0.8) v.ri++;
        else if (!walkToward(v, p[0], p[1], speed, dt, q)) { v.x += Math.cos(Math.atan2(p[1] - v.y, p[0] - v.x)) * speed * dt; v.y += Math.sin(Math.atan2(p[1] - v.y, p[0] - v.x)) * speed * dt; }
        if (v.st === 'flee') break;
        // Meeting a neighbour on the way: stop for a word now and then.
        if (planned !== 'home' && v.stT > 4) for (const a of near) {
          if (a.kind !== 'villager' || Math.hypot(a.x - v.x, a.y - v.y) > 2.2) continue;
          const o = a as Villager;
          if ((o.st === 'walk' || o.st === 'social' || o.st === 'idle') && !o.chatWith && rngOf(v.id, o.id, Math.floor(clock.t / 30))() < 0.5) {
            v.st = 'chat'; v.stT = 0; v.chatWith = o.id; o.st = 'chat'; o.stT = 0; o.chatWith = v.id;
            v.said = 'Morning!'; v.sayT = 2.5; o.said = LINES[o.act]?.[0] ?? 'Fine day.'; o.sayT = 3;
            break;
          }
        }
        break;
      }
      case 'chat':
        // After a word, carry on where they were going.
        if (v.stT > 7) { v.chatWith = null; v.st = v.ri < v.route.length ? 'walk' : 'idle'; v.stT = 0; }
        break;
      default: {
        // Arrived (or idle): follow the schedule.
        if (planned !== v.goal && (v.st !== 'home' || planned !== 'home')) { this.go(v, planned === 'idle' ? 'idle' : planned); if (planned === 'idle') v.route = [[v.home[0], v.home[1] + 1]]; break; }
        if (v.st === 'work' && v.out) {
          // Working: small movements at the work site (along a furrow, around the stall).
          if (v.act === 'hoe' || v.act === 'gather' || v.act === 'tend') { const r = rngOf(v.id, Math.floor(clock.t / 6))(); walkToward(v, v.workAt[0] + Math.cos(r * 6.28) * 3, v.workAt[1] + Math.sin(r * 6.28) * 2, 0.5, dt, q); }
        }
        if (v.st === 'social' && v.stT > 20 && rngOf(v.id, Math.floor(clock.t / 20))() < 0.15) { v.said = LINES[v.act]?.[Math.floor(v.look * 2) % (LINES[v.act]?.length ?? 1)] ?? 'Fine day.'; v.sayT = 3; v.stT = 0; }
        if (v.st === 'idle' && planned === 'idle') { v.out = true; }
        break;
      }
    }
  }

  /** A line for a player who greets this villager. */
  greet(v: Villager): string {
    const job = v.tag.replace('-', ' ');
    const line = LINES[v.act]?.[0] ?? 'Welcome, traveller.';
    v.said = line; v.sayT = 4;
    return `${v.name} (${job}): “${line}”`;
  }

  toJSON(): Array<[string, number, number, string]> { return [...this.people.values()].map((v) => [v.id, Math.round(v.x), Math.round(v.y), v.st]); }
}
