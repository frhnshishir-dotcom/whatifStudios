import * as THREE from 'three';
import { createGlyphSurfaceMaterial } from '../shaders/GlyphSurfaceMaterial.js';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { edgeLines } from '../shaders/LineMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { tint } from './helpers.js';

// Pavilion / hall: stone platform, walls of warm-lit lattice panels (rows of amber text glyphs), and a concave gable
// roof with upturned eaves and corners. The roof is a dark depth-writing surface covered in rows of tile strokes
// (dashes running down the slope), with a bright ridge line. Generic parameters; any timber-roofed building.

export function createPavilion(engine, o = {}) {
  const opt = {
    at: [0, 0], rotationY: 0, size: [8, 5], base: 0.45, wallH: 2.6, roofH: 2.2, overhang: 1.3, upturn: 0.35, cornerUp: 0.6,
    wallColor: '#c4cad3', panelColor: '#ffb347', panelsLit: 0.6, tileColor: '#d3d9e0', seed: 4, heightAt: () => 0, ...o,
  };
  const rng = new Rng('pavilion', opt.seed);
  const group = new THREE.Group();
  group.name = 'pavilion';
  const [x0, z0] = opt.at;
  group.position.set(x0, opt.heightAt(x0, z0), z0);
  group.rotation.y = opt.rotationY;
  const [w, d] = opt.size;
  const dens = engine.density;

  // Platform and walls.
  const stone = createGlyphSurfaceMaterial(engine, { glyphSet: SET.TEXT, cell: [0.08, 0.1], color: '#9aa6b6', brightness: 0.9, gain: 1.4, frag: 0.1, seed: opt.seed, emissive: 0.1 });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, opt.base, d + 0.8).translate(0, opt.base / 2, 0), stone));
  const wallMat = createGlyphSurfaceMaterial(engine, {
    glyphSet: SET.TEXT, cell: [0.075, 0.12], color: opt.wallColor, brightness: 1.1, gain: 1.45, jitter: 0.35, frag: 0.08, seed: opt.seed + 1, emissive: opt.wallEmissive ?? 0.24,
    windows: { grid: [1.1, opt.wallH], color: opt.panelColor, lit: opt.panelsLit, glow: 1.6 },
  });
  const wallGeo = new THREE.BoxGeometry(w, opt.wallH, d).translate(0, opt.base + opt.wallH / 2, 0);
  group.add(new THREE.Mesh(wallGeo, wallMat), edgeLines(engine, wallGeo, { color: '#e6c9a0', brightness: 0.25 }));

  // Roof: parametric surface for each side; u along the ridge, v from ridge (0) to eave (1).
  const W2 = w / 2 + opt.overhang, D2 = d / 2 + opt.overhang;
  const yr = opt.base + opt.wallH + opt.roofH;
  const roofPoint = (u, v, s) => {
    const y = yr - opt.roofH * (1 - Math.pow(1 - v, 1.7)) + opt.upturn * Math.pow(v, 6) + opt.cornerUp * Math.pow(Math.abs(u) / W2, 6) * v * v;
    return new THREE.Vector3(u, y, s * v * D2);
  };
  const SU = 32, SV = 12, verts = [], idx = [];
  for (const s of [1, -1]) {
    const off = verts.length / 3;
    for (let j = 0; j <= SV; j++) for (let i = 0; i <= SU; i++) {
      const p = roofPoint(-W2 + (2 * W2 * i) / SU, j / SV, s);
      verts.push(p.x, p.y, p.z);
    }
    for (let j = 0; j < SV; j++) for (let i = 0; i < SU; i++) {
      const a = off + j * (SU + 1) + i, b = a + 1, c = a + SU + 1, e = c + 1;
      if (s > 0) idx.push(a, c, b, b, c, e); else idx.push(a, b, c, b, e, c);
    }
  }
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  roofGeo.setIndex(idx);
  roofGeo.computeVertexNormals();
  const roofMat = createGlyphSurfaceMaterial(engine, { glyphSet: SET.TILE, cell: [0.2, 0.28], color: '#8f99a6', brightness: 0.5, gain: 1.2, frag: 0.3, seed: opt.seed + 2, emissive: 0.05 });
  roofMat.side = THREE.DoubleSide;
  group.add(new THREE.Mesh(roofGeo, roofMat));
  // Gable ends.
  const gable = new THREE.BufferGeometry();
  const gy = opt.base + opt.wallH;
  gable.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, gy, -d / 2, -w / 2, gy, d / 2, -w / 2, yr - 0.1, 0, w / 2, gy, d / 2, w / 2, gy, -d / 2, w / 2, yr - 0.1, 0], 3));
  gable.computeVertexNormals();
  const gm = wallMat.clone(); gm.side = THREE.DoubleSide;
  group.add(new THREE.Mesh(gable, gm));

  // Tile strokes: rows of dashes running down the slope.
  const b = new ParticleBuilder();
  const DASH = engine.atlas.index('stroke', 'DASH');
  const tileC = tint(opt.tileColor);
  const du = 0.2 / Math.sqrt(dens), dv = 0.06;
  for (const s of [1, -1]) {
    for (let u = -W2 + du / 2; u < W2; u += du) {
      for (let v = 0.02; v < 1; v += 0.28 / Math.hypot(D2, opt.roofH)) {
        const p = roofPoint(u, v, s), q = roofPoint(u, Math.min(v + dv, 1), s);
        const t = q.clone().sub(p).normalize();
        const n = new THREE.Vector3(0, 1, 0);
        b.push({ p: [p.x, p.y + 0.03, p.z], n: [n.x, n.y, n.z], seed: rng.float(), size: rng.range(0.85, 1.15), bright: rng.range(0.55, 1.1), tangent: [t.x, t.y, t.z], glyph: DASH, color: tileC });
      }
    }
  }
  // Ridge.
  for (let u = -W2; u <= W2; u += 0.03 / dens) {
    const p = roofPoint(u, 0, 1);
    b.push({ p: [p.x, p.y + 0.06, p.z], seed: rng.float(), size: 1.1, bright: 1.6, tangent: [1, 0, 0], glyph: DASH, color: tileC });
  }
  const tiles = makePoints(engine, b, { mode: 'stroke', color: '#ffffff', size: 0.13, brightness: 0.55, lit: 0.9, flicker: 0.08, glyphMinPx: 4 });
  tiles.name = 'pavilion-tiles';
  group.add(tiles);
  return { object: group, tiles, ridgeY: yr };
}
