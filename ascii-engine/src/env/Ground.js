import * as THREE from 'three';
import { createGlyphSurfaceMaterial } from '../shaders/GlyphSurfaceMaterial.js';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { tint } from './helpers.js';

// Ground / terrain: a heightfield mesh with the ASCII glyph-surface shader (terrain ramp) and a sparse layer of
// glyph points scattered on it (pebbles / debris) for extra depth sparkle. A flat corridor can be reserved for
// streets: flat(x, z) -> 0..1 (1 = fully flat).

export function terrainHeight(x, z, { amp = 2.2, scale = 0.035, seed = 0 } = {}) {
  const s = Math.sin, c = Math.cos;
  const a = s(x * scale * 1.7 + seed) * c(z * scale * 1.3 - seed * 0.7);
  const b = s(x * scale * 3.1 - z * scale * 2.3 + seed * 2.1) * 0.5;
  const d = c(x * scale * 6.7 + z * scale * 5.9) * 0.18;
  return (a + b + d) * amp;
}

export function createGround(engine, o = {}) {
  const opt = {
    size: 220, segments: 180, seed: 3, amp: 2.4, scale: 0.035,
    flat: (x, z) => 0, cell: [0.24, 0.24], color: '#aab4bc', brightness: 1.0, gain: 1.7,
    debris: 9000, debrisColor: '#cfd6de', holes: [], glyphSet: SET.TERRAIN, ...o,
  };
  const geo = new THREE.PlaneGeometry(opt.size, opt.size, opt.segments, opt.segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const heightAt = (x, z) => {
    let h = terrainHeight(x, z, opt) * (1 - opt.flat(x, z)) - 0.02;
    for (const H of opt.holes) {
      const d = Math.hypot(x - H.center[0], z - H.center[1]);
      h -= H.depth * (1 - THREE.MathUtils.smoothstep(d, H.radius * 0.85, H.radius * 1.05));
    }
    return h;
  };
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const mat = createGlyphSurfaceMaterial(engine, {
    glyphSet: opt.glyphSet, cell: opt.cell, color: opt.color, brightness: opt.brightness, gain: opt.gain,
    frag: 0.12, fragScale: 0.09, seed: opt.seed, horizon: 0.025, base: '#040405',
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ground';

  // Debris: glyph points lying on the terrain, denser near the centre.
  const rng = new Rng('debris', opt.seed);
  const b = new ParticleBuilder();
  const n = Math.round(opt.debris * engine.density);
  const col = tint(opt.debrisColor);
  for (let i = 0; i < n; i++) {
    const r = Math.pow(rng.float(), 1.6) * opt.size * 0.22, a = rng.range(0, Math.PI * 2);
    const x = Math.cos(a) * r, z = Math.sin(a) * r - 6;
    if (opt.holes.some((H) => Math.hypot(x - H.center[0], z - H.center[1]) < H.radius * 1.05)) continue;
    b.push({ p: [x, heightAt(x, z) + 0.03, z], n: [0, 1, 0], seed: rng.float(), size: rng.range(0.7, 1.4), bright: rng.range(0.4, 1.0), color: col });
  }
  const debris = makePoints(engine, b, { mode: 'glyph', glyphSet: SET.TERRAIN, size: 0.07, brightness: 0.55, lit: 1, flicker: 0.2, glyphJitter: 0.6 });
  debris.name = 'ground-debris';

  const group = new THREE.Group();
  group.add(mesh, debris);
  return { object: group, mesh, debris, heightAt, material: mat };
}
