import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSky } from '../src/env/Sky.js';
import { createGround } from '../src/env/Ground.js';
import { createAtmosphere } from '../src/env/Atmosphere.js';
import { PointCloudCharacter } from '../src/characters/PointCloudCharacter.js';
import { CameraRig } from '../src/anim/CameraRig.js';
import { keys, extendTimeline } from '../src/anim/Timeline.js';

// GLTF/GLB import test (6 s): any skinned or static model becomes a point cloud, keeps its skeleton and
// animation clips (driven deterministically with mixer.setTime), and gets the same treatment as the procedural human.
// URL params: glb=<path or URL> (default assets/models/CesiumMan.glb; run tools/fetch_sample_models.mjs), surface=1,
//             clip=<index>, haloBone=<bone name>, height=<metres to normalise to>, yaw=<radians>.

export const meta = { name: 'glb_test', duration: 6 };

export async function build(engine, { params }) {
  const { scene } = engine;
  engine.duration = meta.duration;
  Object.assign(engine.post.params, { bloom: 0.8, threshold: 0.5, ca: 0.003, grain: 0.035, vignette: 0.45 });
  Object.assign(engine.params, { fogDensity: 0.02, fogStart: 6, aperture: 0.08 });
  engine.lightRig.setKey({ direction: [-0.5, 0.7, 0.6], color: '#c4ccd6', intensity: 0.45 });
  engine.lightRig.setAmbient('#20232a', 0.3);
  engine.lightRig.add({ name: 'back-red', position: [0.6, 1.8, -2.4], color: '#ff2a1f', intensity: 1.4, range: 5 });
  engine.lightRig.add({ name: 'amber', position: [-2.0, 1.0, 1.4], color: '#ffab40', intensity: 0.7, range: 4 });
  scene.add(createSky(engine, { glowAmount: 0.3 }).object);
  scene.add(createGround(engine, { size: 40, segments: 40, amp: 0, debris: 1500 }).object);
  scene.add(createAtmosphere(engine, { dust: { count: 1500, center: [0, 1.5, 0], box: [8, 4, 8] } }).object);

  const url = params.get('glb') || './assets/models/CesiumMan.glb';
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(url);
  } catch (e) {
    throw new Error(`could not load ${url}. For the default model run: node tools/fetch_sample_models.mjs\n${e.message || e}`);
  }
  const model = gltf.scene;
  model.rotation.y = Number(params.get('yaw') || 0);
  // Normalise to a human height and stand the model on the ground at the origin.
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const k = Number(params.get('height') || 1.75) / Math.max(box.max.y - box.min.y, 1e-3);
  model.scale.multiplyScalar(k);
  model.updateMatrixWorld(true);
  box.setFromObject(model, true);
  model.position.sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));

  const haloBone = params.get('haloBone') || 'Skeleton_neck_joint_2';
  const ch = PointCloudCharacter.fromObject(engine, model, {
    count: 70000, sizeScale: 1.0, halo: { bone: haloBone, follow: true, offset: [0, 0.12, -0.12], radius: 0.19 },
    surface: params.get('surface') === '1', // the model's own mesh drawn as a text-textured surface
  });
  scene.add(ch.group);

  const mixer = new THREE.AnimationMixer(model);
  const clip = gltf.animations[Number(params.get('clip') || 0)];
  if (clip) mixer.clipAction(clip).play();
  engine.onUpdate((t) => {
    mixer.setTime(t);
    model.updateMatrixWorld(true);
    ch.updateHalo(t);
  });
  keys(engine, ch.state, 'emerge', [[0, 0], [1.6, 1, 'power2.out']]);

  const orbit = [];
  for (let i = 0; i <= 8; i++) { const a = -0.9 + 1.8 * (i / 8); orbit.push([Math.sin(a) * 3.0, 1.15, Math.cos(a) * 3.0]); }
  new CameraRig(engine, [{ start: 0, end: 6, pos: orbit, target: [[0, 0.95, 0]], fov: 42, ease: 'sine.inOut', handheld: 0.01 }]);
  extendTimeline(engine, meta.duration);
  return { ch, mixer, gltf };
}
