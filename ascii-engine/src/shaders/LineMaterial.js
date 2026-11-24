import * as THREE from 'three';
import { common, sharedUniforms, lighting, fog } from './chunks.js';

// Luminous wireframe lines (1 px GL lines, additive). Use for edges, cables, scaffolds. For thicker or dashed
// edges, sample stroke particles along the edge instead (see env/Building.js).

const vertex = /* glsl */ `
${common}
${sharedUniforms}
${lighting}
${fog}
uniform vec3 uColor;
uniform float uBrightness;
uniform float uLit;
uniform float uDash;       // 0 = solid, else dash period in metres
varying vec3 vColor;
varying float vDashCoord;
attribute float lineDistance;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float band = floor(wp.y * 7.0);
  float tq = floor(uTime * 15.0);
  float on = step(1.0 - uGlitch * 0.55, hash12(vec2(band, tq)));
  wp.xyz += uCamRight * (hash12(vec2(band + 17.0, tq)) - 0.5) * 0.9 * uGlitch * on;
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  vec3 L = shadeLights(wp.xyz, vec3(0.0), 0.0);
  vColor = uColor * mix(vec3(1.0), L * 2.0, uLit) * uBrightness * fogFactor(-mv.z);
  vDashCoord = lineDistance;
}
`;

const fragment = /* glsl */ `
uniform float uDash;
varying vec3 vColor;
varying float vDashCoord;
void main() {
  if (uDash > 0.0 && fract(vDashCoord / uDash) > 0.55) discard;
  gl_FragColor = vec4(vColor, 1.0);
}
`;

export function createLineMaterial(engine, o = {}) {
  const c = new THREE.Color(o.color ?? '#cfd6e0');
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: {
      ...engine.shared,
      uColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
      uBrightness: { value: o.brightness ?? 0.5 },
      uLit: { value: o.lit ?? 0.7 },
      uDash: { value: o.dash ?? 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** LineSegments from a geometry's hard edges, with lineDistance for dashing. */
export function edgeLines(engine, geometry, o = {}) {
  const edges = new THREE.EdgesGeometry(geometry, o.thresholdAngle ?? 30);
  const lines = new THREE.LineSegments(edges, createLineMaterial(engine, o));
  lines.computeLineDistances();
  return lines;
}
