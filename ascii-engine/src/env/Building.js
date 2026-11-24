import * as THREE from 'three';
import { createGlyphSurfaceMaterial } from '../shaders/GlyphSurfaceMaterial.js';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { edgeLines } from '../shaders/LineMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { sampleSegment, boxEdges, tint } from './helpers.js';

// Buildings: stacked volumes (setbacks), each a glyph-surface box (ASCII facade with a window grid and lit amber
// windows), luminous dashed edges, dashed floor lines, sparse glyph points floating just off the facade
// (point-cloud surface), and a roof mast with a crimson beacon.

export function createBuilding(engine, o = {}) {
  const opt = {
    at: [0, 0], size: [8, 30, 8], tiers: [[0.72, 1.2], [0.88, 1.0]], seed: 1, y: 0,
    color: '#c9d1da', windowColor: '#ffae42', windowsLit: 0.22, floor: 3.2, bay: 2.4, cell: [0.2, 0.3],
    edgeColor: '#e8edf2', surfacePoints: 0.9, mast: true, beacon: '#ff2a1f', brightness: 1, emissive: 0.2, ...o,
  };
  const rng = new Rng('building', opt.seed);
  const group = new THREE.Group();
  group.name = `building-${opt.seed}`;
  const [w0, h0, d0] = opt.size;
  const [cx, cz] = opt.at;

  // Volumes: [width, depth, y0, y1].
  const vols = [];
  let y0 = opt.y, w = w0, d = d0;
  const cuts = [...opt.tiers.map((t) => t[0]), 1];
  cuts.forEach((frac, i) => {
    const y1 = opt.y + h0 * frac;
    vols.push([w, d, y0, y1]);
    if (i < opt.tiers.length) { w -= opt.tiers[i][1] * 2; d -= opt.tiers[i][1] * 2; }
    y0 = y1;
  });

  const mat = createGlyphSurfaceMaterial(engine, {
    glyphSet: SET.ARCH, cell: opt.cell, color: opt.color, brightness: opt.brightness, gain: 1.5, jitter: 0.3,
    frag: 0.16, fragScale: 0.12, seed: opt.seed * 7.13, emissive: opt.emissive,
    windows: { grid: [opt.bay, opt.floor], color: opt.windowColor, lit: opt.windowsLit, glow: 1.1 },
    emerge: { value: 1, range: [opt.y, opt.y + h0] },
  });

  const b = new ParticleBuilder();
  const dens = engine.density;
  const DASH = engine.atlas.index('stroke', 'DASH');
  const edgeCol = tint(opt.edgeColor);
  for (const [vw, vd, a, c] of vols) {
    const geo = new THREE.BoxGeometry(vw, c - a, vd);
    geo.translate(cx, (a + c) / 2, cz);
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    const lines = edgeLines(engine, geo, { color: opt.edgeColor, brightness: 0.35, lit: 0.6 });
    group.add(lines);

    const min = [cx - vw / 2, a, cz - vd / 2], max = [cx + vw / 2, c, cz + vd / 2];
    for (const [p, q] of boxEdges(min, max)) {
      sampleSegment(b, rng, p, q, 0.07 / dens, { glyph: DASH, size: 1.0, bright: 1.3, color: edgeCol, jitter: 0.01 });
    }
    // Floor lines every other floor, as sparse dashes running around the volume.
    for (let y = a + opt.floor; y < c - 0.5; y += opt.floor * 2) {
      const ring = [[min[0], y, max[2]], [max[0], y, max[2]], [max[0], y, min[2]], [min[0], y, min[2]], [min[0], y, max[2]]];
      for (let k = 0; k < 4; k++) {
        const nrm = [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]][k];
        const off = (v) => [v[0] + nrm[0] * 0.03, v[1], v[2] + nrm[2] * 0.03];
        sampleSegment(b, rng, off(ring[k]), off(ring[k + 1]), 0.16 / dens, { glyph: DASH, size: 0.8, bright: 0.55, color: edgeCol, jitter: 0.015, normal: nrm });
      }
    }
    // Point-cloud surface: ASCII glyph points hovering just in front of each facade.
    const faces = [
      { n: [0, 0, 1], o: [cx, 0, max[2]], u: [1, 0, 0], uw: vw },
      { n: [0, 0, -1], o: [cx, 0, min[2]], u: [1, 0, 0], uw: vw },
      { n: [1, 0, 0], o: [max[0], 0, cz], u: [0, 0, 1], uw: vd },
      { n: [-1, 0, 0], o: [min[0], 0, cz], u: [0, 0, 1], uw: vd },
    ];
    for (const f of faces) {
      const count = Math.round(f.uw * (c - a) * opt.surfacePoints * dens);
      for (let i = 0; i < count; i++) {
        const s = rng.range(-0.5, 0.5) * f.uw, y = rng.range(a, c), lift = 0.04 + Math.abs(rng.gauss()) * 0.12;
        b.push({ p: [f.o[0] + f.u[0] * s + f.n[0] * lift, y, f.o[2] + f.u[2] * s + f.n[2] * lift], n: f.n, seed: rng.float(), size: rng.range(0.8, 1.4), bright: rng.range(0.5, 1.1), glyph: -1 });
      }
    }
  }

  // Roof mast + crimson beacon.
  if (opt.mast) {
    const top = vols[vols.length - 1];
    const mh = rng.range(3, 6);
    sampleSegment(b, rng, [cx, top[3], cz], [cx, top[3] + mh, cz], 0.05 / dens, { glyph: DASH, size: 0.9, bright: 1.0, color: edgeCol, jitter: 0.005 });
    const bc = tint(opt.beacon, 1.6);
    for (let i = 0; i < 160 * dens; i++) {
      const dd = rng.dir();
      b.push({ p: [cx + dd[0] * 0.1, top[3] + mh + dd[1] * 0.1, cz + dd[2] * 0.1], seed: rng.float(), size: 1.3, bright: 4, color: bc, glyph: engine.atlas.index('mark', 'DOT') });
    }
  }

  const points = makePoints(engine, b, { mode: 'stroke', glyphSet: SET.ARCH, color: opt.color, size: 0.12, brightness: 0.5 * opt.brightness, lit: 1, flicker: 0.18, glyphMinPx: 4.5, glyphJitter: 0.4 });
  points.name = `building-${opt.seed}-points`;
  group.add(points);
  return { object: group, material: mat, points, volumes: vols };
}
