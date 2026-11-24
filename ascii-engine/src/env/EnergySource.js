import * as THREE from 'three';
import { ParticleBuilder, makePoints } from '../shaders/ParticleMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { Rng } from '../core/random.js';
import { tint, glowSprite } from './helpers.js';

// Energy source: a boiling crimson core (dense displaced point sphere, white-hot centre), a shell of code glyphs,
// tilted orbit rings of dashes, a rising particle column, a soft glow sprite and a light-rig entry, so every
// particle and glyph surface in range is washed in red. update(t) animates rotation and the pulsing light.

export function createEnergySource(engine, o = {}) {
  const opt = {
    position: [0, 2, -8], radius: 0.55, color: '#ff2418', hot: '#ffd2c2', seed: 4,
    intensity: 3.2, range: 16, rings: 3, column: true, pulseRate: 1.7, pulseDepth: 0.22, ...o,
  };
  const rng = new Rng('energy', opt.seed);
  const group = new THREE.Group();
  group.name = 'energy-source';
  group.position.set(...opt.position);
  const dens = engine.density;
  const R = opt.radius;
  const red = tint(opt.color), hot = tint(opt.hot);

  // Core.
  const core = new ParticleBuilder();
  const nCore = Math.round(7000 * dens);
  for (let i = 0; i < nCore; i++) {
    const d = rng.dir(), r = R * Math.pow(rng.float(), 0.25);
    const k = Math.pow(r / R, 0.35); // mostly crimson, a small white-hot centre
    const col = [hot[0] + (red[0] - hot[0]) * k, hot[1] + (red[1] - hot[1]) * k, hot[2] + (red[2] - hot[2]) * k];
    core.push({ p: [d[0] * r, d[1] * r, d[2] * r], n: d, seed: rng.float(), size: rng.range(0.6, 1.4), bright: (1.5 - k) * rng.range(0.7, 1.3), color: col });
  }
  const corePts = makePoints(engine, core, { mode: 'dot', color: '#ffffff', size: 0.013, brightness: 0.85, lit: 0, flicker: 0.4, displace: 0.06 });
  // Shell of glyphs.
  const shell = new ParticleBuilder();
  for (let i = 0; i < 420 * dens; i++) {
    const d = rng.dir(), r = R * rng.range(1.25, 1.7);
    shell.push({ p: [d[0] * r, d[1] * r, d[2] * r], n: d, seed: rng.float(), size: rng.range(0.6, 1.2), bright: rng.range(0.4, 1.0), color: red });
  }
  const shellPts = makePoints(engine, shell, { mode: 'glyph', glyphSet: SET.CODE, color: '#ffffff', size: 0.07, brightness: 0.6, lit: 0, flicker: 0.5, glyphJitter: 1.0, displace: 0.04 });
  group.add(corePts, shellPts);

  // Luminous wireframe sphere: latitude rings + meridians of dashes around the core (crisp geometry over the glow).
  const wb = new ParticleBuilder();
  const wr = R * 1.12;
  const DASH0 = engine.atlas.index('stroke', 'DASH');
  for (let lat = -2; lat <= 2; lat++) {
    const phi = (lat / 3) * (Math.PI / 2), rr = wr * Math.cos(phi), y = wr * Math.sin(phi);
    const n = Math.round(150 * dens * Math.cos(phi) + 20);
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      wb.push({ p: [Math.cos(t) * rr, y, Math.sin(t) * rr], seed: rng.float(), size: 1, bright: 1, tangent: [-Math.sin(t), 0, Math.cos(t)], glyph: DASH0, color: red });
    }
  }
  for (let m = 0; m < 6; m++) {
    const th = (m / 6) * Math.PI;
    const n = Math.round(130 * dens + 20);
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const p = [Math.cos(t) * Math.cos(th) * wr, Math.sin(t) * wr, Math.cos(t) * Math.sin(th) * wr];
      const tg = [-Math.sin(t) * Math.cos(th), Math.cos(t), -Math.sin(t) * Math.sin(th)];
      wb.push({ p, seed: rng.float(), size: 1, bright: 0.8, tangent: tg, glyph: DASH0, color: hot });
    }
  }
  const wire = makePoints(engine, wb, { mode: 'stroke', color: '#ffffff', size: 0.05, brightness: 0.75, lit: 0, flicker: 0.12 });
  group.add(wire);

  // Orbit rings.
  const DASH = engine.atlas.index('stroke', 'DASH');
  const rings = [];
  for (let k = 0; k < opt.rings; k++) {
    const rb = new ParticleBuilder();
    const rr = R * (1.9 + k * 0.55);
    const n = Math.round(420 * dens * (1 + k * 0.3));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      if (Math.sin(t * (3 + k)) < -0.6) continue; // gaps
      rb.push({ p: [Math.cos(t) * rr, rng.gauss() * 0.01, Math.sin(t) * rr], seed: rng.float(), size: rng.range(0.8, 1.2), bright: rng.range(0.6, 1.2), tangent: [-Math.sin(t), 0, Math.cos(t)], glyph: DASH, color: k === 1 ? hot : red });
    }
    const ring = makePoints(engine, rb, { mode: 'stroke', color: '#ffffff', size: 0.06, brightness: 0.9, lit: 0, flicker: 0.2 });
    const pivot = new THREE.Group();
    pivot.rotation.set(rng.range(-0.6, 0.6), rng.range(0, Math.PI), rng.range(-0.5, 0.5));
    pivot.add(ring);
    group.add(pivot);
    rings.push({ pivot, ring, speed: (k % 2 ? -1 : 1) * rng.range(0.25, 0.5) });
  }

  // Rising column.
  let column = null;
  if (opt.column) {
    const cb = new ParticleBuilder();
    const H = 14;
    for (let i = 0; i < 1600 * dens; i++) {
      const a = rng.range(0, Math.PI * 2), r = Math.abs(rng.gauss()) * R * 0.35;
      cb.push({ p: [opt.position[0] + Math.cos(a) * r, opt.position[1] + rng.range(0, H), opt.position[2] + Math.sin(a) * r], seed: rng.float(), size: rng.range(0.5, 1.2), bright: rng.range(0.4, 1.2), color: rng.chance(0.2) ? hot : red });
    }
    column = makePoints(engine, cb, {
      mode: 'dot', color: '#ffffff', size: 0.014, brightness: 0.9, lit: 0, flicker: 0.5,
      drift: { vel: [0, 0.9, 0], box: [R * 4, H, R * 4], center: [opt.position[0], opt.position[1] + H / 2, opt.position[2]] },
    });
    column.name = 'energy-column';
  }

  const glow = glowSprite(engine, { color: opt.color, size: R * 12, intensity: 0.16, falloff: 2.8 });
  group.add(glow);
  const light = engine.lightRig.add({ name: 'energy', position: opt.position, color: opt.color, intensity: opt.intensity, range: opt.range });

  const state = { pulse: 0, intensity: 1, spin: 1 };
  const update = (t) => {
    const beat = Math.pow(0.5 + 0.5 * Math.sin(t * opt.pulseRate * Math.PI * 2 * 0.5), 3);
    const k = state.intensity * (1 + opt.pulseDepth * beat + state.pulse);
    light.intensity = opt.intensity * k;
    corePts.material.uniforms.uPulse.value = opt.pulseDepth * beat + state.pulse;
    shellPts.material.uniforms.uPulse.value = state.pulse * 0.5;
    glow.material.uniforms.uIntensity.value = 0.16 * k;
    wire.rotation.y = t * 0.15;
    wire.material.uniforms.uPulse.value = state.pulse * 0.6;
    corePts.rotation.y = t * 0.2;
    shellPts.rotation.y = -t * 0.12;
    for (const r of rings) r.ring.rotation.y = t * r.speed * state.spin;
  };
  return { object: group, column, light, state, update, glow };
}
