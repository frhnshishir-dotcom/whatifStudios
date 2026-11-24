import * as THREE from 'three';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { createLineMaterial } from '../shaders/LineMaterial.js';
import { Rng } from '../core/random.js';
import { sampleSegment, tint, glowSprite } from './helpers.js';
import { createGlyphSurfaceMaterial } from '../shaders/GlyphSurfaceMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';

// Environmental structures built from line segments: every segment becomes luminous dashed strokes (particles)
// plus a 1 px GL line underneath for continuity. Lattice pylons with catenary cables, and portal frames.

export function wireStructure(engine, segments, o = {}) {
  const opt = { color: '#d6dde4', spacing: 0.08, size: 0.07, brightness: 0.6, lineBrightness: 0.25, seed: 1, cable: [], ...o };
  const rng = new Rng('wire', opt.seed);
  const b = new ParticleBuilder();
  const dens = engine.density;
  const DASH = engine.atlas.index('stroke', 'DASH');
  const col = tint(opt.color);
  const pos = [];
  for (const [a, c] of segments) {
    sampleSegment(b, rng, a, c, opt.spacing / dens, { glyph: DASH, size: 1, bright: 1, color: col, jitter: 0.004 });
    pos.push(...a, ...c);
  }
  const group = new THREE.Group();
  const pts = makePoints(engine, b, { mode: 'stroke', color: '#ffffff', size: opt.size, brightness: opt.brightness, lit: 0.8, flicker: 0.15, glyphMinPx: 4 });
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const lines = new THREE.LineSegments(lg, createLineMaterial(engine, { color: opt.color, brightness: opt.lineBrightness }));
  lines.computeLineDistances();
  group.add(pts, lines);
  return { object: group, points: pts, lines };
}

/** Lattice transmission pylons at [x, z] positions, joined by sagging cables. */
export function createPylons(engine, { at = [], height = 22, width = 3, color = '#c8d0d8', seed = 2, heightAt = () => 0 } = {}) {
  const segs = [];
  const tops = [];
  for (const [x, z] of at) {
    const y0 = heightAt(x, z);
    const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const levels = 7;
    const ring = (k) => {
      const u = k / levels, hw = width * (1 - 0.8 * u) / 2;
      return legs.map(([sx, sz]) => [x + sx * hw, y0 + height * u, z + sz * hw]);
    };
    for (let k = 0; k < levels; k++) {
      const r0 = ring(k), r1 = ring(k + 1);
      for (let i = 0; i < 4; i++) {
        segs.push([r0[i], r1[i]]);
        segs.push([r0[i], r1[(i + 1) % 4]]);
        segs.push([r1[i], r1[(i + 1) % 4]]);
      }
    }
    // Cross arms.
    for (const f of [0.72, 0.86]) {
      const y = y0 + height * f, arm = width * 1.4;
      segs.push([[x - arm, y, z], [x + arm, y, z]]);
      segs.push([[x - arm, y, z], [x, y + 1.2, z]]);
      segs.push([[x + arm, y, z], [x, y + 1.2, z]]);
      tops.push([[x - arm, y, z], [x + arm, y, z]]);
    }
  }
  // Catenary cables between consecutive pylons.
  const cableSegs = [];
  const perPylon = 2;
  for (let p = 0; p + 1 < at.length; p++) {
    for (let a = 0; a < perPylon; a++) {
      for (const side of [0, 1]) {
        const A = tops[p * perPylon + a][side], B = tops[(p + 1) * perPylon + a][side];
        const n = 24;
        let prev = A;
        for (let i = 1; i <= n; i++) {
          const u = i / n;
          const sag = Math.sin(u * Math.PI) * 2.2;
          const q = [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u - sag, A[2] + (B[2] - A[2]) * u];
          cableSegs.push([prev, q]);
          prev = q;
        }
      }
    }
  }
  const tower = wireStructure(engine, segs, { color, seed, spacing: 0.12, size: 0.12, brightness: 0.45 });
  const cables = wireStructure(engine, cableSegs, { color, seed: seed + 1, spacing: 0.25, size: 0.1, brightness: 0.35, lineBrightness: 0.18 });
  const group = new THREE.Group();
  group.name = 'pylons';
  group.add(tower.object, cables.object);
  return { object: group };
}

/** Rectangular portal / gate frame (two posts, lintel, inner frame). */
export function createPortal(engine, { at = [0, 0], width = 4, height = 6, depth = 0.6, color = '#e0e6ec', seed = 3, rotationY = 0 } = {}) {
  const [x, z] = at, hw = width / 2, hd = depth / 2;
  const segs = [];
  for (const s of [-1, 1]) for (const d of [-1, 1]) segs.push([[s * hw, 0, d * hd], [s * hw, height, d * hd]]);
  for (const d of [-1, 1]) segs.push([[-hw, height, d * hd], [hw, height, d * hd]], [[-hw * 0.8, height * 0.9, d * hd], [hw * 0.8, height * 0.9, d * hd]]);
  for (const s of [-1, 1]) segs.push([[s * hw, height, -hd], [s * hw, height, hd]]);
  const w = wireStructure(engine, segs, { color, seed, spacing: 0.05, size: 0.07, brightness: 0.7 });
  w.object.position.set(x, 0, z);
  w.object.rotation.y = rotationY;
  return w;
}

/**
 * Lanterns: a small stone base (glyph surface) and a chamber of dense, bright amber glyphs (the lamp ramp picks
 * 8 $ # @ Q B as it saturates) with a warm point light and a soft glow. at: [[x, z], ...].
 */
export function createLanterns(engine, { at = [], color = '#ffae45', heightAt = () => 0, intensity = 0.9, range = 3.6, seed = 7, lights = true } = {}) {
  const group = new THREE.Group();
  group.name = 'lanterns';
  const rng = new Rng('lantern', seed);
  const b = new ParticleBuilder();
  const amber = tint(color);
  const stoneMat = createGlyphSurfaceMaterial(engine, { glyphSet: SET.TEXT, cell: [0.05, 0.07], color: '#a9b4c2', brightness: 1, gain: 1.4, frag: 0.05, seed, emissive: 0.14 });
  const list = [];
  for (const [x, z] of at) {
    const y = heightAt(x, z);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 0.22).translate(x, y + 0.21, z), stoneMat);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.16, 4).rotateY(Math.PI / 4).translate(x, y + 0.82, z), stoneMat);
    group.add(base, cap);
    const n = Math.round(260 * Math.max(engine.density, 0.5));
    for (let i = 0; i < n; i++) {
      b.push({ p: [x + rng.range(-0.1, 0.1), y + 0.5 + rng.range(0, 0.22), z + rng.range(-0.1, 0.1)], seed: rng.float(), size: rng.range(0.8, 1.2), bright: rng.range(0.7, 1.3), color: amber });
    }
    if (lights) list.push(engine.lightRig.add({ name: 'lantern', position: [x, y + 0.62, z], color, intensity, range }));
    const glow = glowSprite(engine, { color, size: 1.1, intensity: 0.28, falloff: 2.2 });
    glow.position.set(x, y + 0.62, z);
    group.add(glow);
  }
  const pts = makePoints(engine, b, { mode: 'glyph', glyphSet: SET.LAMP, color: '#ffffff', size: 0.05, brightness: 1.6, lit: 0, flicker: 0.12, glyphJitter: 0.3, rampGain: 1.0 });
  pts.name = 'lantern-glyphs';
  group.add(pts);
  return { object: group, lights: list, points: pts };
}
