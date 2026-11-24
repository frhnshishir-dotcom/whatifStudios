// Procedural human: anatomical primitives (ellipsoids + tapered capsules) blended with a smooth union, each
// owned by a bone. Proportions follow a ~7.5-head canon for a 1.78 m adult. Model space: metres, +Y up,
// the figure faces +Z, +X is the figure's left. Rest pose: relaxed A-pose (arms hanging slightly out).

const J = {
  root: [0, 0, 0],
  hips: [0, 0.97, 0],
  spine: [0, 1.1, 0],
  chest: [0, 1.3, 0],
  neck: [0, 1.48, -0.012],
  head: [0, 1.585, 0],
  clavicle_L: [0.025, 1.46, 0],
  upperarm_L: [0.185, 1.425, -0.01],
  forearm_L: [0.222, 1.15, -0.02],
  hand_L: [0.243, 0.893, 0],
  thigh_L: [0.09, 0.935, 0],
  shin_L: [0.1, 0.52, 0.01],
  foot_L: [0.105, 0.085, -0.02],
};
const PARENT = {
  hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  clavicle_L: 'chest', upperarm_L: 'clavicle_L', forearm_L: 'upperarm_L', hand_L: 'forearm_L',
  thigh_L: 'hips', shin_L: 'thigh_L', foot_L: 'shin_L',
};

function mirrorName(n) { return n.endsWith('_L') ? n.slice(0, -2) + '_R' : n; }
function mx(v) { return [-v[0], v[1], v[2]]; }

// Joint table and parent table including mirrored right side.
export const JOINTS = { ...J };
export const PARENTS = { ...PARENT };
for (const [k, v] of Object.entries(J)) if (k.endsWith('_L')) JOINTS[mirrorName(k)] = mx(v);
for (const [k, v] of Object.entries(PARENT)) if (k.endsWith('_L')) PARENTS[mirrorName(k)] = mirrorName(v);
export const BONE_NAMES = Object.keys(JOINTS);

// ---- primitives -------------------------------------------------------------------------------
// neg: true = smooth subtraction (carves eye sockets etc. after the union).
const prims = [];
const E = (c, r, bone, k = 0.028, tag = '', neg = false) => prims.push({ type: 'e', c, r, bone, k, tag, neg });
const C = (a, b, ra, rb, bone, k = 0.028, tag = '') => prims.push({ type: 'c', a, b, ra, rb, bone, k, tag, neg: false });
const sym = (fn) => { fn((v) => v, (b) => b); fn(mx, mirrorName); };

// Head
E([0, 1.675, -0.008], [0.077, 0.1, 0.098], 'head', 0.02, 'cranium');
E([0, 1.605, 0.028], [0.06, 0.07, 0.07], 'head', 0.025, 'face');
E([0, 1.558, 0.052], [0.03, 0.024, 0.03], 'head', 0.02, 'chin');
E([0, 1.684, 0.07], [0.058, 0.016, 0.03], 'head', 0.012, 'brow');
C([0, 1.66, 0.088], [0, 1.622, 0.107], 0.011, 0.015, 'head', 0.012, 'nose');
E([0, 1.5935, 0.092], [0.021, 0.0055, 0.011], 'head', 0.006, 'lip');
E([0, 1.5825, 0.09], [0.019, 0.0065, 0.011], 'head', 0.006, 'lip');
sym((m, b) => {
  E(m([0.042, 1.624, 0.062]), [0.024, 0.02, 0.024], b('head'), 0.015, 'cheek');
  E(m([0.078, 1.642, -0.006]), [0.012, 0.03, 0.02], b('head'), 0.008, 'ear');
  E(m([0.033, 1.654, 0.077]), [0.0125, 0.0115, 0.0115], b('head'), 0.004, 'eyeball');
});
// Carved after the union: eye sockets and the mouth line.
sym((m, b) => { E(m([0.033, 1.657, 0.098]), [0.02, 0.012, 0.016], b('head'), 0.01, 'socket', true); });
// Neck and torso
C([0, 1.465, -0.018], [0, 1.585, -0.005], 0.052, 0.046, 'neck', 0.03, 'neck');
E([0, 1.33, 0], [0.15, 0.16, 0.1], 'chest', 0.035, 'ribcage');
E([0, 1.32, -0.04], [0.158, 0.13, 0.07], 'chest', 0.03, 'back');
sym((m, b) => {
  E(m([0.066, 1.372, 0.052]), [0.075, 0.055, 0.045], b('chest'), 0.03, 'pec');
  C(m([0.0, 1.48, -0.03]), m([0.15, 1.445, -0.02]), 0.045, 0.04, b('chest'), 0.035, 'trap');
});
E([0, 1.14, 0.01], [0.124, 0.13, 0.088], 'spine', 0.035, 'abdomen');
E([0, 1.05, 0], [0.13, 0.07, 0.09], 'spine', 0.03, 'waist');
E([0, 0.96, 0], [0.155, 0.1, 0.1], 'hips', 0.035, 'pelvis');
sym((m, b) => {
  E(m([0.065, 0.92, -0.045]), [0.075, 0.09, 0.07], b('hips'), 0.03, 'glute');
  // Arms
  E(m([0.19, 1.41, -0.005]), [0.055, 0.07, 0.055], b('upperarm_L'), 0.03, 'deltoid');
  C(m([0.19, 1.4, -0.01]), m([0.222, 1.16, -0.02]), 0.046, 0.037, b('upperarm_L'), 0.025, 'upperarm');
  C(m([0.222, 1.15, -0.02]), m([0.243, 0.9, 0]), 0.04, 0.027, b('forearm_L'), 0.02, 'forearm');
  E(m([0.226, 1.08, -0.012]), [0.04, 0.07, 0.04], b('forearm_L'), 0.02, 'forearm_m');
  E(m([0.249, 0.836, 0.006]), [0.02, 0.05, 0.042], b('hand_L'), 0.012, 'palm');
  for (let f = 0; f < 4; f++) {
    const z = -0.022 + f * 0.017, len = [0.068, 0.08, 0.076, 0.06][f];
    C(m([0.25, 0.795, z]), m([0.252, 0.795 - len, z + 0.004]), 0.0095, 0.007, b('hand_L'), 0.005, 'finger');
  }
  C(m([0.243, 0.86, 0.032]), m([0.236, 0.805, 0.06]), 0.011, 0.0085, b('hand_L'), 0.006, 'thumb');
  // Legs
  C(m([0.09, 0.92, 0]), m([0.1, 0.53, 0.01]), 0.085, 0.055, b('thigh_L'), 0.03, 'thigh');
  E(m([0.095, 0.75, 0.025]), [0.064, 0.16, 0.06], b('thigh_L'), 0.03, 'quad');
  E(m([0.1, 0.52, 0.035]), [0.04, 0.04, 0.03], b('shin_L'), 0.02, 'knee');
  C(m([0.1, 0.51, 0.01]), m([0.105, 0.1, -0.015]), 0.05, 0.033, b('shin_L'), 0.025, 'shin');
  E(m([0.1, 0.37, -0.03]), [0.047, 0.11, 0.048], b('shin_L'), 0.025, 'calf');
  E(m([0.105, 0.05, -0.035]), [0.034, 0.042, 0.04], b('foot_L'), 0.02, 'heel');
  E(m([0.108, 0.038, 0.05]), [0.042, 0.032, 0.095], b('foot_L'), 0.025, 'foot');
  E(m([0.112, 0.025, 0.12]), [0.04, 0.02, 0.035], b('foot_L'), 0.02, 'toes');
});

export const PRIMITIVES = prims.map((p, i) => {
  const q = { ...p, id: i };
  if (p.type === 'e') {
    q.min = p.c.map((v, j) => v - p.r[j]);
    q.max = p.c.map((v, j) => v + p.r[j]);
    const big = p.r.indexOf(Math.max(...p.r));
    q.axis = [0, 0, 0]; q.axis[big] = 1;
    q.r2 = p.r.map((v) => v * v);
  } else {
    const r = Math.max(p.ra, p.rb);
    q.min = p.a.map((v, j) => Math.min(v, p.b[j]) - r);
    q.max = p.a.map((v, j) => Math.max(v, p.b[j]) + r);
    q.ba = p.b.map((v, j) => v - p.a[j]);
    q.baba = q.ba[0] ** 2 + q.ba[1] ** 2 + q.ba[2] ** 2;
    const l = Math.sqrt(q.baba);
    q.axis = q.ba.map((v) => v / l);
  }
  return q;
});

function primDist(q, x, y, z) {
  if (q.type === 'e') {
    const px = x - q.c[0], py = y - q.c[1], pz = z - q.c[2];
    const k0 = Math.sqrt((px * px) / q.r2[0] + (py * py) / q.r2[1] + (pz * pz) / q.r2[2]);
    const k1 = Math.sqrt((px * px) / (q.r2[0] * q.r2[0]) + (py * py) / (q.r2[1] * q.r2[1]) + (pz * pz) / (q.r2[2] * q.r2[2]));
    return k1 < 1e-9 ? -Math.min(...q.r) : (k0 * (k0 - 1)) / k1;
  }
  const pax = x - q.a[0], pay = y - q.a[1], paz = z - q.a[2];
  let h = (pax * q.ba[0] + pay * q.ba[1] + paz * q.ba[2]) / q.baba;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - q.ba[0] * h, dy = pay - q.ba[1] * h, dz = paz - q.ba[2] * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (q.ra + (q.rb - q.ra) * h);
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

const POS = PRIMITIVES.filter((q) => !q.neg);
const NEG = PRIMITIVES.filter((q) => q.neg);

/**
 * Body SDF: smooth union of the positive primitives, then smooth subtraction of the negative ones.
 * If `out` (Float32Array of PRIMITIVES.length) is given, per-primitive distances are written to it
 * (negative primitives get +1e9, so they never own samples or skin weights).
 */
export function sdf(x, y, z, out) {
  let d = 1e9;
  for (let i = 0; i < POS.length; i++) {
    const q = POS[i];
    // Cheap reject: far outside the primitive's box contributes nothing to the smooth union.
    if (!out) {
      const ox = Math.max(q.min[0] - x, 0, x - q.max[0]), oy = Math.max(q.min[1] - y, 0, y - q.max[1]), oz = Math.max(q.min[2] - z, 0, z - q.max[2]);
      if (Math.sqrt(ox * ox + oy * oy + oz * oz) > d + q.k) continue;
    }
    const di = primDist(q, x, y, z);
    if (out) out[q.id] = di;
    d = smin(d, di, q.k);
  }
  for (let i = 0; i < NEG.length; i++) {
    const q = NEG[i];
    if (out) out[q.id] = 1e9;
    const ox = Math.max(q.min[0] - x, 0, x - q.max[0]), oy = Math.max(q.min[1] - y, 0, y - q.max[1]), oz = Math.max(q.min[2] - z, 0, z - q.max[2]);
    if (Math.sqrt(ox * ox + oy * oy + oz * oz) > q.k) continue;
    d = -smin(-d, primDist(q, x, y, z), q.k);
  }
  return d;
}

/** Ambient occlusion from the SDF (1 = open, 0 = deep crevice): darkens eye sockets, armpits, between fingers. */
export function occlusion(p, n) {
  let ao = 0, w = 1;
  for (let i = 1; i <= 5; i++) {
    const h = 0.003 + 0.007 * i;
    ao += (h - sdf(p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h)) * w;
    w *= 0.75;
  }
  return Math.min(1, Math.max(0, 1 - 9 * ao));
}

/** Mean-curvature proxy (Laplacian of the SDF): > 0 convex (nose tip, brow, knuckles), < 0 concave. */
export function curvature(p, e = 0.005) {
  const [x, y, z] = p;
  const c = sdf(x, y, z);
  return (sdf(x + e, y, z) + sdf(x - e, y, z) + sdf(x, y + e, z) + sdf(x, y - e, z) + sdf(x, y, z + e) + sdf(x, y, z - e) - 6 * c) / (e * e);
}

export function gradient(x, y, z, e = 0.0008) {
  const gx = sdf(x + e, y, z) - sdf(x - e, y, z);
  const gy = sdf(x, y + e, z) - sdf(x, y - e, z);
  const gz = sdf(x, y, z + e) - sdf(x, y, z - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
}

/** Move a point onto the surface (a few Newton steps along the gradient). */
export function project(p, iters = 4) {
  let [x, y, z] = p;
  for (let i = 0; i < iters; i++) {
    const d = sdf(x, y, z);
    const g = gradient(x, y, z);
    x -= g[0] * d; y -= g[1] * d; z -= g[2] * d;
  }
  return [x, y, z];
}

// Anatomical feature curves (model space, before projection). Sampled brighter to define face and body.
export function featureCurves() {
  const curves = [];
  const arc = (c, rx, ry, a0, a1, z = 0, n = 24) => {
    const pts = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push([c[0] + Math.cos(a) * rx, c[1] + Math.sin(a) * ry, c[2] + z]); }
    return pts;
  };
  const line = (a, b) => [a, b];
  const add = (pts, o) => curves.push({ pts, jitter: 0.002, ...o });
  // Kept deliberately sparse: anatomy should read from particle density, occlusion and curvature, with these
  // as faint bright clusters (not drawn outlines).
  for (const s of [1, -1]) {
    add([[0.033 * s, 1.654, 0.09]], { bright: 2.6, cluster: 26, radius: 0.0032, tag: 'iris' });
    add(arc([0.034 * s, 1.677, 0.084], 0.022, 0.005, 0.2 * Math.PI, 0.8 * Math.PI), { bright: 1.25, density: 1800, tag: 'brow' });
    add([[0.072 * s, 1.6, 0.005], [0.06 * s, 1.572, 0.035], [0.034 * s, 1.553, 0.062]], { bright: 1.15, density: 1200, tag: 'jaw' });
    add([[0.02 * s, 1.462, 0.06], [0.07 * s, 1.47, 0.05], [0.15 * s, 1.462, 0.02]], { bright: 1.15, density: 1400, tag: 'clavicle' });
    for (let f = 0; f < 5; f++) add([[0.252 * s, 0.795 - 0.072, -0.022 + f * 0.017]], { bright: 1.7, cluster: 6, radius: 0.004, tag: 'fingertip' });
  }
  add([[0, 1.672, 0.096], [0, 1.64, 0.104], [0, 1.622, 0.113]], { bright: 1.35, density: 1800, tag: 'nose' });
  add([[0, 1.07, 0.1]], { bright: 1.4, cluster: 12, radius: 0.006, tag: 'navel' });
  add(line([0, 1.55, -0.06], [0, 0.98, -0.11]), { bright: 1.1, density: 1000, tag: 'spine' });
  return curves;
}

/**
 * Smooth body mesh from the SDF (surface nets): returns { positions, normals, indices } in rest-pose model space.
 * h = grid cell size in metres (0.008 gives ~30k vertices). Vertices are projected onto the surface and get
 * SDF-gradient normals, so the mesh matches the particle surface closely.
 */
export function surfaceNets(h = 0.008) {
  const min = [-0.34, -0.03, -0.22], max = [0.34, 1.83, 0.22];
  const nx = Math.ceil((max[0] - min[0]) / h) + 1, ny = Math.ceil((max[1] - min[1]) / h) + 1, nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const idx3 = (i, j, k) => (k * ny + j) * nx + i;
  const vals = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    vals[idx3(i, j, k)] = sdf(min[0] + i * h, min[1] + j * h, min[2] + k * h);
  }
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const pos = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { v[c] = vals[idx3(i + corners[c][0], j + corners[c][1], k + corners[c][2])]; if (v[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
      sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
      sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
      n++;
    }
    cellVert[idx3(i, j, k)] = pos.length / 3;
    pos.push(min[0] + (i + sx / n) * h, min[1] + (j + sy / n) * h, min[2] + (k + sz / n) * h);
  }
  const ind = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) ind.push(a, c, b, a, d, c); else ind.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const s0 = vals[idx3(i, j, k)] < 0, s1 = vals[idx3(i + 1, j, k)] < 0; // x edges
    if (s0 !== s1) quad(cellVert[idx3(i, j - 1, k - 1)], cellVert[idx3(i, j, k - 1)], cellVert[idx3(i, j, k)], cellVert[idx3(i, j - 1, k)], s1);
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const s0 = vals[idx3(i, j, k)] < 0, s1 = vals[idx3(i, j + 1, k)] < 0; // y edges
    if (s0 !== s1) quad(cellVert[idx3(i - 1, j, k - 1)], cellVert[idx3(i - 1, j, k)], cellVert[idx3(i, j, k)], cellVert[idx3(i, j, k - 1)], s1);
  }
  for (let k = 0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const s0 = vals[idx3(i, j, k)] < 0, s1 = vals[idx3(i, j, k + 1)] < 0; // z edges
    if (s0 !== s1) quad(cellVert[idx3(i - 1, j - 1, k)], cellVert[idx3(i, j - 1, k)], cellVert[idx3(i, j, k)], cellVert[idx3(i - 1, j, k)], s1);
  }
  const normals = new Float32Array(pos.length);
  for (let p = 0; p < pos.length; p += 3) {
    const q = project([pos[p], pos[p + 1], pos[p + 2]], 2);
    pos[p] = q[0]; pos[p + 1] = q[1]; pos[p + 2] = q[2];
    const g = gradient(q[0], q[1], q[2]);
    normals[p] = g[0]; normals[p + 1] = g[1]; normals[p + 2] = g[2];
  }
  return { positions: new Float32Array(pos), normals, indices: ind };
}
