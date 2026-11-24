import * as THREE from 'three';
import { common, sharedUniforms, lighting, fog, atlas, particleFx, skinning } from './chunks.js';

// SYSTEM D: the particle shader. One THREE.Points draw per layer. Three modes:
//   dot    - soft luminous particle (point cloud)
//   glyph  - upright ASCII glyph; the glyph is picked from a luminance ramp (aGlyph < 0) or fixed (aGlyph >= 0)
//   stroke - fixed glyph rotated along the particle's tangent (tiny strokes, dashes, hair, grass)
// Features are compiled in with #defines so each layer only pays for what it uses.

const vertex = /* glsl */ `
${common}
${sharedUniforms}
${lighting}
${fog}
${atlas}
${particleFx}
#ifdef SKINNED
${skinning}
#endif
uniform float uSizeComp;
uniform float uMaxPoint;
uniform float uMinPoint;
uniform float uFocus;
uniform float uAperture;
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uSize;
uniform float uBrightness;
uniform float uLit;
uniform float uRim;
uniform float uFlicker;
uniform float uDisplace;
uniform float uOpacity;
uniform float uGlyphSet;
uniform float uRampGain;
uniform float uGlyphJitter;
uniform float uEmerge;
uniform float uEmergeScale;
uniform float uScatter;
uniform vec3 uVelocity;
uniform float uSmear;
uniform float uSway;
uniform float uSwayFreq;
uniform vec3 uDriftVel;
uniform vec3 uDriftBox;
uniform vec3 uDriftCenter;
uniform float uPulse;

attribute vec4 aRand;     // x seed, y size mult, z brightness mult, w param (sway weight / height 0..1)
attribute vec3 aColor;    // per-particle tint
attribute vec3 aTangent;  // stroke direction (object space), zero if none
attribute float aGlyph;   // >= 0 fixed glyph index, < 0 = luminance ramp of uGlyphSet

varying vec3 vColor;
varying float vAlpha;
varying float vGlyph;
varying float vAngle;
varying float vSizePx;
varying float vSoft;

void main() {
  float seed = aRand.x;
  vec3 p = position;
  vec3 n = normal;
  vec3 tng = aTangent;
  float hasN = step(0.25, dot(n, n));
#ifdef SKINNED
  mat4 sm = skinMatrix();
  p = (sm * vec4(p, 1.0)).xyz;
  n = mat3(sm) * n;
  tng = mat3(sm) * tng;
#endif
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  n = hasN > 0.5 ? normalize(mat3(modelMatrix) * n) : vec3(0.0);
  tng = mat3(modelMatrix) * tng;

#ifdef DRIFT
  vec3 q = wp + uDriftVel * uTime
         + vec3(sin(uTime * 0.31 + seed * 40.0), cos(uTime * 0.23 + seed * 17.0), sin(uTime * 0.27 + seed * 29.0)) * 0.3;
  wp = uDriftCenter + mod(q - uDriftCenter + uDriftBox * 0.5, uDriftBox) - uDriftBox * 0.5;
#endif
#ifdef SWAY
  float sw = aRand.w * aRand.w;
  float wave = sin(uTime * uSwayFreq + wp.x * 0.35 + wp.z * 0.27) + 0.45 * sin(uTime * uSwayFreq * 2.3 + wp.z * 0.9 + seed * 3.0);
  wp.x += wave * uSway * sw;
  wp.z += 0.5 * wave * uSway * sw * cos(seed * 6.2831);
#endif
  if (uDisplace > 0.0) {
    float dn = vnoise(position * 3.1 + vec3(0.0, uTime * 0.9, seed)) - 0.5;
    vec3 dir = hasN > 0.5 ? n : normalize(hash31(seed * 91.0) - 0.5);
    wp += dir * dn * uDisplace;
  }
  float speed = length(uVelocity);
  if (speed > 0.001 && uSmear > 0.0) {
    float lag = hash11(seed * 7.3);
    wp -= uVelocity * uSmear * lag * lag;
    wp += (hash31(seed * 13.0) - 0.5) * speed * uSmear * 0.2;
  }

  float vis = 1.0, edge = 0.0;
#ifdef EMERGE
  float thr = clamp((vnoise(position * uEmergeScale) - 0.2) * 1.1 + (hash11(seed * 5.7) - 0.5) * 0.25, 0.0, 1.0);
  vis = smoothstep(thr, thr + 0.07, uEmerge * 1.08 - 0.01);
  edge = vis * (1.0 - vis) * 4.0;
  vec3 scatter = (hash31(seed * 3.7) - 0.5) * 2.0 * uScatter + vec3(0.0, uScatter * 0.6 * hash11(seed * 9.1), 0.0);
  wp += scatter * (1.0 - vis) * (1.0 - vis);
#endif

  wp = glitchSlice(wp, seed);

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float depth = -mv.z;
  gl_Position = projectionMatrix * mv;

  // Lighting: key + coloured point lights, rim for silhouette readability.
  vec3 L = shadeLights(wp, n, hasN);
  vec3 V = normalize(cameraPosition - wp);
  // Rim keeps silhouettes readable; damped on upward-facing surfaces (tops of feet/shoulders are not silhouettes).
  float rim = hasN > 0.5 ? pow(1.0 - abs(dot(n, V)), 2.5) * (1.0 - 0.7 * max(n.y, 0.0)) : 0.0;
  vec3 base = uColor * aColor;
  vec3 lit = mix(vec3(1.0), L * 2.0, uLit);
  vec3 col = base * lit * aRand.z * uBrightness * (1.0 + uPulse) + rim * uRim * (base * 0.35 + L * 1.5);

  // Deterministic flicker: some particles dip, a few flare.
  float fh = hash12(vec2(seed * 113.1, floor(uTime * 24.0)));
  col *= 1.0 - uFlicker * (step(0.9, fh) * 0.8 - step(0.993, fh) * 2.5);
  col += edge * uColor2 * 2.5;

  // Size: world units -> pixels; depth of field grows the sprite and dims it (energy conserving).
  float sizePx = uSize * aRand.y * uSizeComp * uPixelScale / max(depth, 1e-3);
  float coc = uAperture * abs(depth - uFocus) / max(depth, 1e-3) * uPixelScale * 0.02;
  float total = sizePx + coc;
  float alpha = uOpacity * vis * (sizePx * sizePx) / (total * total);
  if (total < uMinPoint) { alpha *= (total * total) / (uMinPoint * uMinPoint); total = uMinPoint; }
  total = min(total, uMaxPoint);
  col *= fogFactor(depth);
  if (depth <= 0.0) alpha = 0.0;

  gl_PointSize = total;
  vSizePx = total;
  vSoft = clamp(coc / max(sizePx * 1.5, 1e-3), 0.0, 1.0);
  vColor = col;
  vAlpha = alpha;

#if defined(GLYPH) || defined(STROKE)
  float lum = dot(col, vec3(0.299, 0.587, 0.114)) * uRampGain;
  vGlyph = aGlyph >= 0.0 ? aGlyph : rampGlyph(uGlyphSet, lum, (hash11(seed * 31.0) - 0.5) * uGlyphJitter);
#else
  vGlyph = 0.0;
#endif
#ifdef STROKE
  vAngle = 0.0;
  if (dot(tng, tng) > 1e-8) {
    vec4 c1 = projectionMatrix * viewMatrix * vec4(wp + normalize(tng) * 0.05, 1.0);
    vec2 sd = (c1.xy / max(c1.w, 1e-4) - gl_Position.xy / max(gl_Position.w, 1e-4)) * vec2(uAspect, 1.0);
    vAngle = atan(sd.y, sd.x);
  }
#else
  vAngle = 0.0;
#endif
}
`;

const fragment = /* glsl */ `
${common}
${atlas}
uniform float uGlyphMinPx;
varying vec3 vColor;
varying float vAlpha;
varying float vGlyph;
varying float vAngle;
varying float vSizePx;
varying float vSoft;

void main() {
  vec2 pc = gl_PointCoord - 0.5;
  pc.y = -pc.y;
  float r2 = dot(pc, pc) * 4.0;
  float a;
#if defined(GLYPH) || defined(STROKE)
  float c = cos(vAngle), s = sin(vAngle);
  vec2 q = vec2(c * pc.x + s * pc.y, -s * pc.x + c * pc.y);
  float g = 0.0;
  if (abs(q.x) < 0.5 && abs(q.y) < 0.5) {
    float lod = clamp(log2(32.0 / max(vSizePx, 1.0)), 0.0, 2.0);
    g = textureLod(uAtlas, atlasUV(vGlyph, q + 0.5), lod).r;
  }
  float dotA = exp(-r2 * 4.5);
  float glyphness = smoothstep(uGlyphMinPx, uGlyphMinPx + 3.0, vSizePx) * (1.0 - vSoft);
  a = mix(dotA * 0.8, g, glyphness);
#else
  float k = mix(5.0, 2.2, vSoft);
  a = exp(-r2 * k) * smoothstep(1.0, 0.75, r2);
#endif
  a *= vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;

function col(c) {
  const k = new THREE.Color(c);
  return new THREE.Vector3(k.r, k.g, k.b);
}

/**
 * Create a particle material bound to the engine's shared uniforms.
 * Options (all optional): mode ('dot'|'glyph'|'stroke'), color, color2, size (metres), brightness, lit (0..1),
 * rim, flicker, displace, opacity, glyphSet (row), rampGain, glyphJitter, glyphMinPx, sliceAmt,
 * emerge {scale, scatter, value}, sway {amount, freq}, drift {vel, box, center}, skinned, smear, depthTest.
 */
export function createParticleMaterial(engine, o = {}) {
  const mode = o.mode || 'dot';
  const defines = {};
  if (mode === 'glyph') defines.GLYPH = '';
  if (mode === 'stroke') defines.STROKE = '';
  if (o.skinned) defines.SKINNED = '';
  if (o.skinned && o.skinBones === 4) defines.SKIN4 = '';
  if (o.emerge) defines.EMERGE = '';
  if (o.sway) defines.SWAY = '';
  if (o.drift) defines.DRIFT = '';

  const uniforms = {
    ...engine.shared,
    uColor: { value: col(o.color ?? '#ffffff') },
    uColor2: { value: col(o.color2 ?? '#ff3b2f') },
    uSize: { value: o.size ?? 0.01 },
    uBrightness: { value: o.brightness ?? 1 },
    uLit: { value: o.lit ?? 1 },
    uRim: { value: o.rim ?? 0 },
    uFlicker: { value: o.flicker ?? 0.15 },
    uDisplace: { value: o.displace ?? 0 },
    uOpacity: { value: o.opacity ?? 1 },
    uGlyphSet: { value: o.glyphSet ?? 0 },
    uRampGain: { value: o.rampGain ?? 1.6 },
    uGlyphJitter: { value: o.glyphJitter ?? 0.25 },
    uGlyphMinPx: { value: o.glyphMinPx ?? 4.0 },
    uSliceAmt: { value: o.sliceAmt ?? 1 },
    uEmerge: { value: o.emerge?.value ?? 1 },
    uEmergeScale: { value: o.emerge?.scale ?? 2.5 },
    uScatter: { value: o.emerge?.scatter ?? 1.5 },
    uVelocity: { value: new THREE.Vector3() },
    uSmear: { value: o.smear ?? 0 },
    uSway: { value: o.sway?.amount ?? 0 },
    uSwayFreq: { value: o.sway?.freq ?? 1.3 },
    uDriftVel: { value: new THREE.Vector3(...(o.drift?.vel ?? [0, 0, 0])) },
    uDriftBox: { value: new THREE.Vector3(...(o.drift?.box ?? [20, 10, 20])) },
    uDriftCenter: { value: new THREE.Vector3(...(o.drift?.center ?? [0, 4, 0])) },
    uPulse: { value: 0 },
  };
  if (o.skinned) {
    uniforms.uBoneTex = { value: null };
    uniforms.uBindMatrix = { value: new THREE.Matrix4() };
    uniforms.uBindMatrixInverse = { value: new THREE.Matrix4() };
  }

  const m = new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms,
    defines,
    transparent: true,
    depthWrite: false,
    depthTest: o.depthTest ?? true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  m.userData.mode = mode;
  return m;
}

/**
 * Collects particles and builds a BufferGeometry with every attribute the particle shader expects
 * (missing attributes would read as zero, so they are always created).
 */
export class ParticleBuilder {
  constructor() {
    this.p = []; this.n = []; this.r = []; this.c = []; this.t = []; this.g = []; this.si = []; this.sw = [];
  }
  get count() { return this.p.length / 3; }
  push({ p, n = [0, 0, 0], seed = 0, size = 1, bright = 1, param = 0, color = [1, 1, 1], tangent = [0, 0, 0], glyph = -1, skinIndex = null, skinWeight = null }) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.r.push(seed, size, bright, param);
    this.c.push(color[0], color[1], color[2]);
    this.t.push(tangent[0], tangent[1], tangent[2]);
    this.g.push(glyph);
    if (skinIndex) { this.si.push(...skinIndex); this.sw.push(...skinWeight); }
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aRand', new THREE.Float32BufferAttribute(this.r, 4));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aTangent', new THREE.Float32BufferAttribute(this.t, 3));
    g.setAttribute('aGlyph', new THREE.Float32BufferAttribute(this.g, 1));
    if (this.si.length) {
      g.setAttribute('skinIndex', new THREE.Float32BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    g.computeBoundingSphere();
    return g;
  }
}

/** Convenience: build + material -> THREE.Points with frustum culling off (shaders move particles). */
export function makePoints(engine, builder, materialOptions) {
  const pts = new THREE.Points(builder.build(), createParticleMaterial(engine, materialOptions));
  pts.frustumCulled = false;
  return pts;
}
