// Procedural poses for the procedural human (bones from HumanSDF). Pure functions of time/phase, so any frame
// can be evaluated in isolation (deterministic, resumable rendering).
// Convention: the figure faces +Z. Rotation x < 0 swings a hanging limb forward; z > 0 lifts the left arm out.

const ZERO = () => [0, 0, 0];

export function emptyPose() {
  return { rot: {}, root: [0, 0, 0], rootYaw: 0 };
}

function add(pose, bone, x = 0, y = 0, z = 0, w = 1) {
  const r = pose.rot[bone] || (pose.rot[bone] = ZERO());
  r[0] += x * w; r[1] += y * w; r[2] += z * w;
}

/** Walk cycle. phase in radians (2*pi per stride pair). w = blend weight. */
export function walk(pose, phase, w = 1, { stride = 0.42, arm = 0.34 } = {}) {
  const s = Math.sin(phase), c = Math.cos(phase);
  const knee = (ph) => 0.06 + 0.78 * Math.pow(Math.max(0, Math.cos(ph + 0.35)), 1.6);
  add(pose, 'thigh_L', -stride * s, 0, 0, w);
  add(pose, 'thigh_R', stride * s, 0, 0, w);
  add(pose, 'shin_L', knee(phase), 0, 0, w);
  add(pose, 'shin_R', knee(phase + Math.PI), 0, 0, w);
  add(pose, 'foot_L', -0.18 * Math.sin(phase + 0.9), 0, 0, w);
  add(pose, 'foot_R', 0.18 * Math.sin(phase + 0.9), 0, 0, w);
  add(pose, 'upperarm_L', arm * s, 0, 0.05, w);
  add(pose, 'upperarm_R', -arm * s, 0, -0.05, w);
  add(pose, 'forearm_L', -(0.22 + 0.25 * Math.max(0, -s)), 0, 0, w);
  add(pose, 'forearm_R', -(0.22 + 0.25 * Math.max(0, s)), 0, 0, w);
  add(pose, 'hips', 0, 0.1 * s, 0.035 * c, w);
  add(pose, 'chest', 0.04, -0.14 * s, -0.02 * c, w);
  add(pose, 'head', -0.03, 0.06 * s, 0.015 * c, w);
  pose.root[1] += (0.022 * Math.cos(2 * phase) - 0.012) * w;
}

/** Breathing, weight shift and a slow look-around. */
export function idle(pose, t, w = 1, { look = 0.25 } = {}) {
  const br = Math.sin(t * 1.55);
  add(pose, 'chest', -0.025 * br, 0, 0, w);
  add(pose, 'neck', 0.01 * br, 0, 0, w);
  add(pose, 'head', 0.04 * Math.sin(t * 0.37), look * Math.sin(t * 0.21 + 0.6), 0.03 * Math.sin(t * 0.29), w);
  add(pose, 'hips', 0, 0.03 * Math.sin(t * 0.25), 0.02 * Math.sin(t * 0.31), w);
  add(pose, 'upperarm_L', 0.03 * Math.sin(t * 0.7), 0, 0.07, w);
  add(pose, 'upperarm_R', 0.03 * Math.sin(t * 0.7 + 1), 0, -0.07, w);
  add(pose, 'forearm_L', -0.18, 0, 0, w);
  add(pose, 'forearm_R', -0.2, 0, 0, w);
  add(pose, 'shin_L', 0.04, 0, 0, w);
  add(pose, 'thigh_L', -0.02, 0, 0.02, w);
  add(pose, 'thigh_R', 0.01, 0, -0.03, w);
}

/** Arms open outwards and slightly forward, head lifts: an "awakening" / receiving gesture. amount 0..1. */
export function openArms(pose, amount, w = 1) {
  const a = amount * w;
  add(pose, 'upperarm_L', -0.25 * a, 0, 0.95 * a);
  add(pose, 'upperarm_R', -0.25 * a, 0, -0.95 * a);
  add(pose, 'forearm_L', -0.35 * a, 0, 0.15 * a);
  add(pose, 'forearm_R', -0.35 * a, 0, -0.15 * a);
  add(pose, 'hand_L', 0, 0, 0.2 * a);
  add(pose, 'hand_R', 0, 0, -0.2 * a);
  add(pose, 'chest', -0.06 * a, 0, 0);
  add(pose, 'head', -0.1 * a, 0, 0);
}

/** One hand raised towards the face/halo. amount 0..1. */
export function raiseHand(pose, amount, side = 'R', w = 1) {
  const a = amount * w, s = side === 'L' ? 1 : -1;
  add(pose, `upperarm_${side}`, -1.1 * a, 0, 0.35 * a * s);
  add(pose, `forearm_${side}`, -1.5 * a, 0.3 * a * s, 0);
  add(pose, `hand_${side}`, -0.2 * a, 0, 0);
  add(pose, 'head', -0.08 * a, -0.15 * a * s, 0);
}

/** Write a pose into the character's bones (rest orientation is identity, so Euler = pose rotation). */
export function applyPose(character, pose) {
  for (const [name, bone] of Object.entries(character.bones)) {
    const r = pose.rot[name];
    if (r) bone.rotation.set(r[0], r[1], r[2]); else bone.rotation.set(0, 0, 0);
  }
  const root = character.bones.root;
  root.position.set(pose.root[0], pose.root[1], pose.root[2]);
  root.rotation.y = pose.rootYaw;
}
