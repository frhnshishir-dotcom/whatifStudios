import * as THREE from 'three';
import { gsap } from 'gsap';
import { LightRig } from './LightRig.js';
import { createGlyphAtlas } from '../glyphs/GlyphAtlas.js';
import { PostFX } from '../post/PostFX.js';

/**
 * The engine owns the renderer, a deterministic clock, the uniforms every material shares, the light rig,
 * the glyph atlas, the post chain and a paused GSAP timeline.
 *
 * Time is never read from a wall clock: setTime(t) drives everything, so frame n always looks the same.
 * Scenes register update hooks (t, engine) and afterMatrix hooks (for skeletons that need world matrices).
 */
export class Engine {
  constructor({ canvas, width, height, quality, fps = 30, seed = 1, mode = 'preview', letterbox = 0 }) {
    this.width = width;
    this.height = height;
    this.quality = quality;
    this.fps = fps;
    this.seed = seed;
    this.mode = mode;
    this.time = 0;
    this.frame = 1;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, depth: true, stencil: false,
      preserveDrawingBuffer: mode === 'render', powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.sortObjects = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.05, 800); // aspect set from the picture area in setTime
    this.scene.add(this.camera);

    this.lightRig = new LightRig();
    this.atlas = createGlyphAtlas();
    this.post = new PostFX(this.renderer, { width, height, supersample: quality.supersample, bloomLevels: quality.bloomLevels, letterbox });
    this.post.setAtlas(this.atlas, this.atlas.sets.findIndex((s) => s.name === 'text'));

    // Tweenable scene-level parameters (GSAP targets). Applied to uniforms every frame.
    this.params = {
      glitch: 0,          // global glitch (particles slice + post blocks + RGB kick)
      focus: 6,           // focus distance (m)
      aperture: 0,        // depth-of-field strength (0 = off)
      fogDensity: 0.018,
      fogStart: 6,
      fogColor: '#060607',
    };

    this.shared = {
      uTime: { value: 0 },
      uFrame: { value: 1 },
      uPixelScale: { value: 1 },
      uAspect: { value: this.post.cw / this.post.ch },
      uGlitch: { value: 0 },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uFogColor: { value: new THREE.Vector3() },
      uFogDensity: { value: 0 },
      uFogStart: { value: 0 },
      uSizeComp: { value: 1 / Math.sqrt(quality.density) },
      uMaxPoint: { value: quality.maxPointPx * quality.supersample },
      uMinPoint: { value: 1.25 * quality.supersample },
      uFocus: { value: 6 },
      uAperture: { value: 0 },
      uSkyZenith: { value: new THREE.Vector3(0.0003, 0.0003, 0.0006) },
      uSkyHorizon: { value: new THREE.Vector3(0.0033, 0.0033, 0.0044) },
      uSkyGlow: { value: new THREE.Vector3(0.1, 0.004, 0.0024) },
      uSkyGlowDir: { value: new THREE.Vector3(0, 0, -1) },
      uSkyGlowAmount: { value: 0 },
      uWater: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAtlas: { value: this.atlas.texture },
      uSetLen: { value: this.atlas.setLen },
      ...this.lightRig.uniforms,
    };

    this.timeline = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    this.hooks = { update: [], afterMatrix: [] };
    this.duration = 10;
    this._fog = new THREE.Color();
  }

  /** Particle count multiplier for the current quality preset. */
  get density() { return this.quality.density; }

  onUpdate(fn) { this.hooks.update.push(fn); return this; }
  onAfterMatrix(fn) { this.hooks.afterMatrix.push(fn); return this; }

  setTime(t, frame = Math.round(t * this.fps) + 1) {
    this.time = t;
    this.frame = frame;
    const s = this.shared;
    s.uTime.value = t;
    s.uFrame.value = frame;
    this.timeline.time(Math.min(t, this.timeline.duration()), true);
    for (const fn of this.hooks.update) fn(t, this);

    const p = this.params;
    s.uGlitch.value = p.glitch;
    this.post.params.glitch = p.glitch;
    s.uFocus.value = p.focus;
    s.uAperture.value = p.aperture;
    s.uFogDensity.value = p.fogDensity;
    s.uFogStart.value = p.fogStart;
    this._fog.set(p.fogColor);
    s.uFogColor.value.set(this._fog.r, this._fog.g, this._fog.b);

    const cam = this.camera;
    cam.aspect = this.post.cw / this.post.ch; // the picture area (letterbox-aware)
    cam.updateProjectionMatrix();
    this.scene.updateMatrixWorld(true);
    for (const fn of this.hooks.afterMatrix) fn(t, this);
    this.lightRig.upload();

    // Pixels per world unit at depth 1, in internal (supersampled) pixels.
    s.uPixelScale.value = (this.post.ih * 0.5) / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    s.uAspect.value = cam.aspect;
    const e = cam.matrixWorld.elements;
    s.uCamRight.value.set(e[0], e[1], e[2]).normalize();
    s.uCamUp.value.set(e[4], e[5], e[6]).normalize();
  }

  render() {
    this.post.render(this.scene, this.camera, this.frame);
  }

  /** Render frame n (1-based: frame 1 is t = 0) and return it as a PNG data URL. */
  renderFrame(n) {
    this.setTime((n - 1) / this.fps, n);
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * Render frame n and return its raw RGBA pixels (bottom-up rows, as gl.readPixels gives them) base64-encoded.
   * The render tool encodes these as RGB PNGs in Node (the browser's PNG encoder always writes RGBA).
   */
  async renderFrameRaw(n) {
    this.setTime((n - 1) / this.fps, n);
    this.render();
    const gl = this.renderer.getContext();
    const buf = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result.slice(fr.result.indexOf(',') + 1));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(new Blob([buf]));
    });
  }

  info() {
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    let points = 0, draws = 0;
    this.scene.traverse((o) => {
      if (o.isPoints && o.visible) { points += o.geometry.getAttribute('position').count; draws++; }
      else if ((o.isMesh || o.isLine) && o.visible) draws++;
    });
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webgl: gl.getParameter(gl.VERSION),
      width: this.width, height: this.height, picture: [this.post.cw, this.post.ch], fps: this.fps, duration: this.duration,
      quality: this.quality.name, density: this.quality.density, supersample: this.quality.supersample,
      particles: points, drawCallsApprox: draws, pointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)),
    };
  }
}
