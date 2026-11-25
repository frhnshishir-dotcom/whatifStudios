import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { validateWorld, type WorldData } from '../src/world/schema';
import { WorldCoords } from '../src/world/coords';
import { buildBlueprint, regionAt, W_RIVER, type Blueprint } from '../src/world/blueprint';
import { createDiscovery, observe, reveal, explorationPercent, mapState, serializeDiscovery, deserializeDiscovery } from '../src/world/discovery';

let bp: Blueprint;
beforeAll(() => { bp = buildBlueprint(WORLD); }, 30_000);
const clone = (): WorldData => JSON.parse(JSON.stringify(WORLD));

describe('world data files', () => {
  it('validate with no errors or warnings', () => {
    expect(validateWorld(WORLD)).toEqual({ errors: [], warnings: [] });
  });
  it('the validator catches broken data', () => {
    const d = clone();
    d.landmarks.push({ ...d.landmarks[0] });
    d.roads[0].via.push('nowhere');
    d.settlements[0].at = [1200, 10];
    d.rivers[1].from = 'missing-river';
    d.territories[0].huntingGrounds.push('no-habitat');
    (d.settlements[1] as { kind: string }).kind = 'city';
    d.settlements[2].buildings = [10, 60];
    const v = validateWorld(d);
    for (const s of ['duplicate id "skyfall-summit"', 'unknown stop "nowhere"', 'outside 0-1000', 'unknown parent river', 'unknown hunting ground', 'villages only, no cities', 'within 10-30']) {
      expect(v.errors.some((e) => e.includes(s)), s).toBe(true);
    }
  });
  it('has the specification content: six regions, six villages and no cities, six dragon territories, five rivers', () => {
    expect(WORLD.regions.map((r) => r.id)).toEqual(['dragon-peaks', 'elderwood', 'heartlands', 'whispering-marshes', 'golden-plains', 'hollow-lands']);
    expect(WORLD.settlements.map((s) => s.id)).toEqual(['lumenfall', 'greenhaven', 'frostwatch', 'marshlight', 'windmere', 'moonrest']);
    for (const s of WORLD.settlements) {
      expect(s.kind).toBe('village');
      expect(s.name).not.toMatch(/city|outpost/i);
      expect(s.buildings[1]).toBeLessThanOrEqual(30);
      expect(s.footprintRadius * WORLD.coordinates.metresPerMapUnit).toBeLessThanOrEqual(250); // a village, not a town
    }
    expect(WORLD.settlements[0].name).toBe('Lumenfall Village');
    expect(WORLD.settlements[0].at).toEqual([500, 510]);
    expect(WORLD.landmarks.map((l) => l.name)).toEqual(expect.arrayContaining(['Riverwatch Tower', 'Sunspire Watchtower']));
    expect(WORLD.landmarks.some((l) => /old watchtower/i.test(l.name))).toBe(false);
    expect(WORLD.territories).toHaveLength(6);
    for (const id of ['lumen-river', 'moonwater-stream', 'ashen-run', 'goldenbrook', 'witchwater-channels']) expect(WORLD.rivers.some((r) => r.id === id), id).toBe(true);
    expect(WORLD.lakes.map((l) => l.name)).toEqual(['Skyglass Lake', 'Moonlit Lake', "King's Basin", 'Witchwater Pool']);
  });
});

describe('coordinates (one conversion utility)', () => {
  const c = new WorldCoords(WORLD.coordinates);
  it('sizes the continent in cells, chunks and regions', () => {
    expect(c.metresPerUnit).toBe(100);
    expect(WORLD.coordinates.terrainCellMetres).toBe(1); // World.ts: one cell is 1 m
    expect(c.cells).toBe(100_000);
    expect(c.chunks).toBe(6250);
    expect(c.regions).toBe(391);
  });
  it('round-trips between map, metres, 3D world, cells, regions and the prototype grid', () => {
    for (const p of [[0, 0], [500, 510], [999.9, 999.9], [123.4, 876.5]] as [number, number][]) {
      const w = c.mapToWorld3D(p, 42);
      expect(w.y).toBe(42);
      const back = c.world3DToMap(w);
      expect(back[0]).toBeCloseTo(p[0], 9); expect(back[1]).toBeCloseTo(p[1], 9);
      const cell = c.mapToCell(p), centre = c.cellToMap(cell);
      expect(Math.abs(centre[0] - p[0])).toBeLessThanOrEqual(0.01);
      expect(Math.abs(centre[1] - p[1])).toBeLessThanOrEqual(0.01);
      const { region, local } = c.cellToRegion(cell);
      expect(region[0] * 256 + local[0]).toBe(cell[0]);
      const proto = c.mapToPrototype(p), pc = c.prototypeToMap(proto);
      expect(Math.abs(pc[0] - p[0])).toBeLessThanOrEqual(1000 / 256);
    }
    expect(c.mapToRegionId([500, 510])).toBe('r195-199');
    expect(c.metresBetween([0, 0], [3, 4])).toBe(500);
    expect(c.prototypeCellMetres()).toBeCloseTo(390.6, 1);
  });
});

describe('blueprint geography', () => {
  it('passes every geography check', () => {
    const failed = bp.checks.filter((k) => !k.ok);
    expect(failed, failed.map((k) => `${k.id}: ${k.detail}`).join('\n')).toEqual([]);
    expect(bp.checks.length).toBeGreaterThan(35);
  });
  it('is reproducible and fast', () => {
    const t0 = performance.now();
    const b = buildBlueprint(WORLD);
    expect(performance.now() - t0).toBeLessThan(5000);
    let h1 = 0, h2 = 0;
    for (let i = 0; i < bp.elev.length; i += 13) { h1 = (h1 * 31 + Math.round(bp.elev[i] * 10) + bp.water[i]) | 0; h2 = (h2 * 31 + Math.round(b.elev[i] * 10) + b.water[i]) | 0; }
    expect(h1).toBe(h2);
  }, 30_000);
  it('rivers never flow uphill, reach the sea or their parent, and the Lumen leaps Emberfall', () => {
    for (const r of bp.rivers) for (let k = 1; k < r.surface.length; k++) expect(r.surface[k]).toBeLessThanOrEqual(r.surface[k - 1] + 1e-9);
    const lumen = bp.rivers.find((r) => r.id === 'lumen-river')!;
    const ember = WORLD.landmarks.find((l) => l.id === 'emberfall')!;
    const fall = lumen.falls.find((f) => Math.hypot(f.at[0] - ember.at[0], f.at[1] - ember.at[1]) < 15);
    expect(fall?.drop).toBeGreaterThanOrEqual(100);
    expect(lumen.surface[0]).toBeCloseTo(bp.lakeLevels['skyglass-lake'], 0); // it leaves Skyglass Lake
    // It passes near Lumenfall and through King's Basin.
    const near = (p: [number, number], d: number) => lumen.pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= d);
    expect(near([500, 510], 7)).toBe(true); // within 700 m of Lumenfall (riverside)
    expect(near([470, 475], 10)).toBe(true);
  });
  it('mountains are high and the marshes low; regions are where the specification puts them', () => {
    expect(bp.regionStats['dragon-peaks'].p90).toBeGreaterThan(1100);
    expect(bp.regionStats['whispering-marshes'].p90).toBeLessThan(160);
    expect(regionAt(bp, 480, 90)).toBe('dragon-peaks');
    expect(regionAt(bp, 500, 510)).toBe('heartlands');
    expect(regionAt(bp, 850, 330)).toBe('hollow-lands');
    expect(regionAt(bp, 160, 720)).toBe('golden-plains');
  });
  it('every village has a road and fresh water within 800 m; King\'s Road crosses the Lumen at King\'s Bridge', () => {
    const start = bp.settlements.find((s) => s.id === 'lumenfall')!;
    expect(start.roads).toBeGreaterThanOrEqual(4);
    for (const s of bp.settlements) {
      expect(s.roads, s.id).toBeGreaterThanOrEqual(1);
      expect(s.waterDist * WORLD.coordinates.metresPerMapUnit, s.id).toBeLessThanOrEqual(800);
    }
    // Villages are separated by real wilderness: at least 15 km apart.
    for (const a of WORLD.settlements) for (const b of WORLD.settlements) if (a !== b) expect(Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) * 100).toBeGreaterThan(15_000);
    const kings = bp.roads.find((r) => r.id === 'kings-road')!;
    expect(kings.bridges.some((b) => b.name === "King's Bridge" && b.river === 'lumen-river')).toBe(true);
    for (const r of bp.roads) {
      expect(r.length, r.id).toBeGreaterThanOrEqual(r.straight); // roads follow the land, never shorter than straight lines
      // every river crossing has a bridge
      let crossings = 0, inRiver = false;
      for (let k = 0; k < r.pts.length; k++) {
        const [x, y] = r.pts[k], w = bp.water[Math.floor(y / bp.unit) * bp.N + Math.floor(x / bp.unit)] === W_RIVER;
        if (w && !inRiver) crossings++;
        inRiver = w;
      }
      if (crossings) expect(r.bridges.length, r.id).toBeGreaterThan(0);
    }
  });
  it('dragons: nests on land with landing sites, corridors clear terrain and settlements, the sky corridor has no nest', () => {
    for (const t of WORLD.territories.filter((q) => q.kind === 'nest')) expect(bp.landing[t.id].length, t.id).toBeGreaterThanOrEqual(3);
    for (const c of bp.corridors) {
      expect(c.cruise).toBeLessThanOrEqual(WORLD.flight.ceiling);
      expect(c.cruise - c.maxGround).toBeGreaterThanOrEqual(WORLD.flight.clearance);
      for (const o of c.overflights) expect(o.agl).toBeGreaterThanOrEqual(WORLD.flight.settlementMinAGL);
    }
    const sky = WORLD.territories.find((t) => t.id === 'territory-southern-sky-corridor')!;
    expect(sky.kind).toBe('corridor');
    expect(sky.nest).toBeUndefined();
    expect(sky.dragon).toBeUndefined();
    expect(sky.migration).toBe(true);
    expect(WORLD.flight.migrationRoutes.every((r) => r.includes(sky.id))).toBe(true);
    // No low flight over villages: every corridor passing within the no-low-flight radius holds 450 m above the village.
    for (const c of bp.corridors) for (const s of WORLD.settlements) {
      const ax = c.a[0], ay = c.a[1], bx = c.b[0], by = c.b[1], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((s.at[0] - ax) * dx + (s.at[1] - ay) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(ax + dx * t - s.at[0], ay + dy * t - s.at[1]) <= WORLD.flight.noLowFlightRadius) {
        const g = bp.elev[Math.floor(s.at[1] / bp.unit) * bp.N + Math.floor(s.at[0] / bp.unit)];
        expect(c.cruise - g, `${c.from}-${c.to} over ${s.id}`).toBeGreaterThanOrEqual(450);
      }
    }
    for (const s of WORLD.settlements) for (const t of WORLD.territories.filter((q) => q.kind === 'nest')) {
      expect(Math.hypot(s.at[0] - t.centre[0], s.at[1] - t.centre[1]), `${s.id} in ${t.id}`).toBeGreaterThan(t.radius);
    }
  });
});

describe('map discovery', () => {
  it('a new player knows the start, not the secrets', () => {
    const s = createDiscovery(WORLD);
    expect(s.discovered.has('lumenfall')).toBe(true);
    expect(s.discovered.has('greenhaven')).toBe(true);
    expect(s.knownRoutes.has('kings-road')).toBe(true);
    expect(mapState(WORLD, s, 'ember-nest')).toBe('hidden');
    expect(mapState(WORLD, s, 'skyfall-summit')).toBe('rumour');
    const heart = explorationPercent(WORLD, s, (x, y) => regionAt(bp, x, y) === 'heartlands');
    expect(heart).toBeGreaterThan(5);
    expect(heart).toBeLessThan(40);
    expect(explorationPercent(WORLD, s, (x, y) => regionAt(bp, x, y) === 'hollow-lands')).toBe(0);
  });
  it('exploring reveals land and places; tall landmarks are seen from afar; state survives a save', () => {
    const s = createDiscovery(WORLD);
    const before = explorationPercent(WORLD, s, (x, y) => regionAt(bp, x, y) === 'dragon-peaks');
    expect(reveal(WORLD, s, [430, 300], 30)).toBeGreaterThan(0);
    expect(s.discovered.has('frostwatch')).toBe(true);
    expect(observe(WORLD, s, [470, 380])).toContain('skyfall-summit'); // 290 units away, visible from 320
    expect(mapState(WORLD, s, 'skyfall-summit')).toBe('shown');
    expect(explorationPercent(WORLD, s, (x, y) => regionAt(bp, x, y) === 'dragon-peaks')).toBeGreaterThan(before);
    const back = deserializeDiscovery(JSON.parse(JSON.stringify(serializeDiscovery(s))));
    expect([...back.discovered].sort()).toEqual([...s.discovered].sort());
    expect(Array.from(back.fog)).toEqual(Array.from(s.fog));
    expect(serializeDiscovery(s).fog.length).toBeLessThan(8000); // about 5 KB per player
  });
});
