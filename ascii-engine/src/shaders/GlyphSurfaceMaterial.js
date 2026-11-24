import * as THREE from 'three';
import { common, sharedUniforms, lighting, fog, atlas, sky } from './chunks.js';

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
varying vec3 vWp;
varying vec3 vN;
varying float vDepth;

void main() {
  vec3 n = normalize(vN);
  vec3 an = abs(n);
  vec2 coord;
  bool ground = an.y > an.x && an.y > an.z;
  if (ground) coord = vWp.xz;
  else if (an.x > an.z) coord = vec2(vWp.z * sign(n.x), vWp.y);
  else coord = vec2(-vWp.x * sign(n.z), vWp.y);

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
  col = mix(skyColor(normalize(vWp - cameraPosition)), col, fg);
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
  const defines = {};
  if (o.windows) defines.WINDOWS = '';
  if (o.horizon) defines.GROUND_HORIZON = '';
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
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
      uHueMix: { value: o.hueMix ?? 0.6 },
    },
  });
}
