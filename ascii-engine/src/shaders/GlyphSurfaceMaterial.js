import * as THREE from 'three';
import { common, sharedUniforms, lighting, fog, atlas, sky, water } from './chunks.js';

// SYSTEM A (shader-based): ASCII on any mesh. A world-space cell grid is projected on the dominant axis of the
// surface (triplanar, box style). Each cell shows one glyph chosen from a luminance ramp, using the lighting
// at that point, so the ASCII density follows the light. Glyphs smaller than a few pixels fade to their average
// coverage (no moire). The mesh writes depth and is a near-black charcoal base, so it occludes particles behind it.

const vertex = /* glsl */ `
varying vec3 vWp;
varying vec3 vN;
varying float vDepth;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWp = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 mv = viewMatrix * wp;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragment = /* glsl */ `
${common}
${sharedUniforms}
${lighting}
${fog}
${atlas}
${sky}
${water}
uniform float uRim;
uniform float uReflect;
uniform vec2 uCell;          // world size of one glyph cell (w, h)
uniform float uGlyphSet;
uniform vec3 uColor;
uniform vec3 uBase;          // charcoal base colour (linear)
uniform float uBrightness;
uniform float uGain;         // luminance -> ramp position gain
uniform float uJitter;
uniform float uFrag;         // fragmentation amount 0..1 (cells dropping out)
uniform float uFragScale;
uniform float uFragSpeed;
uniform float uSeed;
uniform float uOpacity;
uniform float uEmerge;       // 0..1 reveal (height sweep + noise)
uniform vec2 uEmergeRange;   // world y range of the sweep
uniform vec2 uWinGrid;       // window bay width, floor height
uniform vec3 uWinColor;
uniform float uWinLit;       // fraction of lit windows
uniform float uWinGlow;
uniform float uHorizon;      // ground only: fade glyph contrast towards the horizon
uniform float uEmissive;     // minimum luminance (structure visible in shadow)
uniform float uHueMix;       // 0 = keep own colour, 1 = fully tinted by light colour
uniform vec2 uScroll;        // RIPPLE: drift of the glyph grid (world units / s)
varying vec3 vWp;
varying vec3 vN;
varying float vDepth;
#ifdef MAPPED
varying vec3 vMapP;   // rest-pose position/normal: the glyph grid sticks to a skinned body
varying vec3 vMapN;
varying float vShade;
#endif

void main() {
  vec3 n = normalize(vN);
  vec3 mp = vWp, mn = n;
#ifdef MAPPED
  mp = vMapP; mn = normalize(vMapN);
#endif
#ifdef REFLECT
  if (inPond(vWp) < 0.5 || vWp.y > uWater.y) discard;
#endif
  vec3 an = abs(mn);
  vec2 coord;
  bool ground = an.y > an.x && an.y > an.z;
  if (ground) coord = mp.xz;
  else if (an.x > an.z) coord = vec2(mp.z * sign(mn.x), mp.y);
  else coord = vec2(-mp.x * sign(mn.z), mp.y);

#ifdef RIPPLE
  coord += uScroll * uTime + vec2(sin(coord.y * 2.7 + uTime * 1.3), cos(coord.x * 1.9 - uTime * 1.1)) * 0.06;
#endif
  vec2 g = coord / uCell;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float h = hash12(cell + uSeed);

  vec3 L = shadeLights(vWp, n, 1.0);
  float lum = dot(L, vec3(0.3, 0.5, 0.2)) * uBrightness;
  // Light colour tints the glyphs, but only partly: surfaces keep their own silver base (no full red wash).
  vec3 hue = L / max(dot(L, vec3(0.3, 0.5, 0.2)), 1e-3);
  vec3 tint = uColor * mix(vec3(1.0), hue, uHueMix);
  // Emissive floor: structure stays legible in shadow (the ASCII pattern never fully disappears).
  lum = max(lum, uEmissive * (0.75 + 0.5 * hash12(cell * 0.37 + uSeed)));
#ifdef MAPPED
  lum *= vShade;
#endif
#ifdef RIM
  lum += uRim * pow(1.0 - abs(dot(n, normalize(cameraPosition - vWp))), 2.0);
#endif

#ifdef WINDOWS
  if (!ground) {
    vec2 wc = coord / uWinGrid;
    vec2 wcell = floor(wc), wf = fract(wc);
    float inWin = step(0.2, wf.x) * step(wf.x, 0.8) * step(0.28, wf.y) * step(wf.y, 0.82);
    float frame = (1.0 - inWin) * step(0.12, wf.x) * step(wf.x, 0.88) * step(0.2, wf.y) * step(wf.y, 0.9);
    float wh = hash12(wcell + uSeed * 3.1);
    float lit = step(1.0 - uWinLit, wh);
    float flick = 0.75 + 0.25 * step(0.3, hash12(wcell + floor(uTime * (0.5 + wh * 2.0))));
    // Lit windows land in the upper-middle of the ramp (dense glyphs, not solid blocks).
    float winLum = uWinGlow * flick * (0.34 + 0.18 * hash12(cell + wcell));
    lum = lum * (0.55 + frame * 0.6) * (1.0 - inWin * 0.6) + inWin * lit * winLum;
    tint = mix(tint, uWinColor, inWin * lit);
  }
#endif

  // Fragmentation: cells drop out in drifting noise patches (digital, broken surfaces).
  float fn = vnoise(vec3(cell * uFragScale, uTime * uFragSpeed + uSeed));
  float keep = step(uFrag, fn * 0.85 + h * 0.15);

  // Reveal: a rising sweep with a noisy edge.
  float ey = (vWp.y - uEmergeRange.x) / max(uEmergeRange.y - uEmergeRange.x, 1e-3);
  float reveal = smoothstep(ey - 0.04, ey, uEmerge * 1.1 - 0.05 + (h - 0.5) * 0.08);
  float revealEdge = reveal * (1.0 - reveal) * 4.0;

  float glyph = rampGlyph(uGlyphSet, lum * uGain, (h - 0.5) * uJitter);
  vec2 dgx = dFdx(g), dgy = dFdy(g);
  // Cell size in pixels per axis. Glyphs need ~3+ px; below that use average coverage, but keep the rows or
  // columns that are still resolvable (grazing facades read as lines of text, not flat blocks).
  float pxX = 1.0 / max(length(vec2(dgx.x, dgy.x)), 1e-4);
  float pxY = 1.0 / max(length(vec2(dgx.y, dgy.y)), 1e-4);
  float sampleA = textureGrad(uAtlas, atlasUV(glyph, f), dgx / ATLAS_GRID, dgy / ATLAS_GRID).r;
  float rowM = mix(1.0, smoothstep(0.08, 0.3, f.y) * smoothstep(0.92, 0.7, f.y) * 1.8, smoothstep(2.0, 5.0, pxY));
  float colM = mix(1.0, smoothstep(0.1, 0.3, f.x) * smoothstep(0.9, 0.7, f.x) * 1.6, smoothstep(2.0, 5.0, pxX));
  float avgA = clamp(lum * uGain, 0.0, 1.0) * 0.28 * rowM * colM;
  float aa = smoothstep(2.5, 7.0, min(pxX, pxY));
  float glyphA = mix(avgA, sampleA, aa);
#ifdef GROUND_HORIZON
  glyphA *= mix(1.0, 0.45, smoothstep(0.0, 1.0, vDepth * uHorizon));
#endif

  vec3 col = uBase + tint * glyphA * lum * keep * reveal + revealEdge * uWinColor * 0.6 * aa;
  float fg = fogFactor(vDepth);
#ifdef REFLECT
  // Additive mirrored copy: glyph light only, dimmed and fading with depth below the surface.
  gl_FragColor = vec4((col - uBase) * fg * uReflect * exp(-(uWater.y - vWp.y) * 0.6), 1.0);
  return;
#endif
  col = mix(skyColor(normalize(vWp - cameraPosition)), col, fg);
  if (inPond(vWp) > 0.5 && vWp.y < uWater.y) col = mix(uBase, col, 0.08);
  gl_FragColor = vec4(col * uOpacity, 1.0);
}
`;

function col(c) {
  const k = new THREE.Color(c);
  return new THREE.Vector3(k.r, k.g, k.b);
}

/**
 * Options: glyphSet (row), cell [w, h] metres, color, base, brightness, gain, jitter,
 * frag, fragScale, fragSpeed, seed, windows {grid:[bay, floor], color, lit, glow}, emerge {value, range:[y0, y1]},
 * horizon (ground only: contrast falloff per metre).
 */
export function createGlyphSurfaceMaterial(engine, o = {}) {
  return glyphSurface(engine, o, vertex);
}

// Skinned variant: three.js skinning chunks (the renderer binds bones for SkinnedMesh), glyph grid mapped in the
// rest pose, per-vertex shade attribute (aShade: AO x curvature, default 1). Works on imported GLB meshes too.
const skinnedVertex = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
attribute float aShade;
varying vec3 vWp;
varying vec3 vN;
varying float vDepth;
varying vec3 vMapP;
varying vec3 vMapN;
varying float vShade;
uniform vec4 uWater;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vMapP = position * MAP_SCALE;
  vMapN = normal;
  vShade = aShade;
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
#ifdef REFLECT
  wp.y = 2.0 * uWater.y - wp.y;
  wp.x += sin(wp.y * 7.0 + uTime * 2.1) * 0.012;
#endif
  vWp = wp.xyz;
  vN = normalize(mat3(modelMatrix) * objectNormal);
  vec4 mv = viewMatrix * wp;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/** Glyph surface for skinned meshes (procedural body or GLB). Extra options: mapScale (rest units -> metres), reflect (bool). */
export function createSkinnedGlyphMaterial(engine, o = {}) {
  const m = glyphSurface(engine, o, `uniform float uTime;\n#define MAP_SCALE ${(o.mapScale ?? 1).toFixed(6)}\n` + skinnedVertex);
  m.defines.MAPPED = '';
  if (o.reflectMode) {
    m.defines.REFLECT = '';
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
  } else {
    m.polygonOffset = true; // particles lying exactly on the surface stay visible
    m.polygonOffsetFactor = 1;
    m.polygonOffsetUnits = 1;
  }
  return m;
}

function glyphSurface(engine, o, vertexShader) {
  const defines = {};
  if (o.windows) defines.WINDOWS = '';
  if (o.horizon) defines.GROUND_HORIZON = '';
  if (o.ripple) defines.RIPPLE = '';
  if (o.rim) defines.RIM = '';
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: fragment,
    defines,
    uniforms: {
      ...engine.shared,
      uCell: { value: new THREE.Vector2(...(o.cell ?? [0.2, 0.28])) },
      uGlyphSet: { value: o.glyphSet ?? 1 },
      uColor: { value: col(o.color ?? '#d8dde6') },
      uBase: { value: col(o.base ?? '#050506') },
      uBrightness: { value: o.brightness ?? 1 },
      uGain: { value: o.gain ?? 1.6 },
      uJitter: { value: o.jitter ?? 0.25 },
      uFrag: { value: o.frag ?? 0.1 },
      uFragScale: { value: o.fragScale ?? 0.18 },
      uFragSpeed: { value: o.fragSpeed ?? 0.15 },
      uSeed: { value: o.seed ?? 0 },
      uOpacity: { value: 1 },
      uEmerge: { value: o.emerge?.value ?? 1 },
      uEmergeRange: { value: new THREE.Vector2(...(o.emerge?.range ?? [0, 30])) },
      uWinGrid: { value: new THREE.Vector2(...(o.windows?.grid ?? [2.4, 3.2])) },
      uWinColor: { value: col(o.windows?.color ?? '#ffb347') },
      uWinLit: { value: o.windows?.lit ?? 0.25 },
      uWinGlow: { value: o.windows?.glow ?? 1.2 },
      uHorizon: { value: o.horizon ?? 0 },
      uEmissive: { value: o.emissive ?? 0.12 },
      uRim: { value: o.rim ?? 0 },
      uReflect: { value: o.reflect ?? 0.4 },
      uHueMix: { value: o.hueMix ?? 0.6 },
      uScroll: { value: new THREE.Vector2(...(o.scroll ?? [0.05, 0.12])) },
    },
  });
}
