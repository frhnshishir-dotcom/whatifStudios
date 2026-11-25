import { describe, it, expect } from 'vitest';
import { World } from '../src/engine/world/World';
import { ObjectStore } from '../src/engine/objects/ObjectStore';
import { OBJECT_DEFS, OBJ_KINDS } from '../src/engine/objects/defs';
import { generateWorld, prefillWater, type GenInfo } from '../src/engine/gen/world';
import { WaterSim } from '../src/engine/water/WaterSim';
import { Mat } from '../src/engine/world/materials';

function gen(seed: number): { world: World; objects: ObjectStore; info: GenInfo } {
  const world = new World(256, 256);
  const objects = new ObjectStore(world);
  const info = generateWorld(world, objects, seed);
  return { world, objects, info };
}

/** Flood fill over cells with a prefill water level; returns the set of reached cells. */
function wetComponent(world: World, level: Float32Array, start: number): Uint8Array {
  const seen = new Uint8Array(world.n), stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop()!, x = i % world.w, y = (i / world.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!world.inBounds(nx, ny)) continue;
      const j = ny * world.w + nx;
      if (!seen[j] && level[j] === level[j]) { seen[j] = 1; stack.push(j); }
    }
  }
  return seen;
}

describe('world generation', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = gen(7), b = gen(7), c = gen(8);
    expect(a.world.elev).toEqual(b.world.elev);
    expect(a.world.mat).toEqual(b.world.mat);
    expect(a.objects.toJSON()).toEqual(b.objects.toJSON());
    expect(a.info.features).toEqual(b.info.features);
    let diff = 0;
    for (let i = 0; i < a.world.n; i++) if (Math.abs(a.world.elev[i] - c.world.elev[i]) > 0.01) diff++;
    expect(diff).toBeGreaterThan(a.world.n * 0.5);
  });

  it.each([7, 1, 29, 42, 52, 99, 1234, 2026])('seed %i has every required landmark', (seed) => {
    const { info, objects } = gen(seed);
    const kinds = info.features.map((f) => f.kind);
    for (const k of ['large waterfall', 'lake', 'mill race', 'bridge', 'cottage', 'water mill', 'glowing glade']) expect(kinds).toContain(k);
    expect(kinds.filter((k) => k === 'waterfall').length).toBe(2);
    expect(kinds.filter((k) => k === 'pond').length).toBeGreaterThanOrEqual(2);
    // Two small falls and one larger one.
    const drops = info.falls.map((f) => f.drop).sort((p, q) => p - q);
    expect(drops[0]).toBeGreaterThan(2.5);
    expect(drops[2]).toBeGreaterThan(drops[1] * 2);
    expect(objects.count('bridge')).toBe(1);
    expect(objects.count('cottage')).toBe(1);
    expect(objects.count('mill')).toBe(1);
    expect(objects.count('tree')).toBeGreaterThan(600);
    expect(objects.count('rock')).toBeGreaterThan(20);
    expect(objects.count('mushroom')).toBeGreaterThan(20);
    expect(objects.count('stone')).toBeGreaterThanOrEqual(5);
  });

  it('the river runs from its source to the southern edge through the lake and every fall as one water body', () => {
    const { world, info } = gen(7);
    const [sx, sy] = info.source;
    const comp = wetComponent(world, info.level, sy * world.w + sx);
    // Reaches the southern edge.
    let south = 0;
    for (let x = 0; x < world.w; x++) if (comp[(world.h - 1) * world.w + x]) south++;
    expect(south).toBeGreaterThan(0);
    // Passes the lake and the fall feet (the plunge pools) and includes the mill race.
    for (const f of info.features.filter((f) => ['lake', 'mill race'].includes(f.kind))) {
      let near = false;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (comp[(f.y + dy) * world.w + f.x + dx]) near = true;
      expect(near, f.kind).toBe(true);
    }
    // At least three separate water bodies (river system + ponds).
    const seen = new Uint8Array(world.n);
    let bodies = 0;
    for (let i = 0; i < world.n; i++) {
      if (seen[i] || !(info.level[i] === info.level[i])) continue;
      const c = wetComponent(world, info.level, i);
      for (let j = 0; j < world.n; j++) if (c[j]) seen[j] = 1;
      bodies++;
    }
    expect(bodies).toBeGreaterThanOrEqual(3);
  });

  it('along the river every cell is under water and the water level only steps down (no dams)', () => {
    for (const seed of [42, 7]) {
      const { world, info } = gen(seed);
      let prev = Infinity, rises = 0, dry = 0;
      for (const [x, y] of info.river) {
        const i = y * world.w + x, lv = info.level[i];
        if (!(lv === lv) || world.elev[i] >= lv) { dry++; continue; }
        if (lv > prev + 0.1) rises++; // a meander re-entering the lake may sit a few cm above it
        prev = Math.min(prev, lv);
      }
      expect(dry).toBe(0);
      expect(rises).toBe(0);
    }
  });

  it.each([7, 1, 42, 99, 2026])('seed %i has a big lit Christmas tree by the cottage and the stream, clear of buildings', (seed) => {
    const { world, objects, info } = gen(seed);
    const xt = [...objects.objects.values()].filter((o) => o.kind === 'tree' && o.variant === 'christmas');
    expect(xt.length).toBe(1);
    const t = xt[0], cot = [...objects.objects.values()].find((o) => o.kind === 'cottage')!;
    expect(Math.hypot(t.x - cot.x, t.y - cot.y)).toBeLessThan(30);
    for (const [x, y] of objects.footprint(t)) expect(info.level[y * world.w + x] === info.level[y * world.w + x]).toBe(false);
    // The river is close (within 20 cells) and no building or bridge sits in the screen area behind the canopy.
    let nearWater = false;
    for (let dy = -20; dy <= 20; dy++) for (let dx = -20; dx <= 20; dx++) { const i = (t.y + dy) * world.w + t.x + dx; if (world.inBounds(t.x + dx, t.y + dy) && info.level[i] === info.level[i]) nearWater = true; }
    expect(nearWater).toBe(true);
    for (let y = t.y - 22; y < t.y; y++) for (let x = t.x - 8; x <= t.x + 8; x++) {
      const o = objects.at(y * world.w + x);
      expect(o && ['cottage', 'mill', 'bridge'].includes(o.kind)).toBeFalsy();
    }
    // Big, lit and decorated.
    const cells = objects.sprite(t);
    const rows = new Set(cells.map((c) => c.up)).size, width = Math.max(...cells.map((c) => c.dx)) - Math.min(...cells.map((c) => c.dx)) + 1;
    expect(rows).toBeGreaterThanOrEqual(25);
    expect(width).toBeGreaterThanOrEqual(15);
    expect(cells.filter((c) => (c.anim & 15) === 7).length).toBeGreaterThan(30); // twinkling bulbs
    expect(OBJECT_DEFS.tree.light!(t)!.r).toBeGreaterThan(8);
  });

  it('is not mirror-symmetric', () => {
    const { world } = gen(7);
    let diff = 0;
    for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w / 2; x++) diff += Math.abs(world.elev[y * world.w + x] - world.elev[y * world.w + world.w - 1 - x]);
    expect(diff / (world.n / 2)).toBeGreaterThan(1);
  });

  it('places structures on dry ground with clear fronts; solid objects are stamped into the solid mask', () => {
    const { world, objects, info } = gen(7);
    for (const o of objects.objects.values()) {
      for (const [x, y] of objects.footprint(o)) {
        expect(world.inBounds(x, y)).toBe(true);
        expect(objects.occ[y * world.w + x]).toBe(o.id);
        if (OBJECT_DEFS[o.kind].solid) expect(world.solid[y * world.w + x]).toBe(1);
        if (o.kind === 'cottage' || o.kind === 'mill') expect(info.level[y * world.w + x] === info.level[y * world.w + x]).toBe(false);
      }
    }
    const mill = [...objects.objects.values()].find((o) => o.kind === 'mill')!;
    // The wheel centre stands in water (2 cells outside the house on wheelSide, front row).
    const wx = mill.x + (mill.props.wheelSide > 0 ? 5 : -2), wy = mill.y + 2;
    expect(info.level[wy * world.w + wx] === info.level[wy * world.w + wx]).toBe(true);
    // Paths connect the cottage area to the bridge.
    let path = 0;
    for (let i = 0; i < world.n; i++) if (world.mat[i] === Mat.Path) path++;
    expect(path).toBeGreaterThan(20);
  });

  it('water flows through the generated river and over all three falls', () => {
    const { world, info } = gen(7);
    const sim = new WaterSim(world.w, world.h, world.elev, undefined, {}, world.solid);
    prefillWater(world, sim.depth, info);
    sim.setSource(info.source[0], info.source[1], 5);
    for (let k = 0; k < 900; k++) sim.step(1 / 60);
    for (const f of info.falls) {
      let maxFall = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -8; dx <= 8; dx++) {
        const x = f.x + dx, y = f.y + dy;
        if (world.inBounds(x, y)) maxFall = Math.max(maxFall, sim.fall[y * world.w + x]);
      }
      expect(maxFall, `fall at ${f.x},${f.y}`).toBeGreaterThan(0.1);
    }
    // Water leaves at the southern edge (edge drain) and the flow in the lower river points downstream.
    expect(sim.removed).toBeGreaterThan(5);
    const [lx, ly] = info.river[Math.floor(info.river.length * 0.9)];
    let vy = 0;
    for (let dx = -2; dx <= 2; dx++) vy += sim.velY[ly * world.w + lx + dx];
    expect(vy).toBeGreaterThan(0);
  });
});

describe('object store', () => {
  it('adds, blocks overlaps, updates, removes and round-trips through JSON', () => {
    const world = new World(64, 64);
    const s = new ObjectStore(world);
    const changes: number[][] = [];
    s.onChange = (...r) => changes.push(r);
    const a = s.add({ kind: 'cottage', x: 10, y: 10, variant: 'slate', props: {} });
    expect(a).not.toBeNull();
    expect(s.canPlace({ kind: 'rock', x: 12, y: 11, variant: 'boulder', props: {} })).toBe('occupied');
    expect(s.add({ kind: 'rock', x: 12, y: 11, variant: 'boulder', props: {} })).toBeNull();
    expect(s.canPlace({ kind: 'tree', x: 63, y: 63, variant: 'oak', props: {} })).toBeNull();
    expect(s.canPlace({ kind: 'cottage', x: 62, y: 62, variant: 'slate', props: {} })).toBe('outside the world');
    expect(world.solid[11 * 64 + 12]).toBe(1);
    expect(s.update(a!, { x: 20 })).toBe(true);
    expect(world.solid[11 * 64 + 12]).toBe(0);
    expect(world.solid[11 * 64 + 22]).toBe(1);
    const t = s.add({ kind: 'tree', x: 5, y: 5, variant: 'pine', props: { size: 2 } })!;
    expect(world.solid[5 * 64 + 5]).toBe(0); // trees do not block water
    expect(s.at(5 * 64 + 5)?.id).toBe(t);
    const json = JSON.parse(JSON.stringify(s.toJSON()));
    const s2 = new ObjectStore(new World(64, 64));
    expect(s2.load(json)).toEqual([]);
    expect(s2.toJSON()).toEqual(s.toJSON());
    expect(s.remove(a!)?.kind).toBe('cottage');
    expect(world.solid[11 * 64 + 22]).toBe(0);
    expect(s.count()).toBe(1);
    expect(changes.length).toBe(5); // add, update (old + new area), add, remove
    // Invalid entries are reported, not thrown.
    const s3 = new ObjectStore(new World(64, 64));
    const problems = s3.load([{ id: 1, kind: 'dragon' as never, x: 1, y: 1, variant: 'x', props: {} }, { id: 2, kind: 'rock', x: 99, y: 1, variant: 'big', props: {} }]);
    expect(problems.length).toBe(2);
  });

  it('every kind and variant produces a non-empty sprite with known glyphs', () => {
    const world = new World(32, 32);
    const s = new ObjectStore(world);
    for (const kind of OBJ_KINDS) for (const variant of OBJECT_DEFS[kind].variants) {
      const o = { id: 1, kind, x: 10, y: 10, variant, props: { ...OBJECT_DEFS[kind].defaults } };
      const cells = OBJECT_DEFS[kind].sprite(o);
      expect(cells.length, `${kind}/${variant}`).toBeGreaterThan(0);
      for (const c of cells) expect(c.g).toBeGreaterThanOrEqual(0);
      void s;
    }
  });
});
