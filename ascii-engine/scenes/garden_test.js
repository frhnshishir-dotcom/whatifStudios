import * as THREE from 'three';
import { createSky } from '../src/env/Sky.js';
import { createGround } from '../src/env/Ground.js';
import { createPond } from '../src/env/Water.js';
import { createReeds, createPines } from '../src/env/Vegetation.js';
import { createLanterns } from '../src/env/Structures.js';
import { createPavilion } from '../src/env/Pavilion.js';
import { createBeam } from '../src/env/EnergySource.js';
import { createAtmosphere } from '../src/env/Atmosphere.js';
import { PointCloudCharacter } from '../src/characters/PointCloudCharacter.js';
import { emptyPose, walk, idle, raiseHand, applyPose } from '../src/characters/poses.js';
import { addReflection } from '../src/shaders/ParticleMaterial.js';
import { CameraRig } from '../src/anim/CameraRig.js';
import { keys, glitchBurst, pulse, extendTimeline } from '../src/anim/Timeline.js';
import { SET } from '../src/glyphs/GlyphAtlas.js';

// Reference-look test (16 s, 4:5 picture letterboxed in 9:16). Own composition built from the techniques seen in
// the reference: a text-textured figure with luminous rings wading in a night pond (reflections, afterimages on a
// dash), line-blade reeds with tip beads, pale-cyan pines, amber glyph lanterns, a pavilion with dash-tiled roof,
// a crimson beam with a cross flare, a smear-glitch drop into green terminal mode and back.

export const meta = { name: 'garden_test', duration: 16, letterbox: 0.8 };

const smooth = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };

export async function build(engine) {
  const { scene } = engine;
  engine.duration = meta.duration;
  Object.assign(engine.post.params, {
    exposure: 1.22, bloom: 0.85, bloomRadius: 1.0, threshold: 0.5, knee: 0.5, ca: 0.0025, scan: 0.0, grain: 0.03,
    vignette: 0.25, saturation: 0.95, contrast: 1.04, lift: '#060607', background: '#020203', termCell: [7, 12],
  });
  Object.assign(engine.params, { fogDensity: 0.022, fogStart: 6, fogColor: '#050506', aperture: 0.06 });
  engine.lightRig.setKey({ direction: [-0.4, 0.8, 0.45], color: '#b9c6d8', intensity: 0.5 });
  engine.lightRig.setAmbient('#22262e', 0.4);
  scene.add(createSky(engine, { zenith: '#010102', horizon: '#07080a', glowAmount: 0.0 }).object);

  // ---- world
  const pondC = [0, 0], pondR = 3.2;
  const ground = createGround(engine, {
    size: 110, segments: 170, amp: 4.5, scale: 0.05, seed: 6, holes: [{ center: pondC, radius: pondR, depth: 2.5 }],
    flat: (x, z) => 1 - THREE.MathUtils.smoothstep(Math.hypot(x, z + 4), 11, 22), // flat garden, text-covered hills behind
    glyphSet: SET.TEXT, cell: [0.12, 0.12], color: '#8a9a96', brightness: 1.0, gain: 1.5, debris: 0,
  });
  scene.add(ground.object);
  const pond = createPond(engine, { center: pondC, radius: pondR, level: 0.0 });
  scene.add(pond.object);
  const inPond = (x, z, m = 0.15) => Math.hypot(x - pondC[0], z - pondC[1]) < pondR + m;

  const pav = createPavilion(engine, { at: [0.6, -9.6], rotationY: 0.12, size: [12, 6], wallH: 3.2, roofH: 2.6, overhang: 1.5, heightAt: ground.heightAt });
  scene.add(pav.object);

  const reeds = createReeds(engine, {
    heightAt: ground.heightAt, avoid: (x, z) => inPond(x, z, -0.2),
    patches: [
      { at: [-3.9, 0.4], radius: 1.7, count: 420, height: [0.8, 1.8], lean: 0.5, colors: ['#5fa89a', '#86b08a', '#b9b878'] },
      { at: [3.8, -1.6], radius: 1.9, count: 440, height: [0.9, 1.9], lean: 0.45, colors: ['#5fa89a', '#6fa0a8', '#7ea87a'] },
      { at: [-2.2, -3.9], radius: 1.6, count: 360, height: [0.8, 1.7], lean: 0.4 },
      { at: [-2.9, 3.6], radius: 1.3, count: 260, height: [0.7, 1.5], lean: 0.55, colors: ['#b9b878', '#9fb07a'] },
      { at: [3.2, 3.2], radius: 1.4, count: 220, height: [0.6, 1.3], lean: 0.5 },
      // Grass carpet: short blades, few beads.
      ...[[-6, 0], [6, 0], [0, 5.5], [-5, -5], [5, -5.5], [-6.5, 4.5], [6.5, 4.5], [0, -6.2], [-9, -2], [9, -2.5]].map((at) => ({
        at, radius: 2.8, count: 1500, height: [0.12, 0.45], lean: 0.6, beads: 0.15, colors: ['#4f8a72', '#6a9a6a', '#86a874'],
      })),
    ],
  });
  scene.add(reeds.object);
  const pines = createPines(engine, { heightAt: ground.heightAt, pines: [{ at: [-5.6, -4.8], height: 3.8 }, { at: [5.3, -6.0], height: 3.2 }, { at: [4.6, 3.9], height: 2.6, pads: 5 }] });
  scene.add(pines.object);
  const lanterns = createLanterns(engine, { heightAt: ground.heightAt, at: [[-3.7, -2.6], [3.4, -3.4], [-1.6, 4.0], [-5.4, -5.9], [2.3, -5.3]] });
  scene.add(lanterns.object);
  const beam = createBeam(engine, { at: [-3.3, -5.3], y0: ground.heightAt(-3.3, -5.3), height: 11, radius: 0.85, intensity: 2.4, range: 10 });
  scene.add(beam.object);
  scene.add(createAtmosphere(engine, {
    dust: { count: 2600, center: [0, 2.2, -2], box: [16, 5, 16], color: '#d8dfe6', size: 0.01, brightness: 0.28 },
    embers: { count: 120, center: [0, 1.2, -1], box: [12, 2.2, 12], vel: [0.03, 0.04, 0.02], color: '#fff1c4', color2: '#ffe08a', size: 0.014, brightness: 1.5 },
  }).object);

  // ---- character: text-textured body, horizontal ring at the head, a sash ring, afterimage ghosts
  const hero = PointCloudCharacter.procedural(engine, { seed: 11, style: 'glyph', halo: false, hair: false });
  hero.addRing({ bone: 'head', offset: [0, 0.11, 0.0], radius: 0.25, plane: 'xz', count: 1800, size: 0.009, brightness: 2.4 });
  hero.addRing({ bone: 'spine', offset: [0, -0.08, 0.005], radius: [0.15, 0.115], plane: 'xz', count: 900, size: 0.008, brightness: 1.9 });
  const ghosts = hero.addGhosts(5, { falloff: 0.7 });
  scene.add(hero.group);
  for (const L of hero.layers) addReflection(engine, L.points, 0.42);
  hero.addSurfaceReflection(0.4);
  addReflection(engine, lanterns.points, 0.5);
  addReflection(engine, beam.cone, 0.35);
  addReflection(engine, beam.core, 0.35);

  // Path: a quick dash across the pond (0.3-1.5 s), then standing. Wading: root 0.32 m below the surface.
  const A = new THREE.Vector3(-2.0, -0.32, -1.7), B = new THREE.Vector3(0.35, -0.32, -0.75);
  const pathAt = (t) => A.clone().lerp(B, smooth((t - 0.3) / 1.2));
  const st = { hand: 0, look: 0.2 };
  const poseAt = (t) => {
    const pose = emptyPose();
    const dashing = t > 0.25 && t < 1.6 ? 1 : 0;
    const k = smooth((t - 0.25) / 0.2) * (1 - smooth((t - 1.35) / 0.3));
    idle(pose, t, 1 - k, { look: st.look });
    walk(pose, t * 9.0, k * dashing, { stride: 0.55, arm: 0.45 });
    raiseHand(pose, st.hand, 'R');
    const p = pathAt(t);
    pose.root = [p.x, p.y + pose.root[1], p.z];
    pose.rootYaw = 0.35 + 0.9 * k;
    return pose;
  };
  engine.onUpdate((t) => {
    applyPose(hero, poseAt(t));
    ghosts.forEach((g, i) => applyPose(g, poseAt(t - (i + 1) * 0.085)));
    beam.update(t);
    for (const r of hero.layers.slice(2)) r.points.material.uniforms.uPulse.value = beam.state.pulse * 0.8;
  });

  // ---- camera (4:5 picture)
  new CameraRig(engine, [
    { start: 0, end: 4.0, pos: [[2.7, 1.9, 4.1], [2.25, 1.95, 3.45]], target: (t) => pathAt(t).add(new THREE.Vector3(0, 0.95, 0)), fov: [44, 41], handheld: 0.012 },
    { start: 4.0, end: 8.0, pos: [[-1.5, 1.75, 2.1], [-1.15, 1.8, 1.7]], target: [[0.35, 1.3, -0.75], [0.35, 1.38, -0.75]], fov: [36, 33], handheld: 0.01 },
    { start: 8.0, end: 11.6, pos: [[8.0, 9.2, 9.6], [6.6, 8.6, 8.2]], target: [[-0.8, 1.2, -3.8], [-0.6, 1.0, -3.6]], fov: [46, 44], handheld: 0.02 },
    { start: 11.6, end: 14.4, pos: [[6.4, 8.5, 8.0], [4.8, 7.2, 6.4]], target: [[-0.6, 1.0, -3.6], [-0.3, 0.9, -3.0]], fov: [44, 42], handheld: 0.02 },
    { start: 14.4, end: 16, pos: [[2.7, 1.7, 3.0], [2.4, 1.75, 2.7]], target: [[0.35, 1.05, -0.75]], fov: [40, 38], handheld: 0.012 },
  ]);

  // ---- timeline
  keys(engine, hero.ghostState, 'intensity', [[0.25, 0], [0.45, 1, 'power2.out'], [1.5, 1], [2.3, 0, 'power2.in']]);
  keys(engine, beam.state, 'intensity', [[8.5, 0], [9.2, 1, 'power3.out']]);
  pulse(engine, beam.state, 'pulse', 9.0, { base: 0, peak: 1.4, up: 0.15, down: 1.6 });
  keys(engine, st, 'hand', [[8.7, 0], [9.6, 1, 'power2.out'], [11.6, 1], [12.4, 0]]);
  keys(engine, engine.post.params, 'smear', [[11.25, 0], [11.6, 1, 'power2.in'], [12.0, 0, 'power2.out'], [14.15, 0], [14.4, 0.8, 'power2.in'], [14.75, 0, 'power2.out']]);
  keys(engine, engine.post.params, 'terminal', [[11.55, 0], [11.75, 1, 'power1.out'], [14.25, 1], [14.45, 0, 'power1.in']]);
  keys(engine, engine.post.params, 'fade', [[0, 0.4], [0.4, 1], [15.3, 1], [16, 0.35, 'power1.in']]);
  glitchBurst(engine, 4.0, { duration: 0.3, peak: 0.5 });
  glitchBurst(engine, 8.0, { duration: 0.4, peak: 0.7 });
  glitchBurst(engine, 11.6, { duration: 0.5, peak: 0.6 });
  glitchBurst(engine, 14.4, { duration: 0.45, peak: 0.6 });
  extendTimeline(engine, meta.duration);
  return { hero, beam, pond, pav };
}
