import * as THREE from 'three';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { tint } from './helpers.js';

// Vegetation from thin repeated strokes and particle clusters: recursive trees (branch strokes + teal leaf glyph
// clusters), shrubs (radial curved blades) and grass tufts. All in one stroke-mode Points per call, with wind
// sway in the vertex shader (aRand.w = height factor).

export function createVegetation(engine, o = {}) {
  const opt = {
    seed: 11, trees: [], shrubs: [], grass: [], heightAt: () => 0,
    branchColor: '#5f8f8c', leafColor: '#4fb8ab', leafColor2: '#7fcfd6', bladeColor: '#4d9f95',
    sway: 0.06, swayFreq: 1.1, ...o,
  };
  const rng = new Rng('veg', opt.seed);
  const b = new ParticleBuilder();
  const dens = engine.density;
  const LINE = engine.atlas.index('stroke', 'LINE');
  const DASH = engine.atlas.index('stroke', 'DASH');
  const HAIR = engine.atlas.index('stroke', 'HAIR');
  const branchC = tint(opt.branchColor), leafA = tint(opt.leafColor), leafB = tint(opt.leafColor2), bladeC = tint(opt.bladeColor);

  for (const T of opt.trees) tree(T);
  for (const S of opt.shrubs) shrub(S);
  for (const G of opt.grass) grass(G);

  function tree(T) {
    const [x, z] = T.at, H = T.height ?? 5, y0 = opt.heightAt(x, z);
    const tr = new Rng('tree', opt.seed, x, z);
    const maxDepth = T.depth ?? 6;
    const segs = [], tips = [];
    const go = (p, dir, len, rad, depth) => {
      const e = p.clone().addScaledVector(dir, len);
      segs.push({ a: p, b: e, rad, depth });
      if (depth >= maxDepth) { tips.push(e); return; }
      const kids = depth < 1 ? 2 : tr.int(2, 3);
      for (let k = 0; k < kids; k++) {
        const axis = new THREE.Vector3(tr.range(-1, 1), tr.range(-0.2, 0.2), tr.range(-1, 1)).cross(dir).normalize();
        const nd = dir.clone().applyAxisAngle(axis, tr.range(0.35, 0.8) * (T.spread ?? 1));
        nd.y += 0.25; nd.normalize();
        go(e, nd, len * tr.range(0.66, 0.8), rad * 0.68, depth + 1);
        if (depth >= maxDepth - 2) tips.push(e.clone());
      }
    };
    go(new THREE.Vector3(x, y0, z), new THREE.Vector3(tr.range(-0.08, 0.08), 1, tr.range(-0.08, 0.08)).normalize(), H * 0.34, 0.16 * (H / 5), 0);
    for (const s of segs) {
      const d = s.b.clone().sub(s.a), len = d.length();
      d.normalize();
      const perp1 = new THREE.Vector3(0, 0, 1).cross(d).normalize();
      if (perp1.lengthSq() < 1e-6) perp1.set(1, 0, 0);
      const perp2 = d.clone().cross(perp1);
      // Thicker branches get several parallel strokes around their circumference.
      const strands = Math.max(1, Math.round(s.rad * 40));
      const n = Math.max(2, Math.round((len / 0.05) * dens));
      for (let st = 0; st < strands; st++) {
        const ang = tr.range(0, Math.PI * 2), r = s.rad * Math.sqrt(tr.float());
        for (let i = 0; i < n; i++) {
          const u = (i + tr.float()) / n;
          const p = s.a.clone().addScaledVector(d, len * u).addScaledVector(perp1, Math.cos(ang) * r).addScaledVector(perp2, Math.sin(ang) * r);
          b.push({ p: [p.x, p.y, p.z], seed: tr.float(), size: 0.8 + s.rad * 2, bright: 0.65, tangent: [d.x, d.y, d.z], glyph: s.depth < 2 ? LINE : DASH, color: branchC, param: Math.min(1, (p.y - y0) / H) * (0.3 + 0.7 * s.depth / maxDepth) });
        }
      }
    }
    // Leaf clusters: glyphs from the vegetation ramp + dots, two teal/cyan tones.
    const per = Math.round((T.leaves ?? 26) * dens);
    for (const tip of tips) {
      for (let i = 0; i < per; i++) {
        const r = (T.clusterRadius ?? 0.38) * Math.cbrt(tr.float());
        const dd = tr.dir();
        const p = [tip.x + dd[0] * r, tip.y + dd[1] * r * 0.7, tip.z + dd[2] * r];
        const glyph = tr.chance(0.35) ? -1 : tr.chance(0.5) ? DASH : HAIR;
        b.push({ p, seed: tr.float(), size: tr.range(0.7, 1.2), bright: tr.range(0.6, 1.3), tangent: [tr.range(-1, 1), tr.range(-0.4, 0.6), tr.range(-1, 1)], glyph, color: tr.chance(0.3) ? leafB : leafA, param: Math.min(1, (p[1] - y0) / H) });
      }
    }
  }

  function blade(base, dir, h, color, bright, rr) {
    const steps = 5;
    for (let i = 0; i < steps; i++) {
      const u = (i + 0.5) / steps;
      const p = [base[0] + dir[0] * u * h * 0.5, base[1] + h * (u - 0.25 * u * u), base[2] + dir[2] * u * h * 0.5];
      const t = [dir[0] * 0.5, 1 - 0.5 * u, dir[2] * 0.5];
      b.push({ p, seed: rr.float(), size: rr.range(0.5, 0.8) * (0.6 + h), bright: bright * rr.range(0.7, 1.2), tangent: t, glyph: LINE, color, param: u * Math.min(1, h * 1.6) });
    }
  }

  function shrub(S) {
    const [x, z] = S.at, R = S.radius ?? 0.8;
    const sr = new Rng('shrub', opt.seed, x, z);
    const n = Math.round((S.count ?? 90) * dens);
    for (let i = 0; i < n; i++) {
      const a = sr.range(0, Math.PI * 2), r = R * 0.3 * sr.float();
      const base = [x + Math.cos(a) * r, opt.heightAt(x, z), z + Math.sin(a) * r];
      const out = sr.range(0.4, 1.2);
      blade(base, [Math.cos(a) * out, 0, Math.sin(a) * out], sr.range(0.4, 1.0) * R, sr.chance(0.25) ? leafB : bladeC, 0.85, sr);
    }
  }

  function grass(G) {
    const [x, z] = G.at, R = G.radius ?? 2;
    const gr = new Rng('grass', opt.seed, x, z);
    const n = Math.round((G.count ?? 220) * dens);
    for (let i = 0; i < n; i++) {
      const a = gr.range(0, Math.PI * 2), r = R * Math.sqrt(gr.float());
      const bx = x + Math.cos(a) * r, bz = z + Math.sin(a) * r;
      const lean = gr.range(0, Math.PI * 2), k = gr.range(0.1, 0.5);
      blade([bx, opt.heightAt(bx, bz), bz], [Math.cos(lean) * k, 0, Math.sin(lean) * k], gr.range(0.12, 0.42), gr.chance(0.2) ? leafB : bladeC, 0.7, gr);
    }
  }

  const points = makePoints(engine, b, {
    mode: 'stroke', glyphSet: SET.VEG, color: '#ffffff', size: 0.075, brightness: 0.5, lit: 0.85, flicker: 0.15,
    glyphMinPx: 4, sway: { amount: opt.sway, freq: opt.swayFreq },
  });
  points.name = 'vegetation';
  return { object: points, count: b.count };
}
