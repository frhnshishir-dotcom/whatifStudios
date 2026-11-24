import * as THREE from 'three';
import { common, atlas as atlasChunk } from '../shaders/chunks.js';

// Post chain: HDR scene -> dual-filter bloom (13-tap Karis down, tent up) -> one composite pass with controlled
// chromatic aberration, block glitch / fragmentation, scanlines, film grain, vignette, AgX tone map, grade, dither.
// Grain and glitch are seeded by the frame number, so a frame renders identically every time.

const fsVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const downFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 s(vec2 o) { return texture(tSrc, vUv + o * uTexel).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  return c * max(rq, br - uThreshold) / max(br, 1e-4);
}
void main() {
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 col;
  if (uFirst > 0.5) {
    // Karis average per box: stops single bright particles from flickering the bloom.
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = 1.0 / (1.0 + luma(g0)), w1 = 1.0 / (1.0 + luma(g1)), w2 = 1.0 / (1.0 + luma(g2));
    float w3 = 1.0 / (1.0 + luma(g3)), w4 = 1.0 / (1.0 + luma(g4));
    col = (g0 * w0 * 0.5 + (g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) * 0.125) / (w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125);
    col = prefilter(col);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const upFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;
vec3 s(vec2 o) { return texture(tSrc, vUv + o * uTexel * uRadius).rgb; }
void main() {
  vec3 col = s(vec2(0, 0)) * 4.0 + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0
           + s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
  gl_FragColor = vec4(col / 16.0 * uWeight, 1.0);
}
`;

// AgX tone map: constants from three.js (MIT), after Troy Sobotka's AgX and Filament.
const compositeFrag = /* glsl */ `
${common}
${atlasChunk}
uniform vec4 uRect;          // content rectangle in output pixels (x, y, w, h); outside = letterbox bars
uniform float uSmear;        // horizontal RGB smear glitch 0..1
uniform float uTerminal;     // screen-space ASCII terminal mode 0..1
uniform vec3 uTermColor;
uniform vec2 uTermCell;      // terminal cell size in output pixels
uniform float uTermRed;      // keep strong reds red in terminal mode
uniform float uTextRow;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform vec2 uSceneTexel;
uniform float uFrame;
uniform float uSS;
uniform float uExposure;
uniform float uBloom;
uniform float uCA;
uniform float uGlitch;
uniform float uScan;
uniform float uScanPeriod;
uniform float uGrain;
uniform float uVignette;
uniform float uSat;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uFade;
varying vec2 vUv;

const mat3 LIN_SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_LIN_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
                          vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
                          vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
                           vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
                           vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = inset * (LIN_SRGB_TO_REC2020 * color);
  color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = agxContrast(color);
  color = outset * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(REC2020_TO_LIN_SRGB * color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 scene(vec2 uv) {
#ifdef SUPERSAMPLE
  vec2 o = uSceneTexel * 0.5;
  return 0.25 * (texture(tScene, uv + vec2(-o.x, -o.y)).rgb + texture(tScene, uv + vec2(o.x, -o.y)).rgb
               + texture(tScene, uv + vec2(-o.x, o.y)).rgb + texture(tScene, uv + vec2(o.x, o.y)).rgb);
#else
  return texture(tScene, uv).rgb;
#endif
}

vec3 hdr(vec2 uv) { return (scene(uv) + texture(tBloom, uv).rgb * uBloom) * uExposure; }
vec3 display(vec3 h) { return toSRGB(agx(h)); }

void main() {
  vec2 px = gl_FragCoord.xy - uRect.xy;
  if (px.x < 0.0 || px.y < 0.0 || px.x >= uRect.z || px.y >= uRect.w) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 uv = px / uRect.zw;
  float tq = floor(uFrame / 2.0);
  // Block glitch: rows jump sideways, a few blocks quantise (fragmentation). Only when uGlitch > 0.
  float rgbBoost = 0.0;
  if (uGlitch > 0.001) {
    float by = floor(uv.y * 28.0);
    float on = step(1.0 - uGlitch * 0.4, hash12(vec2(by, tq)));
    uv.x += (hash12(vec2(by * 1.7, tq + 3.0)) - 0.5) * 0.1 * uGlitch * on;
    rgbBoost = on * uGlitch;
    vec2 bc = floor(uv * vec2(9.0, 16.0));
    if (hash12(bc + tq * 1.37) < uGlitch * 0.1) uv = (floor(uv * uRes / 14.0) * 14.0 + 7.0) / uRes;
  }
  vec2 d = uv - 0.5;
  float r = length(d * vec2(uRes.x / uRes.y, 1.0));
  vec3 c;
  // Smear glitch: whole bands streak horizontally with the channels pulled apart.
  float band = floor(uv.y * 36.0 + hash11(tq) * 4.0);
  float smearOn = uSmear > 0.001 ? step(1.0 - uSmear * 0.8, hash12(vec2(band * 0.37, tq + 11.0))) : 0.0;
  if (smearOn > 0.5) {
    float span = (0.05 + 0.3 * hash12(vec2(band, tq))) * uSmear;
    float dir = hash12(vec2(band, tq + 5.0)) > 0.5 ? 1.0 : -1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 10; i++) {
      float f = float(i) / 9.0 * dir;
      acc.r += hdr(uv - vec2(f * span + span * 0.25, 0.0)).r;
      acc.g += hdr(uv - vec2(f * span, 0.0)).g;
      acc.b += hdr(uv - vec2(f * span - span * 0.25, 0.0)).b;
    }
    c = acc / 10.0 * (1.0 + 1.2 * uSmear);
  } else {
    // Controlled RGB displacement: radial, stronger at the frame edge, plus a horizontal kick during glitches.
    vec2 off = d * uCA * (0.25 + 2.0 * r * r) + vec2(rgbBoost * 0.006, 0.0);
    c.r = scene(uv + off).r;
    c.g = scene(uv).g;
    c.b = scene(uv - off).b;
    vec3 bl;
    bl.r = texture(tBloom, uv + off * 1.5).r;
    bl.g = texture(tBloom, uv).g;
    bl.b = texture(tBloom, uv - off * 1.5).b;
    c = (c + bl * uBloom) * uExposure;
  }

  c = display(c);

  // Grade (display space): contrast, saturation, split tone, charcoal lift.
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, uSat);
  c *= mix(uShadowTint, uHighTint, smoothstep(0.0, 0.7, lum));
  c = c + uLift * (1.0 - c);

  // Terminal mode: the frame redrawn as a grid of monospace glyphs, glyph from the cell's brightness.
  if (uTerminal > 0.001) {
    vec2 cell = floor(px / uTermCell);
    vec2 cuv = (cell + 0.5) * uTermCell / uRect.zw;
    vec2 q = 0.3 * uTermCell / uRect.zw;
    vec3 d0 = display(0.25 * (hdr(cuv + vec2(q.x, 0.0)) + hdr(cuv - vec2(q.x, 0.0)) + hdr(cuv + vec2(0.0, q.y)) + hdr(cuv - vec2(0.0, q.y))));
    float l = pow(dot(d0, vec3(0.2126, 0.7152, 0.0722)), 0.5); // lift: dark scenes still read as dense glyphs
    vec2 f = fract(px / uTermCell);
    float glyph = rampGlyph(uTextRow, l * 1.35, (hash12(cell + floor(uFrame / 3.0) * 0.0) - 0.5) * 0.15);
    float lod = clamp(log2(32.0 / uTermCell.y), 0.0, 3.0);
    float g = textureLod(uAtlas, atlasUV(glyph, f), lod).r;
    float redness = clamp((d0.r - max(d0.g, d0.b)) * 3.0, 0.0, 1.0) * uTermRed;
    vec3 tc = mix(uTermColor, vec3(1.0, 0.16, 0.1), redness);
    vec3 term = tc * (g * (0.15 + 2.2 * l) + l * 0.35);
    c = mix(c, term, uTerminal);
    lum = mix(lum, dot(term, vec3(0.2126, 0.7152, 0.0722)), uTerminal);
  }

  // Vignette, scanlines, grain, fade.
  c *= mix(1.0, smoothstep(1.05, 0.25, r), uVignette);
  c *= 1.0 - uScan * (0.5 + 0.5 * cos(gl_FragCoord.y * 6.2831853 / uScanPeriod));
  float gr = hash12(gl_FragCoord.xy + vec2(uFrame * 37.17, uFrame * 11.31)) + hash12(gl_FragCoord.yx * 1.31 + uFrame * 3.1) - 1.0;
  c += gr * uGrain * (0.35 + 0.65 * sqrt(max(lum, 0.0)));
  c *= uFade;
  c += (hash12(gl_FragCoord.xy * 0.7 + uFrame) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class PostFX {
  constructor(renderer, { width, height, supersample = 1, bloomLevels = 6, letterbox = 0 }) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;
    this.ss = supersample;
    // Letterbox: the picture has aspect `letterbox` (w/h, e.g. 0.8 for 4:5) centred in the output; bars are black.
    let cw = width, ch = height;
    if (letterbox > 0) {
      if (width / letterbox <= height) ch = Math.round(width / letterbox / 2) * 2; else cw = Math.round((height * letterbox) / 2) * 2;
    }
    this.cw = cw;
    this.ch = ch;
    this.rect = [(width - cw) / 2, (height - ch) / 2, cw, ch];
    this.iw = Math.round(cw * supersample);
    this.ih = Math.round(ch * supersample);
    this.params = {
      exposure: 1.0, bloom: 0.75, bloomRadius: 1.0, threshold: 0.55, knee: 0.45,
      ca: 0.004, scan: 0.045, scanPeriod: 3, grain: 0.035, vignette: 0.45, saturation: 0.9, contrast: 1.08,
      lift: '#08080a', shadowTint: '#e9f0f2', highTint: '#fff4ea', fade: 1, glitch: 0,
      smear: 0, terminal: 0, termColor: '#38ff6a', termCell: [7, 12], termRed: 1,
      background: '#030304',
    };
    const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: false };
    this.sceneRT = new THREE.WebGLRenderTarget(this.iw, this.ih, { ...rtOpts, depthBuffer: true });
    this.mips = [];
    let w = this.iw, h = this.ih;
    for (let i = 0; i < bloomLevels; i++) {
      w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
      this.mips.push(new THREE.WebGLRenderTarget(w, h, rtOpts));
    }

    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const mk = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: fsVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
    this.downMat = mk(downFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 0 }, uKnee: { value: 0 } });
    this.upMat = mk(upFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uWeight: { value: 1 } }, { blending: THREE.AdditiveBlending, transparent: true });
    const v3 = () => new THREE.Vector3();
    this.compMat = mk(compositeFrag, {
      tScene: { value: this.sceneRT.texture }, tBloom: { value: this.mips[0].texture },
      uRes: { value: new THREE.Vector2(cw, ch) }, uSceneTexel: { value: new THREE.Vector2(1 / this.iw, 1 / this.ih) },
      uRect: { value: new THREE.Vector4(...this.rect) }, uSmear: { value: 0 }, uTerminal: { value: 0 }, uTermColor: { value: v3() },
      uTermCell: { value: new THREE.Vector2(7, 12) }, uTermRed: { value: 1 }, uTextRow: { value: 8 },
      uAtlas: { value: null }, uSetLen: { value: new Float32Array(16) },
      uFrame: { value: 0 }, uSS: { value: supersample }, uExposure: { value: 1 }, uBloom: { value: 1 }, uCA: { value: 0 },
      uGlitch: { value: 0 }, uScan: { value: 0 }, uScanPeriod: { value: 3 }, uGrain: { value: 0 }, uVignette: { value: 0 },
      uSat: { value: 1 }, uContrast: { value: 1 }, uLift: { value: v3() }, uShadowTint: { value: v3() }, uHighTint: { value: v3() },
      uFade: { value: 1 },
    });
    if (supersample > 1) this.compMat.defines.SUPERSAMPLE = '';
    this._bg = new THREE.Color();
  }

  /** Glyph atlas for the terminal mode (row = the 'text' set). */
  setAtlas(atlas, row) {
    this.compMat.uniforms.uAtlas.value = atlas.texture;
    this.compMat.uniforms.uSetLen.value = atlas.setLen;
    this.compMat.uniforms.uTextRow.value = row;
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  render(scene, camera, frame) {
    const r = this.renderer, p = this.params;
    r.setRenderTarget(this.sceneRT);
    this._bg.set(p.background);
    r.setClearColor(this._bg, 1);
    r.clear(true, true, false);
    r.render(scene, camera);

    // Bloom down chain.
    const d = this.downMat.uniforms;
    let src = this.sceneRT;
    this.mips.forEach((mip, i) => {
      d.tSrc.value = src.texture;
      d.uTexel.value.set(1 / src.width, 1 / src.height);
      d.uFirst.value = i === 0 ? 1 : 0;
      d.uThreshold.value = p.threshold;
      d.uKnee.value = p.knee;
      this._pass(this.downMat, mip);
      src = mip;
    });
    // Up chain: add each smaller mip into the next larger one.
    const u = this.upMat.uniforms;
    r.autoClear = false;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const small = this.mips[i];
      u.tSrc.value = small.texture;
      u.uTexel.value.set(1 / small.width, 1 / small.height);
      u.uRadius.value = p.bloomRadius;
      u.uWeight.value = 1;
      this._pass(this.upMat, this.mips[i - 1]);
    }
    r.autoClear = true;

    const c = this.compMat.uniforms;
    c.uFrame.value = frame;
    c.uExposure.value = p.exposure;
    c.uBloom.value = p.bloom / this.mips.length;
    c.uCA.value = p.ca;
    c.uGlitch.value = p.glitch;
    c.uScan.value = p.scan;
    c.uScanPeriod.value = p.scanPeriod;
    c.uGrain.value = p.grain;
    c.uVignette.value = p.vignette;
    c.uSat.value = p.saturation;
    c.uContrast.value = p.contrast;
    c.uFade.value = p.fade;
    c.uSmear.value = p.smear;
    c.uTerminal.value = p.terminal;
    c.uTermCell.value.set(p.termCell[0], p.termCell[1]);
    c.uTermRed.value = p.termRed;
    { const k = new THREE.Color(p.termColor).convertLinearToSRGB(); c.uTermColor.value.set(k.r, k.g, k.b); }
    const setC = (v, hex) => { const k = new THREE.Color(hex).convertLinearToSRGB(); v.set(k.r, k.g, k.b); };
    setC(c.uLift.value, p.lift);
    setC(c.uShadowTint.value, p.shadowTint);
    setC(c.uHighTint.value, p.highTint);
    this._pass(this.compMat, null);
  }

  dispose() {
    this.sceneRT.dispose();
    this.mips.forEach((m) => m.dispose());
  }
}
