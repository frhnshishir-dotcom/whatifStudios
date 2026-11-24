import * as THREE from 'three';
import { createSky } from '../src/env/Sky.js';
import { createGround } from '../src/env/Ground.js';
import { createStreet } from '../src/env/Street.js';
import { createBuilding } from '../src/env/Building.js';
import { createVegetation } from '../src/env/Vegetation.js';
import { createAtmosphere } from '../src/env/Atmosphere.js';
import { createEnergySource } from '../src/env/EnergySource.js';
import { createPylons } from '../src/env/Structures.js';
import { PointCloudCharacter } from '../src/characters/PointCloudCharacter.js';
import { emptyPose, walk, idle, openArms, applyPose } from '../src/characters/poses.js';
import { CameraRig } from '../src/anim/CameraRig.js';
import { keys, glitchBurst, pulse, extendTimeline } from '../src/anim/Timeline.js';

// PHASE 3 test scene (10 s). One particle human assembles from dust, walks towards camera down an ASCII street,
// stops and opens its arms while a crimson energy source flares behind it; a glitch cut moves to a closer angle.
// Then the figure dissolves. Contains: point-cloud character + halo, ASCII buildings, terrain, street, vegetation,
// red + amber lighting, atmosphere, a cinematic two-shot camera.

export const meta = { name: 'prototype', duration: 10 };

const smoother = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * x * (x * (x * 6 - 15) + 10); };

export async function build(engine) {
  const { scene } = engine;
  engine.duration = meta.duration;
  const portrait = engine.width < engine.height;

  // ---- look
  Object.assign(engine.post.params, {
    exposure: 1.05, bloom: 0.95, bloomRadius: 1.0, threshold: 0.45, knee: 0.5,
    ca: 0.0035, scan: 0.035, grain: 0.04, vignette: 0.5, saturation: 0.92, contrast: 1.06,
    lift: '#09090b', background: '#030304',
  });
  Object.assign(engine.params, { fogDensity: 0.03, fogStart: 4, fogColor: '#070708', aperture: 0.12 });
  engine.lightRig.setKey({ direction: [-0.45, 0.75, 0.55], color: '#b8c6d6', intensity: 0.42 });
  engine.lightRig.setAmbient('#20232a', 0.32);

  // ---- world
  const flat = (x, z) => 1 - THREE.MathUtils.smoothstep(Math.abs(x), 7.5, 13);
  const ground = createGround(engine, { flat, seed: 3, amp: 2.6, color: '#9eaab4' });
  scene.add(createSky(engine, { glowDir: [0.14, 0.3, -1], glowAmount: 0.35 }).object, ground.object);
  const street = createStreet(engine, {
    width: 7, z0: -90, z1: 14,
    lamps: [
      { at: [-4.3, -2.5], dir: 1, height: 4.4, intensity: 1.8, range: 9 },
      { at: [4.3, -20], dir: -1, height: 4.4, intensity: 1.4, range: 9 },
    ],
  });
  scene.add(street.object);

  const buildings = [
    createBuilding(engine, { at: [9.5, -13], size: [8, 34, 9], seed: 1, windowsLit: 0.26 }),
    createBuilding(engine, { at: [-11, -22], size: [9, 27, 9], seed: 2, windowsLit: 0.18, tiers: [[0.8, 1.0]] }),
    createBuilding(engine, { at: [3, -55], size: [12, 64, 12], seed: 3, windowsLit: 0.2 }),
    createBuilding(engine, { at: [-18, -48], size: [10, 42, 10], seed: 4, windowsLit: 0.12, tiers: [] }),
    createBuilding(engine, { at: [20, -40], size: [11, 50, 10], seed: 5, windowsLit: 0.15 }),
  ];
  for (const b of buildings) scene.add(b.object);
  scene.add(createPylons(engine, { at: [[-26, -8], [-26, -60], [-26, -112]], height: 24, heightAt: ground.heightAt }).object);

  const veg = createVegetation(engine, {
    heightAt: ground.heightAt,
    trees: [{ at: [-5.6, -6.5], height: 5.4, depth: 6 }, { at: [6.2, -4.0], height: 4.2, depth: 5, spread: 1.2 }],
    shrubs: [{ at: [-4.6, -0.6], radius: 0.9 }, { at: [-5.2, 2.2], radius: 0.7 }, { at: [4.8, 0.8], radius: 0.8 }],
    grass: [{ at: [-5.4, -2.5], radius: 2.2, count: 320 }, { at: [5.6, -1.5], radius: 2.0, count: 260 }, { at: [-4.8, 3.5], radius: 1.4, count: 160 }],
  });
  scene.add(veg.object);

  const energy = createEnergySource(engine, { position: [2.2, 6.2, -15], radius: 0.75, intensity: 3.0, range: 19 });
  scene.add(energy.object);
  if (energy.column) scene.add(energy.column);
  // Low crimson fill near the ground behind the figure: rim-lights the legs and reddens the street ASCII.
  const redFill = engine.lightRig.add({ name: 'red-fill', position: [-0.6, 0.4, -3.2], color: '#ff2a1f', intensity: 0.5, range: 5 });

  const atmo = createAtmosphere(engine, {
    dust: { count: 5200, center: [0, 2.6, -3], box: [16, 6, 18] },
    embers: { count: 900, center: [2.2, 5.5, -15], box: [5, 9, 5] },
    code: { count: 220, center: [0, 6, -14], box: [26, 12, 24] },
  });
  scene.add(atmo.object);

  // ---- character
  const hero = PointCloudCharacter.procedural(engine, { seed: 7, count: 52000 });
  scene.add(hero.group);
  const z0 = -1.6, D = 2.5, walkStart = 2.4, walkEnd = 7.0;
  const dist = (t) => D * smoother((t - walkStart) / (walkEnd - walkStart));
  const heroZ = (t) => z0 + dist(t);
  const state = { arms: 0 };
  const v = new THREE.Vector3();
  engine.onUpdate((t) => {
    const speed = (dist(t + 0.02) - dist(t - 0.02)) / 0.04;
    const walkW = Math.min(1, speed / 0.55);
    const pose = emptyPose();
    idle(pose, t, 1 - 0.85 * walkW, { look: 0.18 });
    walk(pose, (dist(t) / 1.3) * Math.PI * 2, walkW);
    openArms(pose, state.arms);
    pose.root[2] += heroZ(t);
    applyPose(hero, pose);
    hero.setVelocity(v.set(0, 0, speed));
    hero.updateHalo(t);
    energy.update(t);
  });

  // ---- camera (two shots, glitch cut at 5.6 s)
  const fov = (p, l) => (portrait ? p : l);
  const headTarget = (dy) => (t) => new THREE.Vector3(0, 1.32 + dy, heroZ(t) - 0.2);
  new CameraRig(engine, [
    { start: 0, end: 5.6, pos: [[1.2, 0.7, 5.6], [0.9, 0.95, 5.0], [0.6, 1.15, 4.4]], target: headTarget(-0.15), fov: [fov(48, 36), fov(44, 33)], ease: 'sine.inOut', handheld: 0.02, roll: [0.02, 0] },
    { start: 5.6, end: 10, pos: [[-0.75, 1.52, 3.55], [-0.5, 1.6, 3.05]], target: headTarget(0.16), fov: [fov(38, 28), fov(35, 26)], ease: 'sine.out', handheld: 0.012, roll: [-0.015, 0] },
  ]);

  // ---- timeline
  keys(engine, hero.state, 'emerge', [[0.15, 0], [2.6, 1, 'power2.out'], [8.9, 1], [10.0, 0.05, 'power2.in']]);
  keys(engine, hero.state, 'displace', [[0, 0.01], [8.9, 0.008], [10, 0.06, 'power2.in']]);
  keys(engine, hero.state, 'smear', [[0, 0.06]]);
  keys(engine, state, 'arms', [[7.2, 0], [8.4, 1, 'power2.inOut'], [10, 1]]);
  keys(engine, hero.halo.state, 'intensity', [[0.6, 0], [2.8, 1, 'power2.out']]);
  keys(engine, energy.state, 'intensity', [[0, 0.75], [7.4, 0.85], [7.9, 1.35, 'power2.out'], [10, 1.1]]);
  keys(engine, redFill, 'intensity', [[0, 0.35], [7.4, 0.4], [8.0, 1.1, 'power2.out'], [10, 0.7]]);
  keys(engine, engine.post.params, 'fade', [[0, 0.35], [0.5, 1, 'power1.out']]);
  pulse(engine, hero.halo.state, 'pulse', 7.6, { base: 0, peak: 1.6, up: 0.2, down: 1.4 });
  pulse(engine, energy.state, 'pulse', 7.6, { base: 0, peak: 0.9, up: 0.15, down: 1.2 });
  glitchBurst(engine, 5.6, { duration: 0.45, peak: 1 });
  glitchBurst(engine, 9.2, { duration: 0.8, peak: 0.6 });
  keys(engine, engine.params, 'aperture', [[0, 0.12], [5.59, 0.12], [5.6, 0.16, 'none'], [10, 0.16]]);
  extendTimeline(engine, meta.duration);

  return { hero, energy, buildings, ground, street, veg, atmo };
}
