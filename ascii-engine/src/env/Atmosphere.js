import * as THREE from 'three';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { tint } from './helpers.js';

// Atmospheric particles that move entirely in the vertex shader (DRIFT: wrap inside a box, so they never run
// out): floating dust lit by the scene lights, rising embers, and slowly falling code glyphs.

function boxCloud(engine, rng, count, center, box, opts) {
  const b = new ParticleBuilder();
  const n = Math.round(count * engine.density);
  for (let i = 0; i < n; i++) {
    b.push({
      p: [center[0] + rng.range(-0.5, 0.5) * box[0], center[1] + rng.range(-0.5, 0.5) * box[1], center[2] + rng.range(-0.5, 0.5) * box[2]],
      seed: rng.float(), size: rng.range(0.5, 1.5), bright: rng.range(0.3, 1.2), color: opts.colorFn ? opts.colorFn(rng) : [1, 1, 1],
      glyph: opts.glyph ?? -1,
    });
  }
  return b;
}

export function createAtmosphere(engine, o = {}) {
  const group = new THREE.Group();
  group.name = 'atmosphere';
  const rng = new Rng('atmo', o.seed ?? 1);
  const layers = {};

  if (o.dust !== false) {
    const d = { count: 5000, center: [0, 3, -4], box: [18, 7, 26], vel: [0.05, 0.02, 0.03], color: '#c9d2dc', size: 0.012, brightness: 0.32, ...(o.dust || {}) };
    layers.dust = makePoints(engine, boxCloud(engine, rng, d.count, d.center, d.box, {}), {
      mode: 'dot', color: d.color, size: d.size, brightness: d.brightness, lit: 1, flicker: 0.35,
      drift: { vel: d.vel, box: d.box, center: d.center },
    });
  }
  if (o.embers) {
    const e = { count: 900, center: [0, 3, -8], box: [5, 7, 5], vel: [0.02, 0.35, 0.01], color: '#ff7a2a', color2: '#ffc070', size: 0.016, brightness: 1.3, ...o.embers };
    const c1 = tint(e.color), c2 = tint(e.color2);
    layers.embers = makePoints(engine, boxCloud(engine, rng, e.count, e.center, e.box, { colorFn: (r) => (r.chance(0.3) ? c2 : c1) }), {
      mode: 'dot', color: '#ffffff', size: e.size, brightness: e.brightness, lit: 0.2, flicker: 0.6,
      drift: { vel: e.vel, box: e.box, center: e.center },
    });
  }
  if (o.code) {
    const c = { count: 260, center: [0, 5, -10], box: [22, 10, 22], vel: [0, -0.18, 0], color: '#9fb2c0', size: 0.08, brightness: 0.28, ...o.code };
    layers.code = makePoints(engine, boxCloud(engine, rng, c.count, c.center, c.box, {}), {
      mode: 'glyph', glyphSet: SET.CODE, color: c.color, size: c.size, brightness: c.brightness, lit: 0.7, flicker: 0.5, glyphJitter: 1.0,
      drift: { vel: c.vel, box: c.box, center: c.center },
    });
  }
  for (const [k, v] of Object.entries(layers)) { v.name = `atmo-${k}`; group.add(v); }
  return { object: group, layers };
}
