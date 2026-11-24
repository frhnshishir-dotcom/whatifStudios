import * as THREE from 'three';
import { sky as skyChunk } from '../shaders/chunks.js';

// Background dome: near-black zenith, charcoal horizon band, an optional low crimson glow towards a direction
// (the energy source), and very faint drifting scan bands. Matches the fog colour at the horizon so distant
// geometry dissolves into it.

export function createSky(engine, { zenith = '#010102', horizon = '#0b0b0e', glow = '#5a0a08', glowDir = [0.1, 0.05, -1], glowAmount = 0.6, radius = 500 } = {}) {
  const sh = engine.shared;
  const set = (u, c) => { const k = new THREE.Color(c); u.value.set(k.r, k.g, k.b); };
  set(sh.uSkyZenith, zenith);
  set(sh.uSkyHorizon, horizon);
  set(sh.uSkyGlow, glow);
  sh.uSkyGlowDir.value.set(...glowDir).normalize();
  sh.uSkyGlowAmount.value = glowAmount;
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { ...sh },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + vDir * 400.0, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      ${skyChunk}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyColor(d);
        c *= 0.92 + 0.08 * smoothstep(0.4, 1.0, sin(d.y * 140.0 - uTime * 0.6));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  mesh.name = 'sky';
  return { object: mesh, material: mat };
}
