import * as THREE from 'three';

// Small geometry helpers shared by the environment generators.

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/**
 * Sample particles along segment a->b every `spacing` metres (with jitter) and push them to a ParticleBuilder.
 * opts: glyph (fixed glyph index or -1), size, bright, color, jitter, param(t) (0..1 along the segment -> aRand.w),
 * normal, tangent (defaults to the segment direction).
 */
export function sampleSegment(builder, rng, a, b, spacing, opts = {}) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  if (len < 1e-6) return 0;
  const t = opts.tangent ?? d.map((x) => x / len);
  const n = Math.max(1, Math.round(len / spacing));
  const j = opts.jitter ?? 0;
  for (let i = 0; i < n; i++) {
    const u = (i + (opts.regular ? 0.5 : rng.float())) / n;
    builder.push({
      p: [a[0] + d[0] * u + rng.gauss() * j, a[1] + d[1] * u + rng.gauss() * j, a[2] + d[2] * u + rng.gauss() * j],
      n: opts.normal ?? [0, 0, 0],
      seed: rng.float(),
      size: (opts.size ?? 1) * rng.range(0.85, 1.15),
      bright: (opts.bright ?? 1) * rng.range(0.75, 1.15),
      param: opts.param ? opts.param(u) : 0,
      color: opts.color ?? [1, 1, 1],
      tangent: t,
      glyph: opts.glyph ?? -1,
    });
  }
  return n;
}

/** The 12 edges of an axis-aligned box (min, max) as [a, b] pairs. */
export function boxEdges(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return e.map(([i, j]) => [c[i], c[j]]);
}

/** Linear-space RGB triple from a CSS colour, for aColor tints. */
export function tint(css, k = 1) {
  const c = new THREE.Color(css);
  return [c.r * k, c.g * k, c.b * k];
}

/** Camera-facing additive glow quad (one draw call; cheaper than a huge point sprite). */
export function glowSprite(engine, { color = '#ff2a1f', size = 6, intensity = 0.6, falloff = 2.2 } = {}) {
  const c = new THREE.Color(color);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
      uIntensity: { value: intensity },
      uFalloff: { value: falloff },
      uGlitch: engine.shared.uGlitch,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += position.xy * scale;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uIntensity; uniform float uFalloff;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        float a = pow(max(1.0 - r, 0.0), uFalloff) * uIntensity;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.scale.setScalar(size);
  m.frustumCulled = false;
  return m;
}

/** Camera-facing cross flare (anamorphic horizontal streak + thinner vertical streak + white-hot core). */
export function flareSprite(engine, { color = '#ff2a1f', core = '#ffffff', size = 6, intensity = 1, vertical = 0.6 } = {}) {
  const c = new THREE.Color(color), k = new THREE.Color(core);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
      uCore: { value: new THREE.Vector3(k.r, k.g, k.b) },
      uIntensity: { value: intensity },
      uVertical: { value: vertical },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += position.xy * scale;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uCore; uniform float uIntensity; uniform float uVertical;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv;
        float h = exp(-abs(p.y) * 140.0) * pow(max(1.0 - abs(p.x), 0.0), 1.5);
        float v = exp(-abs(p.x) * 160.0) * pow(max(1.0 - abs(p.y), 0.0), 1.5) * uVertical;
        float core = exp(-dot(p, p) * 900.0);
        float halo = exp(-dot(p, p) * 60.0) * 0.25;
        vec3 col = uColor * (h + v + halo) + uCore * core * 3.0;
        gl_FragColor = vec4(col * uIntensity, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.scale.setScalar(size);
  m.frustumCulled = false;
  return m;
}
