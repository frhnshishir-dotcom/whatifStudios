import { describe, it, expect, beforeAll } from 'vitest';
import { WORLD } from '../src/world/data';
import { buildBlueprint, type Blueprint } from '../src/world/blueprint';
import { ContinentTerrain, WK_NONE, WK_RIVER, type RegionData } from '../src/world/terrain';
import { CULTURES, SPECS } from '../src/engine/continent/cultures';
import { OBJECT_DEFS, BUILDING_TYPES, type WorldObject } from '../src/engine/objects/defs';
import { createContinentEngine } from '../src/boot';

/** Villages and road bridges at 1 m: planned from the world files, drawn into the regions they touch. */
let bp: Blueprint, ct: ContinentTerrain;
const S = 256;
const cache = new Map<string, RegionData>();
const region = (rx: number, ry: number) => { const k = `${rx},${ry}`; if (!cache.has(k)) cache.set(k, ct.generateRegion(rx, ry)); return cache.get(k)!; };
/** A cell anywhere on the continent (generating its region on demand). */
const cell = (x: number, y: number) => { const r = region(Math.floor(x / S), Math.floor(y / S)), i = (y - r.oy) * S + (x - r.ox); return { e: r.elev[i], kind: r.waterKind[i], level: r.waterLevel[i], r }; };

beforeAll(() => { bp = buildBlueprint(WORLD); ct = new ContinentTerrain(bp); }, 60_000);

describe('villages', { timeout: 300_000 }, () => {
  it('every village is planned within its building range, with its culture’s signature buildings, deterministically', () => {
    const ct2 = new ContinentTerrain(bp);
    for (const s of WORLD.settlements) {
      const p = ct.village(s.id)!;
      console.log(`${s.name}: ${p.counted} buildings (${s.buildings[0]}-${s.buildings[1]}), ${p.culture}, ${p.lanes.length} lanes, ${p.fields.length} plots`);
      expect(p.counted, s.id).toBeGreaterThanOrEqual(s.buildings[0]);
      expect(p.counted, s.id).toBeLessThanOrEqual(s.buildings[1]);
      const sig = CULTURES[p.culture].architecture.signature.filter((t) => p.buildings.some((b) => b.type === t));
      expect(sig.length, `${s.id} signature ${sig}`).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(ct2.village(s.id))).toBe(JSON.stringify(p));
    }
  });

  it('buildings stand apart, inside the village, on dry ground; pads are level and never cross a region edge', () => {
    for (const s of WORLD.settlements) {
      const p = ct.village(s.id)!;
      for (let a = 0; a < p.buildings.length; a++) for (let b = a + 1; b < p.buildings.length; b++) {
        const A = p.buildings[a], B = p.buildings[b];
        const apart = A.x + A.w + 1 <= B.x || B.x + B.w + 1 <= A.x || A.y + A.d + 1 <= B.y || B.y + B.d + 1 <= A.y;
        expect(apart, `${s.id}: ${A.type} and ${B.type} overlap`).toBe(true);
      }
      for (const b of p.buildings) {
        expect(Math.hypot(b.x + b.w / 2 - p.cx, b.y + b.d / 2 - p.cy), `${s.id} ${b.type}`).toBeLessThan(p.radius);
        if (!b.pad) continue;
        expect(Math.floor((b.x - 1) / S)).toBe(Math.floor((b.x + b.w) / S));
        expect(Math.floor((b.y - 1) / S)).toBe(Math.floor((b.y + b.d) / S));
        const z0 = cell(b.x, b.y).e;
        for (let y = b.y; y < b.y + b.d; y++) for (let x = b.x; x < b.x + b.w; x++) {
          const c = cell(x, y);
          expect(c.kind, `${s.id} ${b.type} on water`).toBe(WK_NONE);
          expect(c.e).toBeCloseTo(z0, 4);
        }
      }
    }
  });

  it('each building is an object in exactly the region holding its corner, in its culture’s style', () => {
    for (const s of WORLD.settlements) {
      const p = ct.village(s.id)!;
      for (const b of p.buildings) {
        const r = region(Math.floor(b.x / S), Math.floor(b.y / S));
        const o = r.objects.find((q) => q.x === b.x - r.ox && q.y === b.y - r.oy && (q.kind === 'building' || q.kind === 'mill'));
        expect(o, `${s.id} ${b.type}`).toBeDefined();
        if (o!.kind === 'building') {
          expect(o!.variant).toBe(p.culture);
          expect(BUILDING_TYPES[o!.props!.t]).toBe(b.type);
          expect([o!.props!.w, o!.props!.d]).toEqual([SPECS[b.type].w, SPECS[b.type].h]);
        }
      }
    }
  });

  it('every building type draws in every culture (all glyphs registered); bridges draw both ways', () => {
    for (const variant of OBJECT_DEFS.building.variants) for (let t = 0; t < BUILDING_TYPES.length; t++) {
      const o: WorldObject = { id: 1, kind: 'building', x: 10, y: 10, variant, props: { t, w: 5, d: 3, floors: 2 } };
      expect(OBJECT_DEFS.building.sprite(o).length, `${variant} ${BUILDING_TYPES[t]}`).toBeGreaterThan(0);
    }
    for (const dir of [0, 1]) expect(OBJECT_DEFS.span.sprite({ id: 1, kind: 'span', x: 0, y: 0, variant: 'timber', props: { length: 30, dir, z: 5 } }).length).toBeGreaterThan(30);
  });
});

describe('road bridges', { timeout: 300_000 }, () => {
  it('every blueprint bridge has a deck across its river: wet in the middle, dry at both ends, above the water', () => {
    const blueprint = bp.roads.reduce((n, r) => n + r.bridges.length, 0);
    console.log(`bridges: ${ct.bridges.length} of ${blueprint} blueprint crossings; ${ct.bridges.map((b) => `${b.road}/${b.river} ${b.length} m`).join(', ')}`);
    expect(ct.bridges.length).toBe(blueprint);
    for (const b of ct.bridges) {
      const along = (k: number): [number, number] => (b.dir === 0 ? [b.x + k, b.y + 1] : [b.x + 1, b.y + k]);
      const start = cell(...along(0)), end = cell(...along(b.length - 1));
      expect(start.kind, `${b.road}/${b.river} start`).toBe(WK_NONE);
      expect(end.kind, `${b.road}/${b.river} end`).toBe(WK_NONE);
      let wet = 0, top = -Infinity;
      for (let k = 0; k < b.length; k++) { const c = cell(...along(k)); if (c.kind === WK_RIVER) { wet++; top = Math.max(top, c.level); } }
      expect(wet, `${b.road}/${b.river}`).toBeGreaterThan(b.length * 0.3);
      expect(b.z).toBeGreaterThan(top + 1);
      const r = region(Math.floor(b.x / S), Math.floor(b.y / S));
      expect(r.objects.some((o) => o.kind === 'span' && o.x === b.x - r.ox && o.y === b.y - r.oy), `${b.road}/${b.river} object`).toBe(true);
    }
  });
});

describe('villages in the streamed continent', { timeout: 300_000 }, () => {
  it('Lumenfall loads with its buildings and mill placed, and a fresh window has no player changes', () => {
    const { engine, session } = createContinentEngine({ worker: false });
    const kinds = new Map<string, number>();
    for (const o of engine.objects.objects.values()) kinds.set(o.kind, (kinds.get(o.kind) ?? 0) + 1);
    expect(kinds.get('building') ?? 0).toBeGreaterThan(20);
    expect(kinds.get('mill') ?? 0).toBe(1);
    expect(session.collectEdits(engine).size).toBe(0);
  });
});
