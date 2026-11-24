import { Engine } from './core/Engine.js';
import { resolveFormat, resolveQuality } from './core/presets.js';
import { loadAtlasFont } from './glyphs/GlyphAtlas.js';

// Entry point. URL parameters:
//   scene=prototype  mode=preview|render  format=9x16|16x9|1x1|9x16-hd|16x9-hd  size=WxH  quality=preview|draft|final|master
//   fps=30  seed=1  t=<seconds> (preview start time)
// Render mode exposes window.__engine = { ready, info, renderFrame(n) -> PNG data URL } for tools/render.mjs.

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'preview';
const sceneName = (q.get('scene') || 'prototype').replace(/[^a-z0-9_-]/gi, '');
const errBox = document.getElementById('err');

function fail(e) {
  const msg = e?.stack || e?.message || String(e);
  window.__engineError = msg;
  if (errBox) errBox.textContent = msg;
  console.error(msg);
}
window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

async function start() {
  if (mode === 'render') document.body.classList.add('render');
  const format = resolveFormat(q.get('format') || '9x16', q.get('size'));
  const quality = resolveQuality(q.get('quality') || (mode === 'render' ? 'final' : 'preview'));
  const fps = Number(q.get('fps') || 30);
  const seed = Number(q.get('seed') || 1);
  let { width, height } = format;
  if (mode === 'preview') {
    width = Math.round((width * quality.previewScale) / 2) * 2;
    height = Math.round((height * quality.previewScale) / 2) * 2;
  }
  await loadAtlasFont();
  const canvas = document.createElement('canvas');
  document.getElementById('stage').appendChild(canvas);
  const mod = await import(`../scenes/${sceneName}.js`);
  // Letterbox (picture aspect inside the frame): URL ?letterbox=4:5 | 0.8 | 0 overrides the scene's meta.letterbox.
  const lb = q.get('letterbox') ?? String(mod.meta?.letterbox ?? 0);
  const letterbox = lb.includes(':') ? lb.split(':').reduce((x, y) => Number(x) / Number(y)) : Number(lb);
  const engine = new Engine({ canvas, width, height, quality, fps, seed, mode, letterbox });
  const t0 = performance.now();
  await mod.build(engine, { params: q, format });
  const buildMs = Math.round(performance.now() - t0);
  engine.setTime(0, 1);
  engine.render();

  if (mode === 'render') {
    window.__engine = {
      ready: true,
      info: { ...engine.info(), scene: sceneName, format: format.name, buildMs, meta: mod.meta || {} },
      renderFrame: (n) => engine.renderFrame(n),
      renderFrameRaw: (n) => engine.renderFrameRaw(n),
      setParam: (k, v) => { engine.params[k] = v; },
    };
    return;
  }
  preview(engine, format, quality, buildMs);
}

function preview(engine, format, quality, buildMs) {
  const play = document.getElementById('play');
  const scrub = document.getElementById('scrub');
  const time = document.getElementById('time');
  const stats = document.getElementById('stats');
  const fmtSel = document.getElementById('format');
  const qSel = document.getElementById('quality');
  fmtSel.value = format.name in { '9x16': 1, '16x9': 1, '1x1': 1 } ? format.name : '9x16';
  qSel.value = quality.name;
  const reload = () => { q.set('format', fmtSel.value); q.set('quality', qSel.value); location.search = q.toString(); };
  fmtSel.onchange = qSel.onchange = reload;

  let playing = true, t = Number(q.get('t') || 0), last = performance.now(), frames = 0, acc = 0, fpsShown = 0;
  play.onclick = () => { playing = !playing; play.textContent = playing ? 'pause' : 'play'; };
  scrub.oninput = () => { t = (scrub.value / 1000) * engine.duration; };
  const info = engine.info();
  const loop = (now) => {
    const real = Math.max((now - last) / 1000, 0); // the first rAF timestamp can predate performance.now()
    const dt = Math.min(real, 0.1); // playback never jumps more than 0.1 s per frame (slow machines play slower)
    last = now;
    if (playing) t = (t + dt) % engine.duration;
    engine.setTime(t);
    engine.render();
    scrub.value = String(Math.round((t / engine.duration) * 1000));
    time.textContent = `${t.toFixed(2)} s`;
    frames++; acc += real;
    if (acc > 0.5) { fpsShown = frames / acc; frames = 0; acc = 0; }
    stats.textContent = `${fpsShown.toFixed(0)} fps | ${engine.width}x${engine.height} | ${(info.particles / 1000).toFixed(0)}k particles | ${info.drawCallsApprox} draws | build ${buildMs} ms | ${String(info.renderer).slice(0, 48)}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

start().catch(fail);
