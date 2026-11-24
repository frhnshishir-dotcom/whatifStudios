import * as THREE from 'three';
import { createGlyphSurfaceMaterial } from '../shaders/GlyphSurfaceMaterial.js';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { sampleSegment, tint, glowSprite } from './helpers.js';

// Street along Z: asphalt glyph surface, dashed centre line and lane edges as stroke glyphs, curb lines as dense
// dots, and street lamps (glyph-built poles + amber light added to the light rig).

export function createStreet(engine, o = {}) {
  const opt = { width: 7, z0: -60, z1: 12, x: 0, seed: 5, lampColor: '#ffab40', lamps: [], laneColor: '#f2e6cf', ...o };
  const group = new THREE.Group();
  group.name = 'street';
  const len = opt.z1 - opt.z0, zc = (opt.z0 + opt.z1) / 2;

  const asphalt = new THREE.Mesh(
    new THREE.PlaneGeometry(opt.width, len, 1, 1).rotateX(-Math.PI / 2).translate(opt.x, 0.0, zc),
    createGlyphSurfaceMaterial(engine, { glyphSet: SET.RAMP, cell: [0.16, 0.2], color: '#8f979f', gain: 1.2, brightness: 0.85, frag: 0.2, fragScale: 0.25, seed: opt.seed, horizon: 0.03, base: '#030304' }),
  );
  asphalt.name = 'asphalt';
  group.add(asphalt);

  const rng = new Rng('street', opt.seed);
  const b = new ParticleBuilder();
  const DASH = engine.atlas.index('stroke', 'DASH');
  const LINE = engine.atlas.index('stroke', 'LINE');
  const lane = tint(opt.laneColor);
  const dens = engine.density;
  // Centre dashes: 3 m on, 3 m off.
  for (let z = opt.z0; z < opt.z1; z += 6) {
    sampleSegment(b, rng, [opt.x, 0.01, z], [opt.x, 0.01, z + 3], 0.05 / dens, { glyph: DASH, size: 1, bright: 1.1, color: lane, jitter: 0.008, normal: [0, 1, 0] });
  }
  // Lane edges: continuous fine strokes.
  for (const s of [-1, 1]) {
    const x = opt.x + s * (opt.width / 2 - 0.25);
    sampleSegment(b, rng, [x, 0.01, opt.z0], [x, 0.01, opt.z1], 0.07 / dens, { glyph: LINE, size: 0.9, bright: 0.6, color: lane, jitter: 0.01, normal: [0, 1, 0] });
    // Curb: a double line of dots, slightly raised.
    const xc = opt.x + s * (opt.width / 2 + 0.02);
    sampleSegment(b, rng, [xc, 0.12, opt.z0], [xc, 0.12, opt.z1], 0.03 / dens, { size: 0.6, bright: 0.7, jitter: 0.006, normal: [s, 0.3, 0] });
    sampleSegment(b, rng, [xc + s * 0.06, 0.01, opt.z0], [xc + s * 0.06, 0.01, opt.z1], 0.05 / dens, { size: 0.5, bright: 0.45, jitter: 0.01, normal: [0, 1, 0] });
  }
  const marks = makePoints(engine, b, { mode: 'stroke', size: 0.11, brightness: 0.75, lit: 1, flicker: 0.1, glyphMinPx: 4 });
  marks.name = 'street-marks';
  group.add(marks);

  // Lamps.
  const lamps = [];
  const lb = new ParticleBuilder();
  const BAR = engine.atlas.index('mark', 'BAR');
  const lampTint = tint(opt.lampColor);
  for (const L of opt.lamps) {
    const [x, z] = L.at, h = L.height ?? 4.6, arm = L.arm ?? 1.1, dir = L.dir ?? 1;
    sampleSegment(lb, rng, [x, 0, z], [x, h, z], 0.04 / dens, { glyph: BAR, size: 0.8, bright: 0.55, jitter: 0.006 });
    sampleSegment(lb, rng, [x, h, z], [x + arm * dir, h + 0.15, z], 0.035 / dens, { glyph: BAR, size: 0.6, bright: 0.55, jitter: 0.004, tangent: [1, 0, 0] });
    const hx = x + arm * dir, hy = h + 0.05;
    for (let i = 0; i < 260 * dens; i++) {
      const d = rng.dir();
      lb.push({ p: [hx + d[0] * 0.12, hy + d[1] * 0.05, z + d[2] * 0.12], seed: rng.float(), size: 1.2, bright: 3.5, color: lampTint, glyph: -1 });
    }
    const light = engine.lightRig.add({ name: 'lamp', position: [hx, hy - 0.2, z], color: opt.lampColor, intensity: L.intensity ?? 1.6, range: L.range ?? 9 });
    const glow = glowSprite(engine, { color: opt.lampColor, size: 2.2, intensity: 0.35, falloff: 2.5 });
    glow.position.set(hx, hy, z);
    group.add(glow);
    lamps.push({ light, glow, head: [hx, hy, z], base: L });
  }
  if (opt.lamps.length) {
    const lampPts = makePoints(engine, lb, { mode: 'stroke', color: '#d9d2c8', size: 0.06, brightness: 0.8, lit: 0.8, flicker: 0.08, glyphMinPx: 4 });
    lampPts.name = 'street-lamps';
    group.add(lampPts);
  }
  return { object: group, lamps, marks };
}
