// Presentation Studio — lightweight Three.js stage for product / concept slides.
// Bundled to assets/vendor/studio-viewer.js (IIFE, works from file://) by:
//   python studio.py vendor   (or see 3d-assets/web/README.md)
// Exposes window.StudioViewer.mount(el, opts) -> { start(), stop(), poster() }
//
// Tuned for integrated GPUs: pixel ratio capped at 1.5, render loop runs only while
// the slide is active, no shadows maps, one environment map, low-poly procedural meshes.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function globe(opts) {
  const g = new THREE.Group();
  const n = opts.points || 4200;
  const pos = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    pos.set([Math.cos(t) * r, y, Math.sin(t) * r], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: new THREE.Color(opts.color || "#f5f5f7"), size: 0.016, sizeAttenuation: true,
    transparent: true, opacity: 0.9,
  }));
  g.add(pts);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.985, 64, 48),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(opts.bg || "#0a0a0b") }));
  g.add(core);
  // arcs between random points: the "connections"
  const accent = new THREE.Color(opts.accent || "#ff6a2b");
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
  for (let k = 0; k < (opts.arcs ?? 14); k++) {
    const a = new THREE.Vector3().fromArray(pos, Math.floor(rnd() * n) * 3);
    const b = new THREE.Vector3().fromArray(pos, Math.floor(rnd() * n) * 3);
    const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(1 + a.distanceTo(b) * 0.35);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.9 }));
    g.add(line);
  }
  // soft atmosphere
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1.07, 48, 32), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { c: { value: accent } },
    vertexShader: "varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
    fragmentShader: "uniform vec3 c; varying vec3 vN; void main(){ float i = pow(clamp(0.62 - dot(vN, vec3(0,0,1.0)), 0.0, 1.0), 4.0); gl_FragColor = vec4(c, i*0.9);}",
  }));
  g.add(halo);
  g.rotation.z = 0.35;
  return g;
}

function device(opts) {
  // A generic, brand-neutral slab device (rounded body + glass face + camera island).
  const g = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.78, 1.6, 0.08, 6, 0.09),
    new THREE.MeshPhysicalMaterial({ color: new THREE.Color(opts.color || "#2b2b30"), metalness: 0.9, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.15 }));
  g.add(body);
  const screen = new THREE.Mesh(new RoundedBoxGeometry(0.72, 1.54, 0.01, 4, 0.07),
    new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.05, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.02, emissive: new THREE.Color(opts.accent || "#ff6a2b"), emissiveIntensity: 0.015 }));
  screen.position.z = 0.041;
  g.add(screen);
  const island = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.3, 0.02, 4, 0.06),
    new THREE.MeshPhysicalMaterial({ color: 0x18181b, metalness: 0.6, roughness: 0.35 }));
  island.position.set(-0.17, 0.56, -0.05);
  g.add(island);
  for (const [x, y] of [[-0.23, 0.62], [-0.11, 0.5]]) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 32),
      new THREE.MeshPhysicalMaterial({ color: 0x050505, metalness: 0.2, roughness: 0.05, clearcoat: 1 }));
    lens.rotation.x = Math.PI / 2; lens.position.set(x, y, -0.065); g.add(lens);
  }
  g.rotation.set(0.12, -0.5, 0.06);
  return g;
}

export function mount(el, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio || 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = opts.envIntensity ?? 0.6;
  const camera = new THREE.PerspectiveCamera(opts.fov || 30, 1, 0.1, 100);
  camera.position.set(0, 0, opts.distance || 4.2);
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(new THREE.Color(opts.accent || "#ff6a2b"), 1.1); rim.position.set(-4, 1, -3); scene.add(rim);

  let subject;
  if (opts.kind === "glb" && opts.glb) {
    subject = new THREE.Group();
    new GLTFLoader().parse(b64ToArrayBuffer(opts.glb), "", gltf => {
      const m = gltf.scene; const box = new THREE.Box3().setFromObject(m);
      const s = 2 / Math.max(...box.getSize(new THREE.Vector3()).toArray());
      m.scale.setScalar(s); m.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(s));
      subject.add(m);
    });
  } else if (opts.kind === "device") subject = device(opts);
  else subject = globe(opts);
  scene.add(subject);

  function resize() {
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    renderer.setSize(w, h, false); renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(el);

  let raf = 0, t0 = performance.now(), px = 0, py = 0;
  el.addEventListener("pointermove", e => { const r = el.getBoundingClientRect(); px = (e.clientX - r.left) / r.width - 0.5; py = (e.clientY - r.top) / r.height - 0.5; });
  const speed = opts.speed ?? 0.25;
  function frame(now) {
    const t = (now - t0) / 1000;
    subject.rotation.y = (opts.kind === "device" ? -0.5 : 0) + t * speed;
    camera.position.x += (px * 0.6 - camera.position.x) * 0.05;
    camera.position.y += (-py * 0.4 - camera.position.y) * 0.05;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  return {
    start() { if (!raf) { t0 = performance.now() - 0; raf = requestAnimationFrame(frame); } },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    renderOnce() { renderer.render(scene, camera); },
    poster() { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png"); },
  };
}
