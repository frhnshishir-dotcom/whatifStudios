import * as THREE from 'three';
import { createGlyphSurfaceMaterial } from '../shaders/GlyphSurfaceMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';

// Pond: a dark rippling glyph surface (sparse pale-blue dashes drifting with the water) and a ring of rocks built
// from glyph-surface stones. It also sets engine.shared.uWater, which every particle layer reads: layers below
// the surface dim out, and addReflection(engine, layer) mirrors a layer into the pond with ripples.
// Pair it with createGround({ holes: [{ center, radius, depth }] }) so reflections are not hidden by the ground.

export function createPond(engine, o = {}) {
  const opt = { center: [0, 0], radius: 3, level: 0.02, color: '#8aa1b6', rockColor: '#9fb6d6', rocks: 16, seed: 2, ...o };
  const [cx, cz] = opt.center;
  engine.shared.uWater.value.set(cx, opt.level, cz, opt.radius);
  const group = new THREE.Group();
  group.name = 'pond';

  const surface = new THREE.Mesh(
    new THREE.CircleGeometry(opt.radius * 1.02, 72).rotateX(-Math.PI / 2).translate(cx, opt.level, cz),
    createGlyphSurfaceMaterial(engine, {
      glyphSet: SET.TILE, cell: [0.16, 0.1], color: opt.color, brightness: 0.75, gain: 1.4, jitter: 0.5,
      frag: 0.5, fragScale: 0.35, fragSpeed: 0.4, seed: opt.seed, base: '#020203', emissive: 0.08, hueMix: 0.8,
      ripple: true, scroll: [0.04, 0.09],
    }),
  );
  // Doesn't write depth: reflections (mirrored below the surface) must stay visible through it.
  surface.material.depthWrite = false;
  surface.renderOrder = 5;
  surface.name = 'pond-surface';
  group.add(surface);

  // Rim rocks: low-poly stones with the text glyph surface in pale blue.
  const rng = new Rng('rocks', opt.seed);
  const rockMat = createGlyphSurfaceMaterial(engine, {
    glyphSet: SET.TEXT, cell: [0.07, 0.09], color: opt.rockColor, brightness: 1.0, gain: 1.4, jitter: 0.4, frag: 0.05, seed: opt.seed + 3, emissive: 0.16, hueMix: 0.5,
  });
  for (let i = 0; i < opt.rocks; i++) {
    const a = (i / opt.rocks) * Math.PI * 2 + rng.range(-0.15, 0.15);
    const r = opt.radius * rng.range(1.0, 1.1);
    const g = new THREE.IcosahedronGeometry(1, 1);
    const pos = g.getAttribute('position');
    for (let k = 0; k < pos.count; k++) {
      const n = 1 + (rng.float() - 0.5) * 0.35;
      pos.setXYZ(k, pos.getX(k) * n, pos.getY(k) * n, pos.getZ(k) * n);
    }
    g.computeVertexNormals();
    const rock = new THREE.Mesh(g, rockMat);
    const s = rng.range(0.22, 0.45);
    rock.scale.set(s * rng.range(1, 1.6), s * rng.range(0.45, 0.7), s * rng.range(0.8, 1.3));
    rock.position.set(cx + Math.cos(a) * r, opt.level + s * 0.15, cz + Math.sin(a) * r);
    rock.rotation.y = rng.range(0, Math.PI);
    group.add(rock);
  }
  return { object: group, surface, level: opt.level };
}
