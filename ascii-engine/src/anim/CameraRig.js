import * as THREE from 'three';
import { gsap } from 'gsap';
import { fbm1 } from '../core/random.js';

// Cinematic camera: a list of shots, each a spline move (positions) with a look-at path, fov, roll, easing and
// deterministic handheld drift (noise as a function of time). Cuts are hard switches between shots; pair them
// with glitchBurst() for glitch transitions. Auto-focus follows the look target (or a supplied function).

export class CameraRig {
  /**
   * shots: [{ start, end, pos: [[x,y,z], ...], target: [[x,y,z], ...] | fn(t), fov: [a, b] | n, roll: [a, b] | n,
   *           ease: 'sine.inOut', handheld: 0.02, focus: fn(t) -> metres | null }]
   */
  constructor(engine, shots, { autoFocus = true } = {}) {
    this.engine = engine;
    this.autoFocus = autoFocus;
    this.shots = shots.map((s) => ({
      ease: 'sine.inOut', handheld: 0.015, roll: 0, ...s,
      posCurve: s.pos.length > 2 ? new THREE.CatmullRomCurve3(s.pos.map((p) => new THREE.Vector3(...p)), false, 'centripetal') : null,
      easeFn: gsap.parseEase(s.ease || 'sine.inOut'),
    }));
    this._p = new THREE.Vector3();
    this._t = new THREE.Vector3();
    engine.onUpdate((t) => this.update(t));
  }

  shotAt(t) {
    let cur = this.shots[0];
    for (const s of this.shots) if (t >= s.start) cur = s;
    return cur;
  }

  update(t) {
    const s = this.shotAt(t);
    const u = s.easeFn(THREE.MathUtils.clamp((t - s.start) / Math.max(s.end - s.start, 1e-3), 0, 1));
    const lerp3 = (arr, out) => {
      if (arr.length === 1) return out.set(...arr[0]);
      const a = arr[0], b = arr[arr.length - 1];
      return out.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    };
    if (s.posCurve) s.posCurve.getPoint(u, this._p); else lerp3(s.pos, this._p);
    if (typeof s.target === 'function') this._t.copy(s.target(t, u)); else lerp3(s.target, this._t);
    const range = (v) => (Array.isArray(v) ? v[0] + (v[1] - v[0]) * u : v);

    const cam = this.engine.camera;
    const hh = s.handheld;
    if (hh > 0) {
      this._p.x += fbm1(t * 0.35, 1) * hh;
      this._p.y += fbm1(t * 0.31, 2) * hh * 0.7;
      this._t.x += fbm1(t * 0.27, 3) * hh * 1.5;
      this._t.y += fbm1(t * 0.23, 4) * hh;
    }
    cam.position.copy(this._p);
    cam.up.set(0, 1, 0);
    cam.lookAt(this._t);
    cam.rotateZ(range(s.roll) + (hh > 0 ? fbm1(t * 0.2, 5) * hh * 0.25 : 0));
    cam.fov = range(s.fov ?? 45);
    if (this.autoFocus) {
      this.engine.params.focus = s.focus ? s.focus(t, u) : this._p.distanceTo(this._t);
    }
  }
}
