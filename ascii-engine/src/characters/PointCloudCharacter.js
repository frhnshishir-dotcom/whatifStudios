import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/random.js';
import { ParticleBuilder, createParticleMaterial } from '../shaders/ParticleMaterial.js';
import { SET } from '../glyphs/GlyphAtlas.js';
import { JOINTS, PARENTS, BONE_NAMES, PRIMITIVES, sdf, gradient, project, featureCurves, occlusion, curvature, surfaceNets } from './HumanSDF.js';
import { createSkinnedGlyphMaterial } from '../shaders/GlyphSurfaceMaterial.js';

// SYSTEM B: point-cloud characters.
//   PointCloudCharacter.procedural(engine, opts)    procedural human (SDF anatomy + 26-bone skeleton)
//   PointCloudCharacter.fromObject(engine, obj, o)  any GLTF/GLB scene, skinned or static
// Layers per character: luminous body dots (+ bright anatomical feature clusters), ASCII/stroke marks,
// a depth-only occluder body (keeps the silhouette readable), and an optional halo.
// Skinning runs in the particle vertex shader through the skeleton's bone texture.

// Styles: 'particles' = luminous point cloud with sparse ASCII marks; 'glyph' = body covered in tiny monospace
// letters over dim dots (the reference look: a mesh textured with text).
const STYLES = {
  particles: { markFraction: 0.16, strokeChance: 0.55, markSet: 'CHAR', dotChance: 1, markSizeMin: 0.6, look: {} },
  glyph: { surface: true, features: ['iris'], markFraction: 0.04, strokeChance: 0, markSet: 'CHAR', dotChance: 0.22, dotLift: 0.004, markSizeMin: 0.75, look: { bodyBrightness: 0.3, markSize: 0.014, markBrightness: 0.5, rim: 0.4 } },
};

const DEFAULT_LOOK = {
  bodyColor: '#e4e9f0',
  featureColor: '#ffffff',
  markColor: '#cfd8e2',
  accent: '#ff2a1f',
  bodySize: 0.0048,
  bodyBrightness: 0.45,
  markSize: 0.017,
  markBrightness: 0.3,
  rim: 0.75,
  flicker: 0.12,
};

export class PointCloudCharacter {
  constructor(engine) {
    this.engine = engine;
    this.group = new THREE.Group();
    this.group.name = 'PointCloudCharacter';
    this.layers = [];       // particle materials (for global controls: emerge, displace, smear...)
    this.halo = null;
    this.bones = {};
    this.mixer = null;
    this.state = { emerge: 1, displace: 0, smear: 0, glitchSlice: 1, brightness: 1 };
  }

  // ---------------------------------------------------------------- procedural human
  static procedural(engine, opts = {}) {
    const style = STYLES[opts.style || 'particles'];
    const o = { seed: 7, count: 110000, hair: true, halo: true, headDensity: 2.4, handDensity: 1.7, ...style, ...opts };
    const look = { ...DEFAULT_LOOK, ...style.look, ...(opts.look || {}) };
    const ch = new PointCloudCharacter(engine);
    const rng = new Rng('human', o.seed);
    const density = engine.density;

    // Skeleton (rest orientation identity; joints at JOINTS).
    const boneList = BONE_NAMES.map((name) => {
      const b = new THREE.Bone();
      b.name = name;
      ch.bones[name] = b;
      return b;
    });
    for (const name of BONE_NAMES) {
      const b = ch.bones[name], parent = PARENTS[name];
      const j = JOINTS[name];
      if (parent) {
        const pj = JOINTS[parent];
        b.position.set(j[0] - pj[0], j[1] - pj[1], j[2] - pj[2]);
        ch.bones[parent].add(b);
      } else {
        b.position.set(j[0], j[1], j[2]);
      }
    }
    const boneIndex = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
    const primBone = PRIMITIVES.map((p) => boneIndex[p.bone]);

    // Skin weights: the two nearest bones by primitive distance, blended over ~1.6 cm.
    const dists = new Float32Array(PRIMITIVES.length);
    const weightsAt = (x, y, z) => {
      sdf(x, y, z, dists);
      const best = new Map();
      for (let k = 0; k < dists.length; k++) {
        const b = primBone[k];
        if (!best.has(b) || dists[k] < best.get(b)) best.set(b, dists[k]);
      }
      const sorted = [...best.entries()].sort((a, b) => a[1] - b[1]);
      const [b1, d1] = sorted[0];
      const [b2, d2] = sorted[1] ?? [b1, 1];
      let w2 = Math.exp(-(d2 - d1) / 0.016);
      if (w2 < 0.03) w2 = 0;
      const s = 1 + w2;
      return { skinIndex: [b1, b2, 0, 0], skinWeight: [1 / s, w2 / s, 0, 0] };
    };

    // Body mesh the particles ride on. Default: shrunk primitives, rigidly skinned, depth only (occluder).
    // surface: a smooth surface-nets mesh of the SDF, skinned with the same weights and textured with glyphs
    // (the reference look: a body made of text). It occludes too.
    let mesh;
    if (o.surface) {
      const sn = surfaceNets(density < 0.5 ? 0.012 : 0.008);
      const nv = sn.positions.length / 3;
      const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4), shadeA = new Float32Array(nv);
      for (let v = 0; v < nv; v++) {
        const p = [sn.positions[v * 3], sn.positions[v * 3 + 1], sn.positions[v * 3 + 2]];
        const n = [sn.normals[v * 3], sn.normals[v * 3 + 1], sn.normals[v * 3 + 2]];
        const w = weightsAt(...p);
        si.set(w.skinIndex, v * 4); sw.set(w.skinWeight, v * 4);
        const curv = p[1] > 1.5 || Math.abs(p[0]) > 0.21 && p[1] < 0.95 ? THREE.MathUtils.clamp((curvature(p) - 30) / 110, -1, 0.8) : 0;
        shadeA[v] = (0.25 + 0.75 * occlusion(p, n)) * (1 + 0.5 * curv);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(sn.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(sn.normals, 3));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      geo.setAttribute('aShade', new THREE.Float32BufferAttribute(shadeA, 1));
      geo.setIndex(sn.indices);
      const surfOpts = { glyphSet: SET.BODY, cell: [0.0095, 0.0135], color: look.surfaceColor ?? '#e9eef5', base: '#050506', brightness: 1.2, gain: 1.2, jitter: 0.55, frag: 0.05, fragScale: 3, seed: o.seed, emissive: 0.14, hueMix: 0.45, rim: 0.55, emerge: { value: 1, range: [-0.05, 1.85] } };
      mesh = new THREE.SkinnedMesh(geo, createSkinnedGlyphMaterial(engine, surfOpts));
      mesh.name = 'body-surface';
      ch.surfaceOpts = surfOpts;
    } else {
      mesh = new THREE.SkinnedMesh(buildOccluder(PRIMITIVES, primBone, 0.012), depthOnlyMaterial());
      mesh.name = 'occluder';
    }
    mesh.frustumCulled = false;
    mesh.renderOrder = 10; // after the opaque environment, so it hides particles but never punches holes in it
    mesh.add(ch.bones.root);
    ch.group.add(mesh);
    ch.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(boneList);
    mesh.bind(skeleton, mesh.matrixWorld.clone());
    skeleton.computeBoneTexture();
    ch.mesh = mesh;
    ch.skeleton = skeleton;

    // --- surface sampling (uniform by area: rejection in a thin shell, each primitive owns its region)
    const N = Math.round(o.count * density);
    const eps = 0.0035;
    const candPerM3 = (N * 1.2) / (1.95 * 2 * eps);
    const samples = [];
    PRIMITIVES.forEach((q, i) => {
      if (q.neg) return;
      const pad = eps + 0.012;
      const lo = q.min.map((v) => v - pad), hi = q.max.map((v) => v + pad);
      const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
      // Faces and hands get more particles (they carry the readability).
      const mul = q.bone === 'head' ? o.headDensity : q.bone.startsWith('hand') ? o.handDensity : 1;
      const nc = Math.round(vol * candPerM3 * mul);
      for (let c = 0; c < nc; c++) {
        const x = rng.range(lo[0], hi[0]), y = rng.range(lo[1], hi[1]), z = rng.range(lo[2], hi[2]);
        const d = sdf(x, y, z);
        if (Math.abs(d) > eps) continue;
        sdf(x, y, z, dists);
        let near = 0;
        for (let k = 1; k < dists.length; k++) if (dists[k] < dists[near]) near = k;
        if (near !== i) continue;
        samples.push({ x, y, z, prim: i, d });
      }
    });
    // Trim to N (keeps uniformity: drop a random subset).
    for (let i = samples.length - 1; i > 0; i--) { const j = Math.floor(rng.float() * (i + 1)); [samples[i], samples[j]] = [samples[j], samples[i]]; }
    samples.length = Math.min(samples.length, N);


    const dots = new ParticleBuilder();
    const marks = new ParticleBuilder();
    const DASH = engine.atlas.index('stroke', 'DASH');
    const HAIR = engine.atlas.index('stroke', 'HAIR');
    const headPrims = new Set(PRIMITIVES.filter((p) => p.tag === 'cranium').map((p) => p.id));
    const crown = [0, 1.79, -0.01];

    for (const s of samples) {
      const g = gradient(s.x, s.y, s.z);
      const p = [s.x - g[0] * s.d, s.y - g[1] * s.d, s.z - g[2] * s.d];
      const sk = weightsAt(p[0], p[1], p[2]);
      const seed = rng.float();
      // Shading baked per particle: occlusion darkens crevices (eye sockets, armpits, mouth), curvature makes
      // ridges (nose, brow, cheekbones, knuckles, collarbones) glow. This is what defines the anatomy.
      const ao = occlusion(p, g);
      const isDetail = PRIMITIVES[s.prim].bone === 'head' || PRIMITIVES[s.prim].bone.startsWith('hand');
      const curv = isDetail ? THREE.MathUtils.clamp((curvature(p) - 30) / 110, -1, 0.8) : 0;
      // Denser regions get dimmer particles so their summed light doesn't saturate and hide the shading.
      const mul = PRIMITIVES[s.prim].bone === 'head' ? o.headDensity : PRIMITIVES[s.prim].bone.startsWith('hand') ? o.handDensity : 1;
      const shade = ((0.3 + 0.7 * ao) * (1 + 0.45 * curv)) / Math.pow(mul, 0.65);
      // Slight thickness: a few particles float just off the skin (volumetric shimmer).
      const lift = (o.dotLift ?? 0) + (rng.chance(0.07) ? rng.range(0.002, 0.012) : 0);
      const pp = [p[0] + g[0] * lift, p[1] + g[1] * lift, p[2] + g[2] * lift];
      // dotChance < 1 only: drawing a random number when it is 1 would shift the seeded stream and change
      // every existing particle-style character (breaks reproducibility of earlier cuts).
      if (o.dotChance >= 1 || rng.chance(o.dotChance)) dots.push({ p: pp, n: g, seed, size: rng.range(0.7, 1.35), bright: rng.range(0.65, 1.15) * shade * (lift ? 0.6 : 1), ...sk });

      if (rng.chance(o.markFraction)) {
        // Tiny strokes along the limb axis (muscle-fibre direction) or ASCII marks from the character ramp.
        const ax = PRIMITIVES[s.prim].axis;
        const dn = ax[0] * g[0] + ax[1] * g[1] + ax[2] * g[2];
        const t = [ax[0] - g[0] * dn, ax[1] - g[1] * dn, ax[2] - g[2] * dn];
        const stroke = rng.chance(o.strokeChance);
        marks.push({
          p: [p[0] + g[0] * 0.002, p[1] + g[1] * 0.002, p[2] + g[2] * 0.002], n: g, seed: rng.float(),
          size: stroke ? rng.range(0.7, 1.1) : rng.range(o.markSizeMin ?? 0.6, 1.0), bright: rng.range(0.5, 1.1) * (o.markSet === 'BODY' ? shade : 1),
          tangent: stroke ? t : [0, 0, 0], glyph: stroke ? DASH : -1, ...sk,
        });
      }
      // Hair: short strokes on the scalp, combed away from the crown.
      if (o.hair && headPrims.has(s.prim) && p[1] > 1.655 && (p[2] < 0.055 || p[1] > 1.735) && rng.chance(0.75)) {
        const v = [p[0] - crown[0], p[1] - crown[1], p[2] - crown[2]];
        const vn = v[0] * g[0] + v[1] * g[1] + v[2] * g[2];
        const t = [v[0] - g[0] * vn, v[1] - g[1] * vn, v[2] - g[2] * vn];
        const off = rng.range(0.004, 0.012);
        marks.push({ p: [p[0] + g[0] * off, p[1] + g[1] * off, p[2] + g[2] * off], n: g, seed: rng.float(), size: rng.range(0.9, 1.3), bright: rng.range(0.5, 0.9), tangent: t, glyph: HAIR, ...sk });
      }
    }

    // Bright anatomical feature clusters.
    for (const c of featureCurves()) {
      if (o.features && !o.features.includes(c.tag)) continue;
      if (c.cluster) {
        const n = Math.max(3, Math.round(c.cluster * Math.sqrt(density)));
        for (let k = 0; k < n; k++) {
          const q = c.pts[0];
          const p = project([q[0] + rng.gauss() * c.radius, q[1] + rng.gauss() * c.radius, q[2] + rng.gauss() * c.radius * 0.5], 3);
          const g = gradient(...p);
          dots.push({ p: [p[0] + g[0] * 0.0015, p[1] + g[1] * 0.0015, p[2] + g[2] * 0.0015], n: g, seed: rng.float(), size: rng.range(0.8, 1.3), bright: c.bright * rng.range(0.8, 1.2) / look.bodyBrightness * 0.45, ...weightsAt(...p) });
        }
        continue;
      }
      for (let k = 0; k < c.pts.length - 1; k++) {
        const a = c.pts[k], b = c.pts[k + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const n = Math.max(1, Math.round(len * c.density * density));
        for (let m = 0; m < n; m++) {
          const u = (m + rng.float()) / n;
          const j = c.jitter;
          const q = [a[0] + (b[0] - a[0]) * u + rng.gauss() * j, a[1] + (b[1] - a[1]) * u + rng.gauss() * j, a[2] + (b[2] - a[2]) * u];
          const p = project(q, 3);
          const g = gradient(...p);
          const fl = 0.0015 + (o.dotLift ?? 0);
          dots.push({ p: [p[0] + g[0] * fl, p[1] + g[1] * fl, p[2] + g[2] * fl], n: g, seed: rng.float(), size: rng.range(0.8, 1.2), bright: c.bright * rng.range(0.8, 1.2) / look.bodyBrightness * 0.45, ...weightsAt(...p) });
        }
      }
    }

    ch._addSkinnedLayer(dots, mesh, {
      mode: 'dot', color: look.bodyColor, color2: look.accent, size: look.bodySize, brightness: look.bodyBrightness,
      lit: 0.85, rim: look.rim, flicker: look.flicker, emerge: { scale: 7, scatter: 0.9 },
    });
    ch._addSkinnedLayer(marks, mesh, {
      mode: 'stroke', glyphSet: SET[o.markSet], color: look.markColor, color2: look.accent, size: look.markSize,
      brightness: look.markBrightness, lit: 0.9, rim: look.rim * 0.6, flicker: 0.3, glyphMinPx: 5, emerge: { scale: 7, scatter: 1.1 },
    });
    ch.counts = { dots: dots.count, marks: marks.count };

    if (o.halo) ch.addHalo(o.halo === true ? {} : o.halo);
    engine.onAfterMatrix(() => ch._afterMatrix());
    return ch;
  }

  /**
   * A luminous ring on a bone: dense bright dots on an ellipse with a soft outer glow ring. Rest orientation of the
   * procedural bones is identity, so plane 'xz' is horizontal (a brim-level halo, a sash) and 'xy' faces forward.
   * opts: bone, offset [x,y,z] (bone space), radius [rx, rz] or r, plane, count, color, brightness, size, thickness, tilt.
   */
  addRing(opts = {}) {
    const o = { bone: 'head', offset: [0, 0.12, 0], radius: 0.22, plane: 'xz', count: 1400, color: '#ffffff', brightness: 2.2, size: 0.009, thickness: 0.004, tilt: 0, ...opts };
    const rng = new Rng('ring', o.bone, o.offset.join(','));
    const [rx, rz] = Array.isArray(o.radius) ? o.radius : [o.radius, o.radius];
    const b = new ParticleBuilder();
    const n = Math.round(o.count * Math.max(0.5, this.engine.density));
    const put = (u, v, w) => (o.plane === 'xz' ? [u, w, v] : [u, v, w]);
    for (let i = 0; i < n; i++) {
      const t = rng.range(0, Math.PI * 2);
      const glow = rng.chance(0.25);
      const k = 1 + (glow ? Math.abs(rng.gauss()) * 0.08 : 0);
      const p = put(Math.cos(t) * rx * k + rng.gauss() * o.thickness, Math.sin(t) * rz * k + rng.gauss() * o.thickness, rng.gauss() * o.thickness);
      b.push({ p, seed: rng.float(), size: glow ? rng.range(0.6, 1.2) : rng.range(0.8, 1.3), bright: glow ? rng.range(0.15, 0.4) : rng.range(0.8, 1.2) });
    }
    const pts = new THREE.Points(b.build(), createParticleMaterial(this.engine, {
      mode: 'dot', color: o.color, size: o.size, brightness: o.brightness, lit: 0, flicker: 0.05, emerge: { scale: 9, scatter: 0.4 },
    }));
    pts.frustumCulled = false;
    const holder = new THREE.Group();
    holder.position.set(...o.offset);
    holder.rotation.x = o.tilt;
    holder.add(pts);
    (this.bones[o.bone] || this.group).add(holder);
    this.layers.push({ points: pts, skinned: false });
    return pts;
  }

  /**
   * Afterimage ghosts (procedural characters): n extra skeletons sharing the body particle geometry. Pose each with
   * applyPose(ghost, pose) like the main character; ghost.opacity scales its brightness. ghostState.intensity fades all.
   */
  addGhosts(n = 4, { falloff = 0.62, tint = null, fraction = 0.4 } = {}) {
    this.ghosts = [];
    this.ghostState = { intensity: 0 };
    const bodyLayers = this.layers.filter((l) => l.skinned && l.mesh === this.mesh);
    for (let g = 0; g < n; g++) {
      const bones = {};
      const list = BONE_NAMES.map((name) => {
        const bone = new THREE.Bone();
        bone.name = name;
        bone.position.copy(this.bones[name].position);
        bones[name] = bone;
        return bone;
      });
      for (const name of BONE_NAMES) if (PARENTS[name]) bones[PARENTS[name]].add(bones[name]);
      this.group.add(bones.root);
      const skeleton = new THREE.Skeleton(list, this.skeleton.boneInverses.map((m) => m.clone()));
      skeleton.computeBoneTexture();
      const layers = bodyLayers.map((L) => {
        const m = createParticleMaterial(this.engine, { ...L.points.material.userData.opts, ...(tint ? { color: tint } : {}) });
        m.uniforms.uBoneTex.value = skeleton.boneTexture;
        // Same attribute buffers, own draw range: a ghost draws a random subset (samples are stored shuffled).
        const src = L.points.geometry, geo = new THREE.BufferGeometry();
        for (const [k, attr] of Object.entries(src.attributes)) geo.setAttribute(k, attr);
        geo.setDrawRange(0, Math.floor(src.getAttribute('position').count * fraction));
        const pts = new THREE.Points(geo, m);
        pts.frustumCulled = false;
        this.group.add(pts);
        return pts;
      });
      // Glyph-surface bodies get a surface ghost too (additive copy of the text body on the ghost skeleton).
      if (this.surfaceOpts) {
        const gm = createSkinnedGlyphMaterial(this.engine, this.surfaceOpts);
        Object.assign(gm, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: false });
        const gmesh = new THREE.SkinnedMesh(this.mesh.geometry, gm);
        gmesh.frustumCulled = false;
        gmesh.renderOrder = 12;
        this.group.add(gmesh);
        gmesh.bind(skeleton, new THREE.Matrix4());
        layers.push(gmesh);
      }
      this.ghosts.push({ bones, skeleton, layers, opacity: Math.pow(falloff, g + 1) });
    }
    return this.ghosts;
  }

  // ---------------------------------------------------------------- GLTF / GLB / any mesh
  /**
   * Convert every mesh under `object` (e.g. gltf.scene) into a point cloud. Skinned meshes keep their skeleton
   * (animate with this.mixer / gltf.animations); the original meshes become depth-only occluders.
   * opts: count, markFraction, edges (bright feature-edge particles), look, halo {headBone, offset, radius},
   * surface (true: the model's own mesh is drawn as a glyph-textured surface instead of a hidden occluder).
   */
  static fromObject(engine, object, opts = {}) {
    const o = { seed: 3, count: 50000, markFraction: 0.2, edges: true, halo: false, look: {}, ...opts };
    const look = { ...DEFAULT_LOOK, ...o.look };
    const ch = new PointCloudCharacter(engine);
    const rng = new Rng('mesh', o.seed);
    ch.group.add(object);
    object.updateMatrixWorld(true);

    const meshes = [];
    object.traverse((m) => { if (m.isMesh) meshes.push(m); if (m.isBone) ch.bones[m.name] = m; });
    if (!meshes.length) throw new Error('fromObject: no meshes found');
    const areas = meshes.map((m) => meshArea(m));
    const total = areas.reduce((a, b) => a + b, 0);
    const DASH = engine.atlas.index('stroke', 'DASH');

    meshes.forEach((mesh, mi) => {
      const n = Math.max(200, Math.round((o.count * engine.density * areas[mi]) / total));
      const geo = mesh.geometry;
      if (!geo.getAttribute('normal')) geo.computeVertexNormals();
      const sampler = triangleSampler(geo, rng);
      const skinned = !!mesh.isSkinnedMesh;
      const si = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
      const dots = new ParticleBuilder(), marks = new ParticleBuilder();
      const pushSkin = (rec, vi) => skinned ? { ...rec, skinIndex: [si.getX(vi), si.getY(vi), si.getZ(vi), si.getW(vi)], skinWeight: [sw.getX(vi), sw.getY(vi), sw.getZ(vi), sw.getW(vi)] } : rec;
      for (let k = 0; k < n; k++) {
        const s = sampler();
        dots.push(pushSkin({ p: s.p, n: s.n, seed: rng.float(), size: rng.range(0.7, 1.35), bright: rng.range(0.6, 1.2) }, s.vi));
        if (rng.chance(o.markFraction)) {
          const stroke = rng.chance(0.5);
          marks.push(pushSkin({ p: s.p, n: s.n, seed: rng.float(), size: rng.range(0.6, 1.1), bright: rng.range(0.5, 1.1), tangent: stroke ? s.t : [0, 0, 0], glyph: stroke ? DASH : -1 }, s.vi));
        }
      }
      // Feature edges (creases / silhouette edges of the model) as bright particle lines.
      if (o.edges) {
        const edges = sharpEdges(geo, 35);
        for (const e of edges) {
          const m = Math.max(1, Math.round(e.len * 220 * engine.density));
          for (let q = 0; q < m; q++) {
            const u = rng.float();
            const p = e.a.map((v, j) => v + (e.b[j] - v) * u);
            dots.push(pushSkin({ p, n: e.n, seed: rng.float(), size: 1.0, bright: 2.2 }, u < 0.5 ? e.ia : e.ib));
          }
        }
      }
      const matOpts = { color2: look.accent, flicker: look.flicker, emerge: { scale: 2.5, scatter: 0.9 }, skinned, skinBones: 4 };
      const mk = (b, mo) => {
        const pts = new THREE.Points(b.build(), createParticleMaterial(engine, { ...matOpts, ...mo }));
        pts.frustumCulled = false;
        mesh.add(pts);
        ch.layers.push({ points: pts, mesh, skinned });
      };
      mk(dots, { mode: 'dot', color: look.bodyColor, size: look.bodySize * (o.sizeScale ?? 1), brightness: look.bodyBrightness, lit: 0.85, rim: look.rim });
      if (marks.count) mk(marks, { mode: 'stroke', glyphSet: SET.CHAR, color: look.markColor, size: look.markSize * (o.sizeScale ?? 1), brightness: look.markBrightness, lit: 0.9, rim: look.rim * 0.6, flicker: 0.3, glyphMinPx: 5 });
      // The source mesh becomes a depth-only occluder (still skinned by three.js), drawn after the environment,
      // or with surface: true a glyph-textured body (text mapped in the mesh's rest pose).
      if (o.surface) {
        if (!geo.getAttribute('aShade')) geo.setAttribute('aShade', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count).fill(1), 1));
        const sc = new THREE.Vector3();
        mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
        mesh.material = createSkinnedGlyphMaterial(engine, { glyphSet: SET.BODY, cell: [0.0085, 0.012], color: '#e9eef5', base: '#050506', brightness: 1.15, gain: 1.5, jitter: 0.55, frag: 0.05, fragScale: 3, seed: o.seed, emissive: 0.14, hueMix: 0.45, rim: 0.55, mapScale: (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 });
      } else mesh.material = depthOnlyMaterial();
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      if (skinned && !mesh.skeleton.boneTexture) mesh.skeleton.computeBoneTexture();
    });
    if (o.halo) ch.addHalo(o.halo === true ? {} : o.halo);
    engine.onAfterMatrix(() => ch._afterMatrix());
    return ch;
  }

  /** Mirror the glyph body surface into the pond (additive, below the water line). */
  addSurfaceReflection(amount = 0.35) {
    if (!this.surfaceOpts) return null;
    const m = createSkinnedGlyphMaterial(this.engine, { ...this.surfaceOpts, reflectMode: true, reflect: amount });
    const r = new THREE.SkinnedMesh(this.mesh.geometry, m);
    r.frustumCulled = false;
    r.renderOrder = 11;
    this.group.add(r);
    r.bind(this.skeleton, this.mesh.bindMatrix.clone());
    this.surfaceReflection = r;
    return r;
  }

  _addSkinnedLayer(builder, mesh, matOpts) {
    const pts = new THREE.Points(builder.build(), createParticleMaterial(this.engine, { ...matOpts, skinned: true }));
    pts.frustumCulled = false;
    mesh.add(pts);
    this.layers.push({ points: pts, mesh, skinned: true });
    return pts;
  }

  _afterMatrix() {
    for (const L of this.layers) {
      const u = L.points.material.uniforms;
      if (L.skinned) {
        L.mesh.skeleton.update();
        u.uBoneTex.value = L.mesh.skeleton.boneTexture;
        u.uBindMatrix.value.copy(L.mesh.bindMatrix);
        u.uBindMatrixInverse.value.copy(L.mesh.bindMatrixInverse);
      }
      if (u.uEmerge) u.uEmerge.value = this.state.emerge;
      u.uDisplace.value = this.state.displace;
      u.uSmear.value = this.state.smear;
      u.uSliceAmt.value = this.state.glitchSlice;
    }
    if (this.mesh?.material?.uniforms?.uEmerge) this.mesh.material.uniforms.uEmerge.value = this.state.emerge;
    if (this.surfaceReflection) this.surfaceReflection.material.uniforms.uEmerge.value = this.state.emerge;
    if (this.ghosts) {
      const k = this.ghostState.intensity;
      for (const gh of this.ghosts) {
        gh.skeleton.update();
        for (const pts of gh.layers) {
          pts.visible = k > 0.001;
          const u = pts.material.uniforms;
          if (u.uBindMatrixInverse) u.uBindMatrixInverse.value.copy(this.group.matrixWorld).invert();
          u.uOpacity.value = k * gh.opacity;
          if (u.uEmerge) u.uEmerge.value = this.state.emerge;
        }
      }
    }
  }

  /** World-space velocity of the character root (m/s), drives the particle smear. */
  setVelocity(v) {
    for (const L of this.layers) L.points.material.uniforms.uVelocity.value.copy(v);
  }

  // ---------------------------------------------------------------- halo
  /**
   * Luminous halo behind the head: dotted main ring, dashed inner ring, radial ticks, orbiting code glyphs and
   * a crimson dust ring. Two counter-rotating layers. opts: bone, offset [x,y,z] (bone space), radius, color, accent.
   * follow: true keeps the halo upright in world space and only tracks the bone's position (+ offset in world
   * metres): use it for imported models whose bone orientations are arbitrary.
   */
  addHalo(opts = {}) {
    const engine = this.engine;
    const o = { bone: 'head', offset: [0, 0.095, -0.135], radius: 0.2, color: '#ffe0b0', accent: '#ff2a1f', count: 900, follow: false, ...opts };
    const rng = new Rng('halo', o.radius);
    const bone = this.bones[o.bone];
    if (!bone) console.warn(`addHalo: bone ${o.bone} not found; halo attached to the character root`);
    const parent = o.follow || !bone ? this.group : bone;
    const holder = new THREE.Group();
    holder.position.set(...o.offset);
    parent.add(holder);
    const dens = Math.max(0.5, engine.density);
    const R = o.radius;
    const accent = new THREE.Color(o.accent);
    const acc = [accent.r / 0.9, accent.g / 0.9 + 0.05, accent.b / 0.9 + 0.05];
    const atlas = engine.atlas;
    const DOT = atlas.index('mark', 'DOT'), DASH = atlas.index('stroke', 'DASH');

    const a = new ParticleBuilder();
    const nMain = Math.round(o.count * dens);
    for (let i = 0; i < nMain; i++) {
      const t = (i / nMain) * Math.PI * 2, r = R + rng.gauss() * 0.0025;
      a.push({ p: [Math.cos(t) * r, Math.sin(t) * r, 0], seed: rng.float(), size: rng.range(0.7, 1.1), bright: rng.range(0.8, 1.4), glyph: DOT });
    }
    for (let i = 0; i < 72; i++) {
      const t = (i / 72) * Math.PI * 2, r = R + 0.03 + (i % 6 === 0 ? 0.008 : 0);
      a.push({ p: [Math.cos(t) * r, Math.sin(t) * r, 0], seed: rng.float(), size: i % 6 === 0 ? 1.6 : 1.0, bright: 1.1, tangent: [Math.cos(t), Math.sin(t), 0], glyph: DASH });
    }
    const codeRow = SET.CODE;
    for (let i = 0; i < 18; i++) {
      const t = (i / 18) * Math.PI * 2 + 0.1, r = R + 0.075;
      a.push({ p: [Math.cos(t) * r, Math.sin(t) * r, 0], seed: rng.float(), size: 1.3, bright: 0.7, glyph: codeRow * 16 + rng.int(0, 11), color: acc });
    }
    const b = new ParticleBuilder();
    for (let i = 0; i < 110; i++) {
      const t = (i / 110) * Math.PI * 2, r = R * 0.8;
      b.push({ p: [Math.cos(t) * r, Math.sin(t) * r, 0.01], seed: rng.float(), size: 1.0, bright: 0.8, tangent: [-Math.sin(t), Math.cos(t), 0], glyph: DASH });
    }
    const nDust = Math.round(700 * dens);
    for (let i = 0; i < nDust; i++) {
      const t = rng.range(0, Math.PI * 2), r = R * 1.05 + Math.abs(rng.gauss()) * 0.05;
      b.push({ p: [Math.cos(t) * r, Math.sin(t) * r, rng.gauss() * 0.01], seed: rng.float(), size: rng.range(0.4, 0.9), bright: rng.range(0.4, 1.0), glyph: DOT, color: acc });
    }
    const mat = (size, bright) => createParticleMaterial(engine, { mode: 'stroke', color: o.color, color2: o.accent, size, brightness: bright, lit: 0, flicker: 0.25, glyphMinPx: 4, emerge: { scale: 9, scatter: 0.4 } });
    const ringA = new THREE.Points(a.build(), mat(0.012, 1.4));
    const ringB = new THREE.Points(b.build(), mat(0.012, 1.0));
    ringA.frustumCulled = ringB.frustumCulled = false;
    holder.add(ringA, ringB);
    this.halo = { holder, ringA, ringB, follow: o.follow && bone ? { bone, offset: new THREE.Vector3(...o.offset) } : null, state: { spin: 0.12, pulse: 0, emerge: 1, intensity: 1 } };
    this.layers.push({ points: ringA, skinned: false }, { points: ringB, skinned: false });
    return this.halo;
  }

  /** Per-frame halo animation: counter-rotation and pulse. Call from a scene update hook. */
  updateHalo(t) {
    if (!this.halo) return;
    const h = this.halo, s = h.state;
    if (h.follow) {
      const v = h.holder.position;
      h.follow.bone.updateWorldMatrix(true, false);
      h.follow.bone.getWorldPosition(v).add(h.follow.offset);
      this.group.updateWorldMatrix(true, false);
      this.group.worldToLocal(v);
    }
    h.ringA.rotation.z = -t * s.spin;
    h.ringB.rotation.z = t * s.spin * 1.6;
    for (const r of [h.ringA, h.ringB]) {
      r.material.uniforms.uPulse.value = s.pulse;
      r.material.uniforms.uOpacity.value = s.intensity;
    }
  }
}

// ---------------------------------------------------------------- helpers
export function depthOnlyMaterial() {
  return new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
}

function buildOccluder(prims, primBone, shrink) {
  const skip = new Set(['ear', 'nose', 'finger', 'thumb', 'brow', 'chin', 'cheek', 'lip', 'eyeball', 'toes']);
  const parts = [];
  const tagRigid = (geo, bone) => {
    const n = geo.getAttribute('position').count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = bone; sw[i * 4] = 1; }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    return geo;
  };
  prims.forEach((q, i) => {
    if (skip.has(q.tag)) return;
    if (q.neg) return;
    // The head shrinks more, so recessed eyes and lips stay in front of the occluder.
    const sh = q.bone === 'head' ? shrink * 1.9 : shrink;
    if (q.type === 'e') {
      const g = new THREE.SphereGeometry(1, 14, 10);
      g.scale(Math.max(q.r[0] - sh, 0.005), Math.max(q.r[1] - sh, 0.005), Math.max(q.r[2] - sh, 0.005));
      g.translate(...q.c);
      parts.push(tagRigid(g, primBone[i]));
    } else {
      const a = new THREE.Vector3(...q.a), b = new THREE.Vector3(...q.b);
      const len = a.distanceTo(b);
      const ra = Math.max(q.ra - sh, 0.005), rb = Math.max(q.rb - sh, 0.005);
      const cyl = new THREE.CylinderGeometry(rb, ra, len, 12, 1, true);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      cyl.applyQuaternion(quat);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      cyl.translate(mid.x, mid.y, mid.z);
      const ca = new THREE.SphereGeometry(ra, 10, 8).translate(a.x, a.y, a.z);
      const cb = new THREE.SphereGeometry(rb, 10, 8).translate(b.x, b.y, b.z);
      for (const g of [cyl, ca, cb]) parts.push(tagRigid(g, primBone[i]));
    }
  });
  const geo = mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
  return geo;
}

function meshArea(mesh) {
  const g = mesh.geometry, pos = g.getAttribute('position'), idx = g.index;
  const s = new THREE.Vector3();
  mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  const k = Math.abs(s.x * s.y * s.z) ** (2 / 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  const tri = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    area += b.sub(a).cross(c.sub(a)).length() * 0.5;
  }
  return area * k;
}

/** Area-weighted triangle sampler: returns () => { p, n, t, vi } with vi the dominant vertex (for skin data). */
export function triangleSampler(geo, rng) {
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), idx = geo.index;
  const tri = idx ? idx.count / 3 : pos.count / 3;
  const cum = new Float64Array(tri);
  const ids = new Uint32Array(tri * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let acc = 0;
  for (let t = 0; t < tri; t++) {
    for (let k = 0; k < 3; k++) ids[t * 3 + k] = idx ? idx.getX(t * 3 + k) : t * 3 + k;
    a.fromBufferAttribute(pos, ids[t * 3]); b.fromBufferAttribute(pos, ids[t * 3 + 1]); c.fromBufferAttribute(pos, ids[t * 3 + 2]);
    acc += b.sub(a).cross(c.sub(a)).length() * 0.5;
    cum[t] = acc;
  }
  return () => {
    const r = rng.float() * acc;
    let lo = 0, hi = tri - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
    let u = rng.float(), v = rng.float();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    const i0 = ids[lo * 3], i1 = ids[lo * 3 + 1], i2 = ids[lo * 3 + 2];
    const p = [0, 1, 2].map((j) => pos.getComponent(i0, j) * w + pos.getComponent(i1, j) * u + pos.getComponent(i2, j) * v);
    const n = [0, 1, 2].map((j) => nor.getComponent(i0, j) * w + nor.getComponent(i1, j) * u + nor.getComponent(i2, j) * v);
    const nl = Math.hypot(...n) || 1;
    const e = [0, 1, 2].map((j) => pos.getComponent(i1, j) - pos.getComponent(i0, j));
    const el = Math.hypot(...e) || 1;
    const vi = w >= u && w >= v ? i0 : u >= v ? i1 : i2;
    return { p, n: n.map((x) => x / nl), t: e.map((x) => x / el), vi };
  };
}

/** Edges whose adjacent faces meet at more than `angle` degrees (creases and outlines). */
function sharpEdges(geo, angle) {
  const eg = new THREE.EdgesGeometry(geo, angle);
  const p = eg.getAttribute('position');
  const pos = geo.getAttribute('position');
  // Map edge endpoints back to the nearest source vertex (for skin data) with a coarse spatial hash.
  const key = (x, y, z) => `${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`;
  const map = new Map();
  for (let i = 0; i < pos.count; i++) map.set(key(pos.getX(i), pos.getY(i), pos.getZ(i)), i);
  const out = [];
  for (let i = 0; i < p.count; i += 2) {
    const a = [p.getX(i), p.getY(i), p.getZ(i)], b = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out.push({ a, b, len, n: [0, 0, 0], ia: map.get(key(...a)) ?? 0, ib: map.get(key(...b)) ?? 0 });
  }
  return out;
}
