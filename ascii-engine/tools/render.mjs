#!/usr/bin/env node
// Deterministic frame renderer: drives a real browser (WebGL 2) through Playwright and writes PNG frames.
//
//   Sequence:  node tools/render.mjs --scene prototype --format 9x16 --quality final [--cut name] [--start 1 --end 300] [--encode]
//   Stills:    node tools/render.mjs --scene prototype --still --frames 1,90,180 [--quality draft] [--repeat-check]
//
// Frames go to <root>/episodes/<cut>/frames/frame_####.png (the repo's convention), the cut config to
// <root>/configs/<cut>.json, so tools/pipeline (manifest, validate, assemble_safe, verify_mp4) works unchanged.
// Existing frames are skipped (resume after a crash) and never overwritten. Stills never overwrite either
// (a _v2, _v3... suffix is added). One render at a time: a lock file in logs/ stops a second job on the same cut.
//
// Browser: --channel msedge | chrome uses an installed browser (Windows: no download needed). Without it the
// Playwright-managed Chromium is used. --headed shows the window (always gets the GPU). The WebGL renderer string
// is printed so you can see whether the GPU or a software rasteriser (SwiftShader) is in use.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer, ENGINE_ROOT } from './serve.mjs';
import { encodeRGBFromGL } from './png.mjs';

const REPO_ROOT = path.resolve(ENGINE_ROOT, '..');

const { values: a } = parseArgs({
  options: {
    scene: { type: 'string', default: 'prototype' },
    format: { type: 'string', default: '9x16' },
    size: { type: 'string' },
    quality: { type: 'string', default: 'final' },
    fps: { type: 'string', default: '30' },
    seed: { type: 'string', default: '1' },
    cut: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    still: { type: 'boolean', default: false },
    frames: { type: 'string' },
    'repeat-check': { type: 'boolean', default: false },
    encode: { type: 'boolean', default: false },
    root: { type: 'string', default: REPO_ROOT },
    channel: { type: 'string' },
    executable: { type: 'string' },
    headed: { type: 'boolean', default: false },
    gpu: { type: 'boolean', default: false },
    python: { type: 'string', default: process.platform === 'win32' ? 'python' : 'python3' },
    'no-manifest': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '180' },
    help: { type: 'boolean', default: false },
  },
});

if (a.help) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const root = path.resolve(a.root);
const fps = Number(a.fps);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

async function loadPlaywright() {
  for (const name of ['playwright-core', 'playwright']) {
    try { return (await import(name)).chromium; } catch { /* try next */ }
  }
  for (const dir of (process.env.NODE_PATH || '').split(path.delimiter).concat(['/opt/node-tools/node_modules']).filter(Boolean)) {
    try { return createRequire(path.join(dir, 'x.js'))('playwright').chromium; } catch { /* try next */ }
  }
  throw new Error('Playwright not found. Run `npm install` in ascii-engine/ (installs playwright-core).');
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, -ext.length);
  for (let v = 2; ; v++) { const q = `${base}_v${v}${ext}`; if (!fs.existsSync(q)) return q; }
}

function writeAtomic(file, buf) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}


async function main() {
  const chromium = await loadPlaywright();
  const { server, url } = await startServer();
  const args = ['--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
  if (a.gpu) args.push('--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []));
  const browser = await chromium.launch({ headless: !a.headed, channel: a.channel, executablePath: a.executable, args });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  const problems = [];
  page.on('console', (m) => {
    const txt = m.text();
    if (m.type() === 'error' || /Shader Error|WebGLProgram/.test(txt)) { problems.push(txt); console.error('[browser]', txt.slice(0, 2000)); }
  });
  page.on('pageerror', (e) => { problems.push(String(e)); console.error('[pageerror]', e); });

  const qs = new URLSearchParams({ mode: 'render', scene: a.scene, format: a.format, quality: a.quality, fps: String(fps), seed: a.seed });
  if (a.size) qs.set('size', a.size);
  const t0 = Date.now();
  await page.goto(`${url}index.html?${qs}`);
  await page.waitForFunction(() => window.__engine?.ready || window.__engineError, null, { timeout: Number(a.timeout) * 1000 });
  const err = await page.evaluate(() => window.__engineError);
  if (err) throw new Error(`scene failed to build:\n${err}`);
  if (problems.length) throw new Error(`browser reported errors during build (see above)`);
  const info = await page.evaluate(() => window.__engine.info);
  console.log(`scene ${info.scene} | ${info.width}x${info.height} @ ${fps} fps | quality ${info.quality} (density ${info.density}, ss ${info.supersample})`);
  console.log(`WebGL: ${info.renderer} | ${info.particles.toLocaleString()} particles | ~${info.drawCallsApprox} scene draws | build ${info.buildMs} ms (load ${Date.now() - t0} ms)`);
  const total = Math.round(info.duration * fps);
  // fetchRaw: the browser renders frame n and returns raw pixels. encode: RGB PNG in Node.
  // The sequence loop requests frame n+1 before encoding frame n, so encoding overlaps the next render.
  const fetchRaw = async (n) => {
    const s = Date.now();
    const raw = Buffer.from(await page.evaluate((k) => window.__engine.renderFrameRaw(k), n), 'base64');
    if (problems.length) throw new Error('browser reported errors while rendering');
    if (raw.length !== info.width * info.height * 4) throw new Error(`frame ${n}: got ${raw.length} bytes of pixels, expected ${info.width * info.height * 4}`);
    return { raw, renderMs: Date.now() - s };
  };
  const encode = (raw) => encodeRGBFromGL(raw, info.width, info.height, { level: 4 });
  const render = async (n) => {
    const s = Date.now();
    const { raw, renderMs } = await fetchRaw(n);
    return { png: encode(raw), ms: Date.now() - s, renderMs };
  };

  const cut = a.cut || `${a.scene}_${info.format.replace(/[^a-z0-9]/gi, '')}_${a.quality}_${fps}fps`;
  if (!/^[A-Za-z0-9_-]+$/.test(cut)) throw new Error(`--cut must be a plain folder name, got ${cut}`);
  const cutDir = path.join(root, 'episodes', cut);

  if (a.still) {
    const list = (a.frames || '1').split(',').map((s) => Number(s.trim())).filter((n) => n >= 1);
    const dir = path.join(cutDir, 'previews');
    fs.mkdirSync(dir, { recursive: true });
    for (const n of list) {
      const r = await render(n);
      const out = uniquePath(path.join(dir, `still_f${String(n).padStart(4, '0')}.png`));
      writeAtomic(out, r.png);
      let note = '';
      if (a['repeat-check']) {
        const r2 = await render(n);
        const h1 = crypto.createHash('sha1').update(r.png).digest('hex'), h2 = crypto.createHash('sha1').update(r2.png).digest('hex');
        note = h1 === h2 ? ' | re-render identical (deterministic)' : ' | RE-RENDER DIFFERS';
      }
      console.log(`still f${n} (t=${((n - 1) / fps).toFixed(3)} s) ${r.ms} ms -> ${path.relative(root, out)}${note}`);
    }
    await browser.close(); server.close();
    return;
  }

  // ---- sequence
  const cfgPath = path.join(root, 'configs', `${cut}.json`);
  const cfg = {
    cut, engine: 'ascii-engine', scene: a.scene, format: info.format, quality: a.quality, seed: Number(a.seed),
    frame_start: 1, frame_end: total, fps, width: info.width, height: info.height, color_mode: 'RGB', audio: 'forbidden',
    max_chunk: 300, dark_ranges: (info.meta.darkRanges || []).map(([t0, t1]) => [Math.max(1, Math.round(t0 * fps) + 1), Math.min(total, Math.round(t1 * fps) + 1)]),
    notes: 'Rendered by ascii-engine/tools/render.mjs (Three.js/WebGL, no Blender). Silent: VO/music/SFX are added in CapCut.',
  };
  const renderKeys = ['cut', 'engine', 'scene', 'format', 'quality', 'seed', 'frame_start', 'frame_end', 'fps', 'width', 'height'];
  if (fs.existsSync(cfgPath)) {
    const old = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const diff = renderKeys.filter((k) => JSON.stringify(old[k]) !== JSON.stringify(cfg[k]));
    if (diff.length) throw new Error(`${path.relative(root, cfgPath)} exists with different render settings (${diff.join(', ')}). Use a new --cut name; existing files are never overwritten.`);
  } else {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`wrote ${path.relative(root, cfgPath)}`);
  }
  const framesDir = path.join(cutDir, 'frames'), logsDir = path.join(cutDir, 'logs');
  for (const d of [framesDir, logsDir, path.join(cutDir, 'previews'), path.join(cutDir, 'output')]) fs.mkdirSync(d, { recursive: true });

  const lock = path.join(logsDir, 'render.lock');
  if (fs.existsSync(lock)) throw new Error(`${path.relative(root, lock)} exists: another render of this cut is running (delete the lock only if it crashed).`);
  fs.writeFileSync(lock, String(process.pid));
  const python = spawnSync(a.python, ['--version'], { encoding: 'utf8' }).status === 0 ? a.python : null;
  try {
    if (!a['no-manifest']) {
      if (!python) console.warn('python not found: skipping the render manifest (assemble later with --no-manifest)');
      else {
        const r = spawnSync(python, [path.join(root, 'tools/pipeline/manifest.py'), 'start', '--config', cfgPath, '--root', root], { encoding: 'utf8' });
        process.stdout.write(r.stdout); process.stderr.write(r.stderr);
        if (r.status !== 0) throw new Error('manifest.py start refused (see above)');
      }
    }
    const first = Math.max(1, Number(a.start || 1)), last = Math.min(total, Number(a.end || total));
    const log = { cut, started: new Date().toISOString(), info, first, last, frames: {} };
    const logPath = uniquePath(path.join(logsDir, `render_${stamp()}.json`));
    const framePath = (n) => path.join(framesDir, `frame_${String(n).padStart(4, '0')}.png`);
    const todo = [];
    let skipped = 0;
    for (let n = first; n <= last; n++) { if (fs.existsSync(framePath(n))) skipped++; else todo.push(n); }
    let done = 0;
    const tStart = Date.now();
    let pending = todo.length ? fetchRaw(todo[0]) : null;
    for (let i = 0; i < todo.length; i++) {
      const n = todo[i];
      const tFrame = Date.now();
      const { raw, renderMs } = await pending;
      pending = i + 1 < todo.length ? fetchRaw(todo[i + 1]) : null; // browser starts the next frame now
      writeAtomic(framePath(n), encode(raw));
      done++;
      log.frames[n] = { renderMs, encodeMs: Date.now() - tFrame };
      if (done % 10 === 0 || i === todo.length - 1) {
        const avg = (Date.now() - tStart) / done, left = (todo.length - done) * avg;
        console.log(`frame ${n}/${last} | render ${renderMs} ms | wall avg ${avg.toFixed(0)} ms/frame | ETA ${(left / 60000).toFixed(1)} min`);
        fs.writeFileSync(logPath, JSON.stringify(log, null, 1));
      }
    }
    if (pending) await pending;
    const msSum = Date.now() - tStart;
    log.finished = new Date().toISOString();
    log.summary = { rendered: done, skipped, avgWallMsPerFrame: done ? Math.round(msSum / done) : 0, wallSec: Math.round(msSum / 1000) };
    fs.writeFileSync(logPath, JSON.stringify(log, null, 1));
    console.log(`rendered ${done}, skipped ${skipped} existing | ${log.summary.avgWallMsPerFrame} ms/frame (wall) | ${log.summary.wallSec} s | log ${path.relative(root, logPath)}`);
  } finally {
    fs.rmSync(lock, { force: true });
    await browser.close();
    server.close();
  }

  if (a.encode) {
    if (python) {
      const args2 = [path.join(root, 'tools/pipeline/assemble_safe.py'), '--config', cfgPath, '--root', root];
      if (a['no-manifest']) args2.push('--no-manifest');
      const r = spawnSync(python, args2, { encoding: 'utf8' });
      process.stdout.write(r.stdout); process.stderr.write(r.stderr);
      if (r.status !== 0) process.exitCode = r.status;
    } else {
      const r = spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'tools/encode.mjs'), '--config', cfgPath, '--root', root], { stdio: 'inherit' });
      if (r.status !== 0) process.exitCode = r.status;
    }
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
