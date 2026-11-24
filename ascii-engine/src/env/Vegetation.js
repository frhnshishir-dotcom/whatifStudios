import * as THREE from 'three';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { tint, sampleSegment } from './helpers.js';
import { common, sharedUniforms, lighting, fog, sway as swayChunk, water as waterChunk } from '../shaders/chunks.js';

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

// ------------------------------------------------------------------------------------------------------------
// Reeds and grass as real lines: long thin straight blades (one GL line each) with a bright bead at the tip,
// all in one LineSegments + one Points draw. Blade and bead share the same wind sway function.


function bladeMaterial(engine, { brightness, lit, sway, swayFreq }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...engine.shared,
      uBrightness: { value: brightness },
      uLit: { value: lit },
      uSway: { value: sway },
      uSwayFreq: { value: swayFreq },
    },
    vertexShader: /* glsl */ `
      ${common}
      ${sharedUniforms}
      ${lighting}
      ${fog}
      ${swayChunk}
      ${waterChunk}
      uniform float uBrightness;
      uniform float uLit;
      attribute vec3 aColor;
      attribute float aSwayW;
      attribute float aSeed;
      varying vec3 vColor;
      void main() {
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        wp += swayOffset(wp, aSwayW, aSeed);
        float band = floor(wp.y * 7.0), tq = floor(uTime * 15.0);
        float on = step(1.0 - uGlitch * 0.55, hash12(vec2(band, tq)));
        wp += uCamRight * (hash12(vec2(band + 17.0, tq)) - 0.5) * 0.9 * uGlitch * on;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mv;
        vec3 L = shadeLights(wp, vec3(0.0), 0.0);
        vColor = aColor * mix(vec3(1.0), L * 2.0, uLit) * uBrightness * (0.45 + 0.55 * aSwayW) * fogFactor(-mv.z);
        if (inPond(wp) > 0.5 && wp.y < uWater.y) vColor *= 0.1;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() { gl_FragColor = vec4(vColor, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * patches: [{ at: [x, z], radius, count, height: [min, max], lean (max radians), colors: [css...], beads (0..1) }]
 */
export function createReeds(engine, o = {}) {
  const opt = { seed: 21, patches: [], heightAt: () => 0, avoid: () => false, brightness: 0.7, beadBrightness: 1.3, lit: 0.7, sway: 0.05, swayFreq: 1.0, ...o };
  const rng = new Rng('reeds', opt.seed);
  const pos = [], col = [], sw = [], sd = [];
  const beads = new ParticleBuilder();
  for (const P of opt.patches) {
    const colors = (P.colors || ['#5fa89a', '#7aa070', '#b8b878']).map((c) => tint(c));
    const n = Math.round((P.count ?? 300) * engine.density);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2), r = (P.radius ?? 2) * Math.sqrt(rng.float());
      const x = P.at[0] + Math.cos(a) * r, z = P.at[1] + Math.sin(a) * r;
      if (opt.avoid(x, z)) continue;
      const y = opt.heightAt(x, z);
      const h = rng.range(...(P.height ?? [0.6, 1.4]));
      const lean = rng.range(0, P.lean ?? 0.45), dir = rng.range(0, Math.PI * 2);
      const tip = [x + Math.sin(lean) * Math.cos(dir) * h, y + Math.cos(lean) * h, z + Math.sin(lean) * Math.sin(dir) * h];
      const c = rng.pick(colors), k = rng.range(0.6, 1.2), seed = rng.float();
      pos.push(x, y, z, ...tip);
      col.push(c[0] * k * 0.5, c[1] * k * 0.5, c[2] * k * 0.5, c[0] * k, c[1] * k, c[2] * k);
      sw.push(0, 1);
      sd.push(seed, seed);
      if (rng.chance(P.beads ?? 0.8)) beads.push({ p: tip, seed, size: rng.range(0.7, 1.3), bright: rng.range(0.6, 1.2), color: [c[0] * 1.2 + 0.15, c[1] * 1.2 + 0.15, c[2] * 1.2 + 0.15], param: 1 });
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSwayW', new THREE.Float32BufferAttribute(sw, 1));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(sd, 1));
  const lines = new THREE.LineSegments(g, bladeMaterial(engine, opt));
  lines.frustumCulled = false;
  lines.name = 'reeds';
  const tips = makePoints(engine, beads, { mode: 'dot', color: '#ffffff', size: 0.011, brightness: opt.beadBrightness, lit: opt.lit, flicker: 0.1, sway: { amount: opt.sway, freq: opt.swayFreq } });
  tips.name = 'reed-tips';
  const group = new THREE.Group();
  group.add(lines, tips);
  return { object: group, lines, tips, count: pos.length / 6 };
}

/**
 * Pines: crooked trunk strokes and flat pads of pale cyan needles (short dashes radiating outwards).
 * pines: [{ at: [x, z], height, pads }]
 */
export function createPines(engine, o = {}) {
  const opt = { seed: 31, pines: [], heightAt: () => 0, needle: '#bfe6e2', needle2: '#8fcfcf', bark: '#7d8a8c', sway: 0.025, ...o };
  const b = new ParticleBuilder();
  const dens = engine.density;
  const DASH = engine.atlas.index('stroke', 'DASH'), LINE = engine.atlas.index('stroke', 'LINE');
  const n1 = tint(opt.needle), n2 = tint(opt.needle2), bark = tint(opt.bark);
  for (const P of opt.pines) {
    const rng = new Rng('pine', opt.seed, P.at[0], P.at[1]);
    const [x0, z0] = P.at, y0 = opt.heightAt(x0, z0), H = P.height ?? 3.5;
    // Trunk: 3 crooked segments.
    const pts = [[x0, y0, z0]];
    for (let k = 1; k <= 3; k++) pts.push([x0 + rng.range(-0.35, 0.35) * k * 0.5, y0 + (H * k) / 3, z0 + rng.range(-0.35, 0.35) * k * 0.5]);
    for (let k = 0; k < 3; k++) sampleSegment(b, rng, pts[k], pts[k + 1], 0.035 / dens, { glyph: LINE, size: 1.3 - k * 0.3, bright: 0.5, color: bark, param: () => 0.2 * k });
    const pads = P.pads ?? 6;
    for (let k = 0; k < pads; k++) {
      const u = 0.3 + 0.7 * (k / (pads - 1));
      const base = [pts[0][0] + (pts[3][0] - pts[0][0]) * u, y0 + H * u, pts[0][2] + (pts[3][2] - pts[0][2]) * u];
      const ang = rng.range(0, Math.PI * 2), reach = (1 - u * 0.6) * rng.range(0.6, 1.2);
      const c = [base[0] + Math.cos(ang) * reach, base[1] + rng.range(-0.1, 0.15), base[2] + Math.sin(ang) * reach];
      sampleSegment(b, rng, base, c, 0.04 / dens, { glyph: LINE, size: 0.7, bright: 0.45, color: bark, param: () => u });
      const R = (0.45 + 0.35 * (1 - u)) * rng.range(0.85, 1.2), m = Math.round(240 * dens * R);
      for (let i = 0; i < m; i++) {
        const t = rng.range(0, Math.PI * 2), r = R * Math.sqrt(rng.float());
        const p = [c[0] + Math.cos(t) * r, c[1] + rng.gauss() * 0.05 + (1 - r / R) * 0.08, c[2] + Math.sin(t) * r * 0.8];
        b.push({ p, seed: rng.float(), size: rng.range(0.7, 1.1), bright: rng.range(0.6, 1.2), tangent: [Math.cos(t), rng.range(-0.2, 0.3), Math.sin(t)], glyph: DASH, color: rng.chance(0.3) ? n2 : n1, param: Math.min(1, u + 0.2) });
      }
    }
  }
  const points = makePoints(engine, b, { mode: 'stroke', color: '#ffffff', size: 0.06, brightness: 0.55, lit: 0.75, flicker: 0.1, glyphMinPx: 4, sway: { amount: opt.sway, freq: 0.8 } });
  points.name = 'pines';
  return { object: points };
}
