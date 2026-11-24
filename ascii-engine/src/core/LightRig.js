import * as THREE from 'three';

export const MAX_LIGHTS = 8;

/**
 * Shared lighting for every particle and glyph-surface material.
 * One warm key light (direction) + up to MAX_LIGHTS coloured point lights with a smooth range falloff.
 * Lights are plain objects; set .intensity/.position each frame (or tween them) and the rig uploads them.
 */
export class LightRig {
  constructor() {
    this.lights = [];
    this.uniforms = {
      uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
      uLightColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
      uLightRange: { value: new Float32Array(MAX_LIGHTS) },
      uLightCount: { value: 0 },
      uKeyDir: { value: new THREE.Vector3(0.4, 0.6, 0.5).normalize() },
      uKeyColor: { value: new THREE.Vector3(0.25, 0.23, 0.21) },
      uAmbient: { value: new THREE.Vector3(0.07, 0.075, 0.085) },
    };
  }

  /** color: CSS/hex string (sRGB), intensity: scalar, range: metres where falloff reaches ~0. */
  add({ name = 'light', position = [0, 2, 0], color = '#ffffff', intensity = 1, range = 10 } = {}) {
    if (this.lights.length >= MAX_LIGHTS) throw new Error(`LightRig: max ${MAX_LIGHTS} lights`);
    const light = {
      name,
      position: new THREE.Vector3(...position),
      color: new THREE.Color(color), // linear working space
      intensity,
      range,
    };
    this.lights.push(light);
    return light;
  }

  setKey({ direction, color, intensity = 1 } = {}) {
    if (direction) this.uniforms.uKeyDir.value.set(...direction).normalize();
    if (color) {
      const c = new THREE.Color(color);
      this.uniforms.uKeyColor.value.set(c.r * intensity, c.g * intensity, c.b * intensity);
    }
  }

  setAmbient(color, intensity = 1) {
    const c = new THREE.Color(color);
    this.uniforms.uAmbient.value.set(c.r * intensity, c.g * intensity, c.b * intensity);
  }

  upload() {
    const u = this.uniforms;
    u.uLightCount.value = this.lights.length;
    this.lights.forEach((l, i) => {
      u.uLightPos.value[i].copy(l.position);
      u.uLightColor.value[i].set(l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity);
      u.uLightRange.value[i] = l.range;
    });
  }
}
