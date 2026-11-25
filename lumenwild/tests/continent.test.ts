import { describe, it, expect, beforeAll } from 'vitest';
import { generateContinent } from '../src/engine/continent/generate';
import { CULTURES, VILLAGE_DESIGNS, SPECS } from '../src/engine/continent/cultures';
import { activityAt, placeOf } from '../src/engine/continent/population';
import { SIZE, Use, Water, Biome, type Continent, type Village } from '../src/engine/continent/types';

const W = SIZE;
let c: Continent;
beforeAll(() => { c = generateContinent(1); }, 30_000);

const vil = (id: string) => c.villages.find((v) => v.id === id)!;
const count = (v: Village, t: string) => v.buildings.filter((b) => b.type === t).length;
/** Nearest cell (Chebyshev rings) matching `f`, or Infinity. */
function nearest(x: number, y: number, max: number, f: (i: number) => boolean): number {
  for (let r = 0; r <= max; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const xx = x + dx, yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < W && yy < W && f(yy * W + xx)) return r;
  }
  return Infinity;
}

describe('continent: generation', () => {
  it('is deterministic for a seed and fast enough to generate on load', () => {
    const t0 = performance.now();
    const b = generateContinent(1);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(b.stats).toEqual(c.stats);
    let h1 = 0, h2 = 0;
    for (let i = 0; i < W * W; i += 7) { h1 = (h1 * 31 + c.use[i] + c.water[i] * 7 + Math.round(c.height[i])) | 0; h2 = (h2 * 31 + b.use[i] + b.water[i] * 7 + Math.round(b.height[i])) | 0; }
    expect(h1).toBe(h2);
  }, 30_000);

  it('has the wild geography: rivers to the sea, waterfalls, lakes, marshes, caves, mountains', () => {
    expect(c.rivers.map((r) => r.id)).toEqual(['silverrun', 'amberflow', 'thornbrook']);
    for (const r of c.rivers) for (let k = 1; k < r.bed.length; k++) expect(r.bed[k]).toBeLessThanOrEqual(r.bed[k - 1]);
    expect(c.falls.length).toBeGreaterThanOrEqual(3);
    expect(c.lakes).toHaveLength(4);
    expect(c.caves.length).toBeGreaterThanOrEqual(4);
    let marsh = 0, peaks = 0;
    for (let i = 0; i < W * W; i++) { if (c.water[i] === Water.Marsh) marsh++; if (c.height[i] > 90) peaks++; }
    expect(marsh).toBeGreaterThan(2000);
    expect(peaks).toBeGreaterThan(2000);
  });
});

describe('acceptance 1: no cities anywhere', () => {
  it('every settlement is small and far from the next; nothing urban grows between them', () => {
    for (const v of c.villages) {
      expect(v.buildings.filter((b) => b.counts).length).toBeLessThanOrEqual(30);
      expect(v.residents.length).toBeLessThanOrEqual(110);
    }
    expect(c.stats.population).toBeLessThanOrEqual(300);
    for (const a of c.villages) for (const b of c.villages) if (a !== b) expect(Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1])).toBeGreaterThan(150);
    // Largest connected built-up area (buildings, yards, lanes): a hamlet, not a town.
    const seen = new Uint8Array(W * W);
    let largest = 0;
    for (let i = 0; i < W * W; i++) {
      if (seen[i] || c.use[i] !== Use.Village) continue;
      let n = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop()!; n++;
        const x = k % W, y = (k / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * W + x + dx;
          if (j >= 0 && j < W * W && !seen[j] && c.use[j] === Use.Village) { seen[j] = 1; stack.push(j); }
        }
      }
      largest = Math.max(largest, n);
    }
    expect(largest).toBeLessThan(5000);
    // Outposts are single buildings or camps, never clusters.
    for (const a of c.outposts) for (const b of c.outposts) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
  });
});

describe('acceptance 2: the five villages', () => {
  it('stand at their design positions, in their biomes, near what they need', () => {
    for (const d of VILLAGE_DESIGNS) {
      const v = vil(d.id);
      expect(Math.hypot(v.centre[0] - d.at[0], v.centre[1] - d.at[1])).toBeLessThanOrEqual(25);
      expect(c.biome[v.centre[1] * W + v.centre[0]]).toBe(d.biome);
      const n = v.buildings.filter((b) => b.counts).length;
      expect(n, d.id).toBeGreaterThanOrEqual(d.buildings[0]);
      expect(n, d.id).toBeLessThanOrEqual(d.buildings[1]);
    }
    const [gx, gy] = vil('greenhaven').centre;
    expect(nearest(gx, gy, 45, (i) => c.water[i] === Water.River)).toBeLessThanOrEqual(40);
    expect(nearest(gx, gy, 70, (i) => c.forest[i] >= 150)).toBeLessThanOrEqual(60);
    const [fx, fy] = vil('frostwatch').centre;
    expect(nearest(fx, fy, 50, (i) => c.water[i] === Water.Lake || c.water[i] === Water.River)).toBeLessThanOrEqual(45);
    const [wx, wy] = vil('windmere').centre;
    expect(nearest(wx, wy, 50, (i) => c.water[i] === Water.River)).toBeLessThanOrEqual(45);
    const [mx, my] = vil('marshlight').centre;
    expect(nearest(mx, my, 30, (i) => c.water[i] === Water.River || c.water[i] === Water.Marsh)).toBeLessThanOrEqual(25);
  });

  it('have the buildings their role calls for', () => {
    const g = vil('greenhaven');
    for (const t of ['inn', 'smithy', 'market-hall', 'well', 'water-mill']) expect(count(g, t), t).toBe(1);
    expect(count(g, 'home')).toBeGreaterThanOrEqual(8);
    expect(count(g, 'farmhouse')).toBeGreaterThanOrEqual(2);
    expect(g.fields.length).toBeGreaterThan(10);
    const f = vil('frostwatch');
    expect(count(f, 'mine-head')).toBe(1);
    expect(count(f, 'longhouse')).toBe(1);
    expect(f.residents.filter((r) => r.occupation === 'hunter').length).toBeGreaterThanOrEqual(1);
    expect(f.residents.filter((r) => r.occupation === 'miner').length).toBeGreaterThanOrEqual(1);
    const w = vil('windmere');
    expect(count(w, 'windmill')).toBeGreaterThanOrEqual(2);
    expect(count(w, 'barn')).toBeGreaterThanOrEqual(2);
    expect(w.pens.length).toBeGreaterThanOrEqual(2);
    expect(w.fields.reduce((s, r) => s + r.w * r.h, 0)).toBeGreaterThan(g.fields.reduce((s, r) => s + r.w * r.h, 0)); // the farming village farms most
    const m = vil('marshlight');
    expect(m.buildings.filter((b) => b.type === 'stilt-house' && b.raised).length).toBeGreaterThanOrEqual(5);
    expect(count(m, 'lantern-deck')).toBe(1);
    expect(m.buildings.some((b) => { for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (c.water[y * W + x] === Water.Marsh) return true; return false; })).toBe(true);
    const r = vil('moonrest');
    expect(r.buildings.filter((b) => b.type === 'tree-house' && b.raised).length).toBeGreaterThanOrEqual(3);
    expect(r.clearedAncient).toBeLessThanOrEqual(0.05); // minimal clearing of ancient vegetation
  });

  it('never put buildings in open water or on top of each other', () => {
    for (const v of c.villages) {
      const occ = new Set<number>();
      for (const b of v.buildings) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        const i = y * W + x;
        expect(occ.has(i)).toBe(false);
        occ.add(i);
        const wv = c.water[i];
        expect(wv === Water.River || wv === Water.Lake || wv === Water.Sea, `${b.id} in water`).toBe(false);
      }
    }
  });
});

describe('acceptance 3: distinctive architecture', () => {
  it('each culture differs in walls, roof, foundation and layout, and has signature buildings of its own', () => {
    const archs = Object.values(CULTURES).map((k) => k.architecture);
    for (const key of ['walls', 'roof', 'foundation', 'layout', 'palette'] as const) {
      expect(new Set(archs.map((a) => JSON.stringify(a[key]))).size, key).toBe(archs.length);
    }
    for (const v of c.villages) {
      const sig = CULTURES[v.culture].architecture.signature;
      for (const t of sig) expect(v.buildings.some((b) => b.type === t), `${v.id} ${t}`).toBe(true);
      // At least one signature type appears in no other village, and no other village has the whole set.
      const own = sig.filter((t) => !c.villages.some((o) => o !== v && o.buildings.some((b) => b.type === t)));
      expect(own.length, v.id).toBeGreaterThanOrEqual(1);
      for (const o of c.villages) if (o !== v) expect(sig.every((t) => o.buildings.some((b) => b.type === t)), `${o.id} copies ${v.id}`).toBe(false);
    }
  });
});

describe('acceptance 4: a wilderness continent', () => {
  it.each([1, 2, 3])('seed %i: 85-90 % wilderness, 5-8 % settlements, the rest special locations', (seed) => {
    const s = seed === 1 ? c.stats : generateContinent(seed).stats;
    expect(s.wilderness).toBeGreaterThanOrEqual(85);
    expect(s.wilderness).toBeLessThanOrEqual(90);
    expect(s.settlements).toBeGreaterThanOrEqual(5);
    expect(s.settlements).toBeLessThanOrEqual(8);
    expect(s.special).toBeGreaterThanOrEqual(2);
    expect(s.special).toBeLessThanOrEqual(10);
    expect(s.wilderness + s.settlements + s.special).toBeCloseTo(100, 0);
  }, 30_000);
});

describe('acceptance 5: limited roads that follow the land', () => {
  it('few, narrow paths; most land is far from any road', () => {
    expect(c.stats.trails).toBeLessThan(1);
    expect(c.stats.nearTrail).toBeLessThan(15);
    const links = c.trails.filter((t) => t.id.startsWith('path-'));
    expect(links.length).toBeLessThanOrEqual(c.villages.length); // spanning tree plus one loop
    // Every village is reachable from every other.
    const adj = new Map<string, string[]>();
    for (const t of links) { adj.set(t.from, [...(adj.get(t.from) ?? []), t.to]); adj.set(t.to, [...(adj.get(t.to) ?? []), t.from]); }
    const reach = new Set(['greenhaven']);
    const q = ['greenhaven'];
    while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!reach.has(n)) { reach.add(n); q.push(n); }
    expect(reach.size).toBe(5);
    expect(c.trails.some((t) => t.kind === 'mountain-pass')).toBe(true);
    expect(c.trails.some((t) => t.kind === 'ancient-road')).toBe(true);
  });

  it('paths wind with the terrain: gentle grades, no lakes, bridges or fords at every river', () => {
    for (const t of c.trails.filter((q) => q.kind !== 'ancient-road' && q.cells.length > 40)) {
      let climb = 0;
      for (let k = 1; k < t.cells.length; k++) {
        const [x0, y0] = t.cells[k - 1], [x1, y1] = t.cells[k];
        climb += Math.abs(c.height[y1 * W + x1] - c.height[y0 * W + x0]);
      }
      expect(climb / t.cells.length, t.id).toBeLessThan(t.kind === 'mountain-pass' ? 1.2 : 0.6);
      if (t.id.startsWith('path-')) {
        // Village links wind (longer than the straight line) and climb no more per metre than the straight line would.
        let len = 0;
        for (let k = 1; k < t.cells.length; k++) len += Math.hypot(t.cells[k][0] - t.cells[k - 1][0], t.cells[k][1] - t.cells[k - 1][1]);
        const [ax, ay] = t.cells[0], [bx, by] = t.cells[t.cells.length - 1];
        const straight = Math.hypot(bx - ax, by - ay);
        expect(len / straight, t.id).toBeGreaterThan(1.02);
        let sClimb = 0, prev = c.height[ay * W + ax];
        const n = Math.ceil(straight);
        for (let k = 1; k <= n; k++) {
          const h = c.height[Math.round(ay + ((by - ay) * k) / n) * W + Math.round(ax + ((bx - ax) * k) / n)];
          sClimb += Math.abs(h - prev); prev = h;
        }
        expect(climb / len, t.id).toBeLessThanOrEqual(sClimb / straight + 0.02);
      }
      for (const [x, y] of t.cells) expect([Water.Lake, Water.Sea]).not.toContain(c.water[y * W + x]);
      for (const [x, y] of t.cells) if (c.water[y * W + x] === Water.River) {
        expect(c.crossings.some((k) => Math.hypot(k.x - x, k.y - y) <= 8), `${t.id} crossing at ${x},${y}`).toBe(true);
      }
    }
    expect(c.crossings.some((k) => k.kind === 'wooden-bridge')).toBe(true);
  });
});

describe('acceptance 6: small-village populations with daily lives', () => {
  it('populations stay village-sized and every village has its trades', () => {
    for (const v of c.villages) {
      expect(v.residents.length, v.id).toBeGreaterThanOrEqual(12);
      expect(v.residents.length, v.id).toBeLessThanOrEqual(v.id === 'greenhaven' ? 110 : 70);
      expect(v.buildings.some((b) => b.id === v.shelter)).toBe(true);
      expect(v.communal.length).toBeGreaterThanOrEqual(1);
    }
    const occ = (id: string) => new Set(vil(id).residents.map((r) => r.occupation));
    for (const o of ['innkeeper', 'blacksmith', 'merchant', 'miller', 'farmer']) expect(occ('greenhaven').has(o), o).toBe(true);
    for (const o of ['fisher', 'herbalist']) expect(occ('marshlight').has(o), o).toBe(true);
    expect(occ('moonrest').has('woodcarver')).toBe(true);
    for (const v of c.villages) for (const b of v.buildings) {
      for (const job of SPECS[b.type].jobs.slice(0, 1)) {
        if (['shrine-keeper', 'groom', 'cook', 'lamplighter'].includes(job)) continue;
        expect(v.residents.some((r) => r.work === b.id), `${b.id} (${job}) staffed`).toBe(true);
      }
    }
  });

  it('routines: sleep at night, work by day, gather in the evening; weather and danger change plans', () => {
    const calm = { rain: 0, storm: false, threat: 'none' as const };
    const all = c.villages.flatMap((v) => v.residents.map((r) => ({ v, r })));
    const share = (f: (x: { v: Village; r: typeof all[0]['r'] }) => boolean) => all.filter(f).length / all.length;
    expect(share(({ r }) => { const d = activityAt(r, 3, calm); return d.activity === 'sleep' && d.place === 'home'; })).toBeGreaterThan(0.9);
    expect(share(({ r }) => ['work', 'trade', 'patrol'].includes(activityAt(r, 10, calm).activity))).toBeGreaterThan(0.5);
    expect(share(({ r }) => activityAt(r, 19.5, calm).activity === 'gather')).toBeGreaterThan(0.3);
    const rain = { rain: 0.8, storm: false, threat: 'none' as const };
    for (const { r } of all) expect(['fields', 'water', 'forest', 'wilds']).not.toContain(activityAt(r, 10, rain).place);
    const dragon = { rain: 0, storm: false, threat: 'dragon' as const };
    for (const { r } of all) {
      const d = activityAt(r, 14, dragon);
      if (['lookout', 'hunter', 'guide', 'trapper'].includes(r.occupation)) expect(d.activity).toBe('patrol');
      else expect(d.place).toBe('shelter');
    }
    const wolves = { rain: 0, storm: false, threat: 'wildlife' as const };
    for (const { r } of all) if (r.occupation === 'child') expect(activityAt(r, 14, wolves).place).toBe('shelter');
  });

  it('every place in a routine resolves to a spot in or near the village', () => {
    for (const v of c.villages) {
      const spots = { water: v.centre, forest: v.centre, wilds: [v.centre[0] + 60, v.centre[1]] as [number, number] };
      for (const r of v.residents) for (const p of ['home', 'work', 'communal', 'shelter', 'market', 'fields'] as const) {
        const [x, y] = placeOf(v, r, p, spots);
        expect(Math.hypot(x - v.centre[0], y - v.centre[1]), `${r.id} ${p}`).toBeLessThanOrEqual(CULTURES[v.culture].fieldR + 15);
      }
    }
  });
});

describe('acceptance 7: exploration first', () => {
  it('most special places and many outposts lie off the paths, out in the wilds', () => {
    const cells = c.trails.filter((t) => t.kind !== 'ancient-road').flatMap((t) => t.cells);
    const far = (x: number, y: number) => cells.every(([a, b]) => Math.hypot(a - x, b - y) > 15);
    const specials = c.specials.filter((s) => s.kind !== 'lair');
    expect(specials.filter((s) => far(s.x, s.y)).length / specials.length).toBeGreaterThan(0.6);
    expect(c.outposts.filter((o) => far(o.x, o.y)).length / c.outposts.length).toBeGreaterThan(0.4);
    const kinds = new Set(c.specials.map((s) => s.kind));
    for (const k of ['ruin', 'dungeon', 'landmark', 'lair', 'abandoned-hamlet']) expect(kinds.has(k as never), k).toBe(true);
    const ok = new Set(c.outposts.map((o) => o.kind));
    for (const k of ['ranger-cabin', 'hunter-camp', 'mountain-shelter', 'watchtower', 'travellers-camp']) expect(ok.has(k as never), k).toBe(true);
    expect(c.outposts.length).toBeLessThanOrEqual(30);
  });
});

describe('acceptance 8: dragon territories and habitats left undisturbed', () => {
  it('no farms, homes, camps or paths inside territories or habitat cores', () => {
    expect(c.stats.territoryDisturbance).toBeLessThan(1);
    expect(c.stats.habitatDisturbance).toBeLessThan(1);
    expect(c.territories.length).toBeGreaterThanOrEqual(3);
    for (const t of c.territories) {
      for (const v of c.villages) expect(Math.hypot(v.centre[0] - t.x, v.centre[1] - t.y), `${v.id}/${t.id}`).toBeGreaterThan(t.r + 50);
      for (const o of c.outposts) expect(Math.hypot(o.x - t.x, o.y - t.y), `${o.id}/${t.id}`).toBeGreaterThan(t.r);
      expect(Math.hypot(t.lair[0] - t.x, t.lair[1] - t.y)).toBeLessThan(t.r);
      expect(c.biome[t.lair[1] * W + t.lair[0]]).not.toBe(Biome.Sea);
    }
  });
});
