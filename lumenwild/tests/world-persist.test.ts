import { describe, it, expect } from 'vitest';
import { WORLD } from '../src/world/data';
import { createContinentEngine } from '../src/boot';
import { Mat, Cover } from '../src/engine/world/materials';
import { buildContinentSave, validateContinentSave, worldFingerprint } from '../src/world/continentSave';
import { validateSave } from '../src/persist/format';
import type { Engine } from '../src/engine/Engine';
import type { ContinentSession } from '../src/world/session';
import type { MapPt } from '../src/world/schema';

/**
 * Persistent continent data: changes survive their region leaving the window and coming back, and a save made
 * anywhere loads back to the same ground, objects, ponds and sources.
 */
const START: MapPt = [560, 560]; // Heartlands, dry rolling ground
const S = 256;

function make(at: MapPt = START) {
  const r = createContinentEngine({ worker: false, at });
  r.session.prefetchRing = false;
  r.engine.cam.setViewport(1440, 900);
  return r;
}
const simOf = (e: Engine) => (e.water as unknown as { sim: { depth: Float32Array; step(dt: number): void } }).sim;
const objKey = (o: { kind: string; x: number; y: number; variant: string; props: Record<string, number> }) => `${o.kind}:${o.x},${o.y}:${o.variant}:${JSON.stringify(o.props)}`;
const objectSet = (e: Engine) => [...e.objects.objects.values()].map(objKey).sort();

/** A dry, flat-ish spot without objects in the centre region, as window cell (x, y). */
function drySpot(engine: Engine, session: ContinentSession, nearX: number, nearY: number): [number, number] {
  const W = session.win.W;
  for (let r = 0; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = nearX + dx, y = nearY + dy, i = y * W + x;
    let ok = true;
    for (let q = -3; q <= 3 && ok; q++) for (let p = -3; p <= 3; p++) { const k = (y + q) * W + x + p; if (session.win.waterKind[k] !== 0 || engine.world.solid[k] || engine.objects.at(k)) { ok = false; break; } }
    if (ok && engine.world.mat[i] !== Mat.Path) return [x, y];
  }
  throw new Error('no dry spot');
}

/** Make a set of changes in the centre region (window slot 1,1). */
function editCentre(engine: Engine, session: ContinentSession) {
  const W = session.win.W, w = engine.world;
  const [x, y] = drySpot(engine, session, S + 128, S + 128);
  // Ground: raise a 5 x 5 mound, pave it, clear the cover, add magic.
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const i = (y + dy) * W + x + dx; w.elev[i] += 2.5; w.mat[i] = Mat.Path; w.cover[i] = Cover.None; w.magic[i] = 200; }
  // Objects: remove one generated tree in the centre region, add a rock and a cottage.
  const tree = [...engine.objects.objects.values()].find((o) => o.kind === 'tree' && o.x >= S && o.x < 2 * S && o.y >= S && o.y < 2 * S)!;
  engine.objects.remove(tree.id);
  const [rx, ry] = drySpot(engine, session, x + 20, y);
  const rock = engine.objects.add({ kind: 'rock', x: rx, y: ry, variant: 'big', props: { moss: 1 } });
  const [cx, cy] = drySpot(engine, session, x - 20, y + 10);
  const cottage = engine.objects.add({ kind: 'cottage', x: cx, y: cy, variant: 'slate', props: {} });
  // Water: a pond on dry ground, and a player source.
  const [px, py] = drySpot(engine, session, x, y + 24);
  const d = simOf(engine).depth;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) d[(py + dy) * W + px + dx] = 0.4;
  const [sx, sy] = drySpot(engine, session, x + 8, y - 20);
  engine.editor.setSourceDirect('source', sx, sy, 0.5);
  return { mound: [x, y], tree, rock, cottage, pond: [px, py], source: [sx, sy] };
}

describe('persistent continent data', { timeout: 300_000 }, () => {
  it('an untouched window has no changes (generation is the reference)', () => {
    const { engine, session } = make();
    const edits = session.collectEdits(engine);
    expect(edits.size, [...edits.regions.keys()].join(' ')).toBe(0);
  });

  it('changes survive their region leaving the window and coming back', () => {
    const { engine, session } = make();
    const W = session.win.W, ed = editCentre(engine, session);
    const before = { elev: engine.world.elev.slice(), mat: engine.world.mat.slice(), cover: engine.world.cover.slice(), magic: engine.world.magic.slice(), objects: objectSet(engine), depth: simOf(engine).depth.slice(), sources: [...engine.editor.sources] };
    // Two regions east (the edited region leaves), then two west (it comes back to the same slot).
    session.moveWindow(engine, 1, 0);
    session.moveWindow(engine, 1, 0);
    expect(session.edits.size).toBeGreaterThan(0);
    session.moveWindow(engine, -1, 0);
    session.moveWindow(engine, -1, 0);
    let diffs = 0;
    for (let k = 0; k < W * W; k++) {
      if (engine.world.mat[k] !== before.mat[k] || engine.world.cover[k] !== before.cover[k] || engine.world.magic[k] !== before.magic[k] || Math.abs(engine.world.elev[k] - before.elev[k]) > 1e-3) diffs++;
    }
    expect(diffs).toBe(0);
    expect(objectSet(engine)).toEqual(before.objects);
    const [px, py] = ed.pond, d = simOf(engine).depth;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) expect(d[(py + dy) * W + px + dx]).toBeCloseTo(0.4, 5);
    expect([...engine.editor.sources]).toEqual(before.sources);
    expect(engine.editor.sources.get(ed.source[1] * W + ed.source[0])).toBe(0.5);
  });

  it('a save made anywhere loads back to the same ground, objects, ponds and sources', () => {
    const { engine, session } = make();
    editCentre(engine, session);
    // Walk away (the edited region is stored, not loaded) and save from there.
    session.moveWindow(engine, 0, 1);
    session.moveWindow(engine, 0, 1);
    const here = session.mapOf(S + 128, S + 128);
    const save = buildContinentSave({ name: 'Test', seed: WORLD.world.seed, data: WORLD, at: here, zoom: engine.cam.zoomIndex, env: engine.env.state(), edits: session.collectEdits(engine) });
    const text = JSON.stringify(save);
    console.log(`continent save: ${save.stats.regions} regions, ${save.stats.cells} changed cells, ${(text.length / 1024).toFixed(1)} KB`);
    expect(text.length).toBeLessThan(200_000);
    const v = validateContinentSave(text, WORLD, S);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([]);
    // Load into a new engine at the start (where the edits are) and compare with the original after going back.
    const b = createContinentEngine({ worker: false, at: START, edits: v.edits });
    session.moveWindow(engine, 0, -1);
    session.moveWindow(engine, 0, -1);
    expect(b.session.win.origin).toEqual(session.win.origin);
    const W = session.win.W;
    let diffs = 0;
    for (let k = 0; k < W * W; k++) if (b.engine.world.mat[k] !== engine.world.mat[k] || Math.abs(b.engine.world.elev[k] - engine.world.elev[k]) > 1e-3 || b.engine.world.magic[k] !== engine.world.magic[k]) diffs++;
    expect(diffs).toBe(0);
    expect(objectSet(b.engine)).toEqual(objectSet(engine));
    expect([...b.engine.editor.sources]).toEqual([...engine.editor.sources]);
    let pondA = 0, pondB = 0;
    const da = simOf(engine).depth, db = simOf(b.engine).depth;
    for (let k = 0; k < W * W; k++) if (session.win.waterKind[k] === 0) { pondA += da[k]; pondB += db[k]; }
    expect(pondB).toBeCloseTo(pondA, 3);
  });

  it('loading in place: jump elsewhere and back with the saved changes', () => {
    const { engine, session } = make();
    editCentre(engine, session);
    const edits = session.collectEdits(engine), objects = objectSet(engine), mat = engine.world.mat.slice();
    session.loadAt(engine, [250, 860]); // Golden Plains, far away
    expect(engine.world.w).toBe(768);
    session.loadAt(engine, START, edits);
    expect(objectSet(engine)).toEqual(objects);
    let diffs = 0;
    for (let k = 0; k < mat.length; k++) if (engine.world.mat[k] !== mat[k]) diffs++;
    expect(diffs).toBe(0);
  });

  it('continent and Valley saves cannot be confused; a different world version is reported', () => {
    const { engine, session } = make();
    const save = buildContinentSave({ name: 'X', seed: 1, data: WORLD, at: START, zoom: 4, env: engine.env.state(), edits: session.collectEdits(engine) });
    expect(validateSave(save).ok).toBe(false);
    const valley = { format: 'lumenwild', version: 1, terrain: {} };
    const v1 = validateContinentSave(valley, WORLD, S);
    expect(v1.ok).toBe(false);
    expect(v1.errors.join(' ')).toMatch(/Valley/);
    const v2 = validateContinentSave({ ...save, fingerprint: 'deadbeef' }, WORLD, S);
    expect(v2.ok).toBe(true);
    expect(v2.warnings.join(' ')).toMatch(/different version/);
    expect(worldFingerprint(WORLD)).toBe(save.fingerprint);
    // Malformed region data is skipped with a warning, not applied.
    const v3 = validateContinentSave({ ...save, edits: { '1,2': { idx: 'AAAA', elev: 'x' } } }, WORLD, S);
    expect(v3.ok).toBe(true);
    expect(v3.edits!.size).toBe(0);
    expect(v3.warnings.join(' ')).toMatch(/Region 1,2/);
  });
});
