import * as THREE from 'three';
import { createSky } from '../src/env/Sky.js';
import { createGround } from '../src/env/Ground.js';
import { PointCloudCharacter } from '../src/characters/PointCloudCharacter.js';
import { emptyPose, walk, idle, openArms, raiseHand, applyPose } from '../src/characters/poses.js';
import { CameraRig } from '../src/anim/CameraRig.js';
import { keys, extendTimeline } from '../src/anim/Timeline.js';

// Character inspection turntable (12 s): idle 360 orbit at full body, walk-in-place from the side, then a slow
// push-in on the face. Neutral key + crimson back light, so readability can be judged without the environment.

export const meta = { name: 'character_test', duration: 12 };

export async function build(engine) {
  const { scene } = engine;
  engine.duration = meta.duration;
  Object.assign(engine.post.params, { exposure: 1.0, bloom: 0.8, threshold: 0.5, ca: 0.003, scan: 0.03, grain: 0.035, vignette: 0.45 });
  Object.assign(engine.params, { fogDensity: 0.02, fogStart: 6, fogColor: '#060607', aperture: 0.08 });
  engine.lightRig.setKey({ direction: [-0.5, 0.7, 0.6], color: '#c4ccd6', intensity: 0.45 });
  engine.lightRig.setAmbient('#20232a', 0.3);
  engine.lightRig.add({ name: 'back-red', position: [0.8, 1.8, -2.5], color: '#ff2a1f', intensity: 1.4, range: 5 });
  engine.lightRig.add({ name: 'amber', position: [-2.2, 1.2, 1.2], color: '#ffab40', intensity: 0.6, range: 4 });
  scene.add(createSky(engine, { glowAmount: 0.25 }).object);
  scene.add(createGround(engine, { size: 40, segments: 40, amp: 0, debris: 1500 }).object);

  const hero = PointCloudCharacter.procedural(engine, { seed: 7 });
  scene.add(hero.group);
  const st = { walk: 0, arms: 0, hand: 0 };
  engine.onUpdate((t) => {
    const pose = emptyPose();
    idle(pose, t, 1 - st.walk);
    walk(pose, t * 4.2, st.walk);
    openArms(pose, st.arms);
    raiseHand(pose, st.hand, 'R');
    applyPose(hero, pose);
    hero.updateHalo(t);
  });
  keys(engine, st, 'walk', [[3.6, 0], [4.0, 1], [6.6, 1], [7.0, 0]]);
  keys(engine, st, 'arms', [[7.2, 0], [8.2, 1], [9.2, 1], [9.8, 0]]);
  keys(engine, st, 'hand', [[9.6, 0], [10.6, 1]]);

  const orbit = (r, h, a0, a1) => {
    const pts = [];
    for (let i = 0; i <= 12; i++) { const a = a0 + (a1 - a0) * (i / 12); pts.push([Math.sin(a) * r, h, Math.cos(a) * r]); }
    return pts;
  };
  new CameraRig(engine, [
    { start: 0, end: 3.6, pos: orbit(3.4, 1.1, 0, Math.PI * 2), target: [[0, 0.95, 0]], fov: 42, ease: 'none', handheld: 0 },
    { start: 3.6, end: 7.0, pos: [[3.2, 1.0, 0.4], [3.0, 1.0, 0.8]], target: [[0, 0.9, 0]], fov: 42, ease: 'sine.inOut', handheld: 0 },
    { start: 7.0, end: 9.6, pos: [[0.4, 1.3, 3.2], [0.2, 1.35, 2.9]], target: [[0, 1.2, 0]], fov: 42, ease: 'sine.inOut', handheld: 0 },
    { start: 9.6, end: 12, pos: [[0.35, 1.66, 1.1], [0.2, 1.66, 0.75]], target: [[0, 1.62, 0]], fov: 38, ease: 'sine.inOut', handheld: 0 },
  ]);
  extendTimeline(engine, meta.duration);
  return { hero };
}
