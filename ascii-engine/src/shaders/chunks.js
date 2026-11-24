// Reusable GLSL chunks (WebGL 2 / GLSL ES 3.0 via THREE.ShaderMaterial).
// Every material builds its source from these, so the look stays consistent across systems.

import { MAX_LIGHTS } from '../core/LightRig.js';

export const common = /* glsl */ `
#define MAX_LIGHTS ${MAX_LIGHTS}
#define ATLAS_GRID 16.0
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
// Trilinear value noise in [0, 1].
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0)), n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1)), n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm3(vec3 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 11.7) + 0.2 * vnoise(p * 4.11 + 5.3); }
`;

export const sharedUniforms = /* glsl */ `
uniform float uTime;
uniform float uFrame;
uniform float uPixelScale;   // pixels per world unit at depth 1 (internal resolution)
uniform float uAspect;
uniform float uGlitch;       // global glitch amount (tweened at transitions)
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogStart;
`;

export const lighting = /* glsl */ `
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightColor[MAX_LIGHTS];
uniform float uLightRange[MAX_LIGHTS];
uniform int uLightCount;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uAmbient;
// hasN = 0 for particles without a normal (omni-lit, e.g. dust).
vec3 shadeLights(vec3 p, vec3 n, float hasN) {
  vec3 c = uAmbient;
  float kd = mix(0.6, clamp((dot(n, uKeyDir) + 0.3) / 1.3, 0.0, 1.0), hasN);
  c += uKeyColor * kd;
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 d = uLightPos[i] - p;
    float dist = length(d);
    float q = clamp(dist / uLightRange[i], 0.0, 1.0);
    float att = (1.0 - q * q);
    att = att * att / (1.0 + 10.0 * q * q);
    float ndl = mix(0.85, clamp((dot(n, d / max(dist, 1e-4)) + 0.25) / 1.25, 0.0, 1.0), hasN);
    c += uLightColor[i] * att * ndl;
  }
  return c;
}
`;

export const sky = /* glsl */ `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGlow;
uniform vec3 uSkyGlowDir;
uniform float uSkyGlowAmount;
// Sky colour in a view direction. Shared by the sky dome and by fog, so distant geometry dissolves into the sky.
vec3 skyColor(vec3 d) {
  float h = clamp(d.y, -0.2, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.45, h));
  float g = pow(max(dot(normalize(vec3(d.x, d.y * 2.5, d.z)), uSkyGlowDir), 0.0), 6.0) * smoothstep(0.5, -0.05, h);
  return c + uSkyGlow * g * uSkyGlowAmount;
}
`;

export const fog = /* glsl */ `
float fogFactor(float depth) {
  float d = max(depth - uFogStart, 0.0) * uFogDensity;
  return exp(-d * d);
}
`;

// Atlas lookup shared by glyph points and glyph surfaces. Row 0 of the canvas is the top (flipY = true).
export const atlas = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uSetLen[16];
float setLength(float row) { return uSetLen[int(row + 0.5)]; }
vec2 atlasUV(float glyph, vec2 local) {
  float col = mod(glyph, ATLAS_GRID), row = floor(glyph / ATLAS_GRID);
  return vec2((col + local.x) / ATLAS_GRID, (ATLAS_GRID - row - 1.0 + local.y) / ATLAS_GRID);
}
// Glyph from a luminance ramp row. lum in [0, 1], jitter in [-0.5, 0.5].
float rampGlyph(float row, float lum, float jitter) {
  float len = setLength(row);
  float c = floor(clamp(lum + jitter, 0.0, 0.999) * len);
  return row * ATLAS_GRID + c;
}
`;

// Vertex-stage effects for particles.
export const particleFx = /* glsl */ `
uniform float uSliceAmt;
// Digital fragmentation: horizontal world bands jump sideways (camera-right) during glitches.
vec3 glitchSlice(vec3 p, float seed) {
  float g = uGlitch * uSliceAmt;
  if (g <= 0.0) return p;
  float band = floor(p.y * 7.0);
  float tq = floor(uTime * 15.0);
  float h = hash12(vec2(band, tq));
  float on = step(1.0 - g * 0.55, h);
  float dx = (hash12(vec2(band + 17.0, tq)) - 0.5) * 0.9 * g * on;
  return p + uCamRight * dx;
}
`;

export const skinning = /* glsl */ `
uniform highp sampler2D uBoneTex;
uniform mat4 uBindMatrix;
uniform mat4 uBindMatrixInverse;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
mat4 getBoneMatrix(float i) {
  int size = textureSize(uBoneTex, 0).x;
  int j = int(i + 0.5) * 4;
  int x = j % size, y = j / size;
  return mat4(texelFetch(uBoneTex, ivec2(x, y), 0), texelFetch(uBoneTex, ivec2(x + 1, y), 0),
              texelFetch(uBoneTex, ivec2(x + 2, y), 0), texelFetch(uBoneTex, ivec2(x + 3, y), 0));
}
mat4 skinMatrix() {
  mat4 m = getBoneMatrix(skinIndex.x) * skinWeight.x + getBoneMatrix(skinIndex.y) * skinWeight.y;
#ifdef SKIN4
  m += getBoneMatrix(skinIndex.z) * skinWeight.z + getBoneMatrix(skinIndex.w) * skinWeight.w;
#endif
  return uBindMatrixInverse * m * uBindMatrix;
}
`;
