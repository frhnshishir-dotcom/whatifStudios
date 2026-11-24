import { describe, it, expect } from 'vitest';
import { World } from '../src/engine/world/World';
import { ObjectStore } from '../src/engine/objects/ObjectStore';
import { WaterSystem } from '../src/engine/water/WaterSystem';
import { Editor } from '../src/engine/edit/Editor';
import { Mat, Cover } from '../src/engine/world/materials';

/** 64 x 64 world sloping down to the south (y), grass, with a main-thread water system. */
function setup(slope = 0.05) {
  const world = new World(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = y * 64 + x;
    world.elev[i] = 10 - y * slope;
    world.mat[i] = Mat.Grass;
    world.cover[i] = Cover.ShortGrass;
  }
  const objects = new ObjectStore(world);
  const water = new WaterSystem(world, { useWorker: false });
  objects.onChange = (x0, y0, x1, y1) => water.terrainChanged(x0, y0, x1, y1);
  const ed = new Editor(world, objects, water);
  const messages: string[] = [];
  ed.onMessage = (m) => messages.push(m);
  return { world, objects, water, ed, messages, at: (x: number, y: number) => y * 64 + x };
}

const snapshot = (w: World) => ({ elev: Float32Array.from(w.elev), mat: Uint8Array.from(w.mat), cover: Uint8Array.from(w.cover) });

describe('editor: terrain tools and undo/redo', () => {
  it('raise lifts a smooth mound while held; undo and redo restore exact states', () => {
    const { world, ed, at } = setup();
    const before = snapshot(world);
    ed.options.radius = 4;
    ed.begin('raise', at(32, 32));
    for (let k = 0; k < 30; k++) ed.tick(1 / 60);
    ed.end();
    const c = world.elev[at(32, 32)] - before.elev[at(32, 32)], e = world.elev[at(35, 32)] - before.elev[at(35, 32)];
    expect(c).toBeGreaterThan(1);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(c);
    expect(world.elev[at(40, 32)]).toBe(before.elev[at(40, 32)]);
    const after = snapshot(world);
    expect(ed.history.size).toBe(1);
    ed.undo();
    expect(world.elev).toEqual(before.elev);
    expect(world.mat).toEqual(before.mat);
    ed.redo();
    expect(world.elev).toEqual(after.elev);
  });

  it('lower digs a basin that collects water poured into it', () => {
    const { world, water, ed, at } = setup(0);
    ed.options.radius = 5;
    ed.begin('lower', at(32, 32));
    for (let k = 0; k < 60; k++) ed.tick(1 / 60);
    ed.end();
    expect(world.elev[at(32, 32)]).toBeLessThan(10 - 2);
    ed.options.waterMode = 'add';
    ed.begin('water', at(32, 32));
    for (let k = 0; k < 30; k++) ed.tick(1 / 60);
    ed.end();
    for (let k = 0; k < 600; k++) water.step(1 / 60);
    // Water settles in the basin: deepest at the centre, none outside the dug area.
    expect(water.view.depth[at(32, 32)]).toBeGreaterThan(0.5);
    expect(water.view.depth[at(32, 44)]).toBeLessThan(0.01);
    // The water brush is not part of the undo history (simulation state); the dig is.
    expect(ed.history.size).toBe(1);
  });

  it('steep new slopes become cliff and undo restores the material', () => {
    const { world, ed, at } = setup(0);
    ed.options.radius = 2; ed.options.strength = 1;
    ed.begin('raise', at(20, 20));
    for (let k = 0; k < 90; k++) ed.tick(1 / 60);
    ed.end();
    let cliffs = 0;
    for (let i = 0; i < world.n; i++) if (world.mat[i] === Mat.Cliff) cliffs++;
    expect(cliffs).toBeGreaterThan(0);
    ed.undo();
    for (let i = 0; i < world.n; i++) expect(world.mat[i]).toBe(Mat.Grass);
  });

  it('terrain brush paints material along a stroke; plant brush and eraser change cover', () => {
    const { world, ed, at } = setup();
    ed.options.radius = 2; ed.options.material = Mat.Path;
    ed.begin('terrain', at(10, 10)); ed.drag(at(20, 10)); ed.end();
    for (let x = 10; x <= 20; x++) expect(world.mat[at(x, 10)]).toBe(Mat.Path);
    expect(world.mat[at(15, 14)]).toBe(Mat.Grass);
    ed.options.cover = Cover.Flowers; ed.options.strength = 1;
    ed.begin('flowers', at(40, 40)); ed.end();
    expect(world.cover[at(40, 40)]).toBe(Cover.Flowers);
    ed.begin('eraser', at(40, 40)); ed.end();
    expect(world.cover[at(40, 40)]).toBe(Cover.None);
    expect(ed.history.size).toBe(3);
    ed.undo(); expect(world.cover[at(40, 40)]).toBe(Cover.Flowers);
    ed.undo(); expect(world.cover[at(40, 40)]).toBe(Cover.ShortGrass);
    ed.undo(); expect(world.mat[at(15, 10)]).toBe(Mat.Grass);
    expect(ed.history.canUndo).toBe(false);
    expect(ed.history.canRedo).toBe(true);
  });

  it('a new edit clears the redo stack', () => {
    const { ed, at } = setup();
    ed.begin('terrain', at(5, 5)); ed.end();
    ed.undo();
    expect(ed.history.canRedo).toBe(true);
    ed.begin('terrain', at(9, 9)); ed.end();
    expect(ed.history.canRedo).toBe(false);
  });
});

describe('editor: objects, selection and deletion', () => {
  it('places, refuses overlaps with a message, and undo/redo keep ids', () => {
    const { objects, ed, messages, at } = setup();
    ed.options.variants.rock = 'boulder';
    ed.begin('rock', at(10, 10)); ed.end();
    expect(objects.count('rock')).toBe(1);
    const id = [...objects.objects.keys()][0];
    ed.begin('rock', at(10, 10)); ed.end();
    expect(objects.count('rock')).toBe(1);
    expect(messages.at(-1)).toMatch(/occupied/);
    ed.undo();
    expect(objects.count()).toBe(0);
    ed.redo();
    expect(objects.objects.has(id)).toBe(true);
  });

  it('dragging the tree tool scatters several trees as one undo step', () => {
    const { objects, ed, at } = setup();
    ed.options.radius = 3;
    ed.begin('tree', at(5, 30));
    for (let x = 6; x <= 50; x++) ed.drag(at(x, 30));
    ed.end();
    expect(objects.count('tree')).toBeGreaterThan(6);
    expect(ed.history.size).toBe(1);
    ed.undo();
    expect(objects.count('tree')).toBe(0);
  });

  it('a cottage levels the ground under it; undo restores ground and removes it', () => {
    const { world, objects, ed, at } = setup(0.3);
    const before = snapshot(world);
    ed.begin('cottage', at(30, 30)); ed.end();
    expect(objects.count('cottage')).toBe(1);
    const o = [...objects.objects.values()][0];
    const z = world.elev[at(o.x, o.y)];
    for (const [x, y] of objects.footprint(o)) expect(world.elev[at(x, y)]).toBeCloseTo(z, 5);
    expect(world.solid[at(o.x + 1, o.y + 1)]).toBe(1);
    ed.undo();
    expect(objects.count()).toBe(0);
    expect(world.elev).toEqual(before.elev);
    expect(world.solid[at(o.x + 1, o.y + 1)]).toBe(0);
  });

  it('buildings need dry ground', () => {
    const { water, ed, objects, messages, at } = setup(0);
    water.addWater(30, 30, 4, 50 * 0.5);
    ed.begin('cottage', at(30, 30)); ed.end();
    expect(objects.count()).toBe(0);
    expect(messages.at(-1)).toMatch(/dry ground/);
  });

  it('select + drag moves an object (one Move step); Delete removes it; undo brings it back', () => {
    const { objects, ed, at } = setup();
    ed.options.variants.rock = 'boulder';
    ed.begin('rock', at(10, 10)); ed.end();
    const id = [...objects.objects.keys()][0];
    let shown: unknown = null;
    ed.onSelect = (o) => { shown = o; };
    ed.begin('select', at(10, 10));
    expect(ed.selectedId).toBe(id);
    ed.drag(at(12, 11)); ed.drag(at(14, 12));
    ed.end();
    expect(objects.objects.get(id)).toMatchObject({ x: 14, y: 12 });
    expect(shown).toMatchObject({ id, x: 14, y: 12 });
    ed.undo();
    expect(objects.objects.get(id)).toMatchObject({ x: 10, y: 10 });
    ed.select(id);
    expect(ed.deleteSelected()).toBe(true);
    expect(objects.count()).toBe(0);
    expect(ed.selectedId).toBe(0);
    ed.undo();
    expect(objects.objects.get(id)).toMatchObject({ x: 10, y: 10 });
  });

  it('inspector edits change variant and props; a quick series is one undo step', () => {
    const { objects, ed, at } = setup();
    ed.options.variants.tree = 'oak'; ed.options.treeSize = 1;
    ed.begin('tree', at(20, 20)); ed.end();
    const id = [...objects.objects.keys()][0];
    expect(ed.editObject(id, { variant: 'pine' })).toBe(true);
    ed.editObject(id, { props: { size: 2 } });
    ed.editObject(id, { props: { size: 3 } });
    expect(objects.objects.get(id)).toMatchObject({ variant: 'pine', props: { size: 3 } });
    expect(ed.history.size).toBe(2); // place + one coalesced edit
    ed.undo();
    expect(objects.objects.get(id)).toMatchObject({ variant: 'oak', props: { size: 1 } });
  });

  it('eraser removes objects and sources in the brush as one step', () => {
    const { objects, ed, water, at } = setup();
    ed.options.variants.rock = 'boulder';
    ed.begin('rock', at(30, 30)); ed.end();
    ed.begin('tree', at(32, 31)); ed.end();
    ed.begin('source', at(29, 32)); ed.end();
    expect(water.view.source[at(29, 32)]).toBeGreaterThan(0);
    ed.options.radius = 4;
    ed.begin('eraser', at(30, 31)); ed.end();
    expect(objects.count()).toBe(0);
    expect(ed.sources.size).toBe(0);
    expect(water.view.source[at(29, 32)]).toBe(0);
    ed.undo();
    expect(objects.count()).toBe(2);
    expect(ed.sources.size).toBe(1);
  });
});

describe('editor: water tools', () => {
  it('clicking open water with the select tool makes ripples (and selects nothing)', () => {
    const { ed, water, at } = setup(0);
    water.addWater(30, 30, 6, 6 * 6 * Math.PI * 0.8);
    for (let k = 0; k < 60; k++) water.step(1 / 60);
    ed.begin('select', at(30, 30)); ed.end();
    expect(ed.selectedId).toBe(0);
    for (let k = 0; k < 10; k++) water.step(1 / 60);
    let energy = 0;
    for (let i = 0; i < 64 * 64; i++) energy += Math.abs(water.view.ripple[i]);
    expect(energy).toBeGreaterThan(0.5);
    expect(ed.history.size).toBe(0);
  });

  it('source and drain toggle on click and are undoable', () => {
    const { ed, water, at } = setup();
    ed.options.rate = 4;
    ed.begin('source', at(10, 10)); ed.end();
    expect(water.view.source[at(10, 10)]).toBe(4);
    ed.begin('source', at(11, 10)); ed.end(); // within one cell: removes it
    expect(water.view.source[at(10, 10)]).toBe(0);
    ed.begin('drain', at(40, 40)); ed.end();
    expect(water.view.drain[at(40, 40)]).toBe(4);
    ed.undo(); expect(water.view.drain[at(40, 40)]).toBe(0);
    ed.undo(); expect(water.view.source[at(10, 10)]).toBe(4);
  });

  it('a channel dragged downhill has a non-rising bed and carries water from a source to its end', () => {
    const { world, ed, water, at } = setup(0.04);
    ed.options.radius = 2; ed.options.depth = 1.2;
    ed.begin('channel', at(32, 4));
    for (let y = 5; y <= 60; y++) ed.drag(at(32 + Math.round(Math.sin(y / 9) * 6), y));
    ed.end();
    let prev = Infinity;
    for (let y = 4; y <= 60; y++) {
      const x = 32 + Math.round(Math.sin(y / 9) * 6);
      const e = world.elev[at(x, y)];
      expect(e).toBeLessThanOrEqual(prev + 1e-4);
      prev = Math.min(prev, e);
    }
    ed.begin('source', at(32, 4)); ed.end();
    for (let k = 0; k < 1500; k++) water.step(1 / 60);
    const xEnd = 32 + Math.round(Math.sin(58 / 9) * 6);
    expect(water.view.depth[at(xEnd, 58)]).toBeGreaterThan(0.05);
    // ...and stays in the channel (dry 6 cells to the side).
    expect(water.view.depth[at(xEnd + 7, 40)]).toBeLessThan(0.01);
  });

  it('the waterfall tool drops the bed downstream and water pours over the new lip', () => {
    const { world, ed, water, at } = setup(0.03);
    ed.options.radius = 2; ed.options.depth = 1;
    ed.begin('channel', at(32, 2));
    for (let y = 3; y <= 63; y++) ed.drag(at(32, y));
    ed.end();
    ed.begin('source', at(32, 3)); ed.end();
    for (let k = 0; k < 900; k++) water.step(1 / 60);
    const lip = world.elev[at(32, 30)], below = world.elev[at(32, 36)];
    ed.options.drop = 3;
    ed.begin('waterfall', at(32, 30)); ed.end();
    expect(world.elev[at(32, 36)]).toBeLessThan(below - 2.5);
    expect(world.elev[at(32, 29)]).toBeCloseTo(lip - 0.03, 0);
    expect(world.mat[at(32, 30)]).toBe(Mat.Stone);
    for (let k = 0; k < 600; k++) water.step(1 / 60);
    let fall = 0;
    for (let y = 28; y <= 33; y++) for (let x = 30; x <= 34; x++) fall = Math.max(fall, water.view.fall[at(x, y)]);
    expect(fall).toBeGreaterThan(0.1);
    expect(ed.history.size).toBe(3);
  });

  it('a bridge spans the water under the click with its deck above the surface', () => {
    const { world, objects, ed, water, at } = setup(0);
    // A 6-cell wide ditch along y with water in it.
    for (let y = 0; y < 64; y++) for (let x = 29; x <= 34; x++) world.elev[at(x, y)] = 8.5;
    water.terrainChanged(0, 0, 63, 63);
    for (let y = 2; y < 62; y += 4) water.addWater(31.5, y, 3, 20);
    for (let k = 0; k < 300; k++) water.step(1 / 60);
    ed.begin('bridge', at(31, 20)); ed.end();
    const b = [...objects.objects.values()].find((o) => o.kind === 'bridge')!;
    expect(b.x).toBeLessThanOrEqual(29);
    expect(b.x + b.props.length - 1).toBeGreaterThanOrEqual(34);
    expect(b.props.z).toBeGreaterThan(8.5 + water.view.depth[at(31, 20)]);
  });
});
