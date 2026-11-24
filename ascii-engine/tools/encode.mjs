#!/usr/bin/env node
// FFmpeg encoder fallback (no Python needed). Prefer tools/pipeline/assemble_safe.py, which render.mjs --encode
// uses when Python is available: it also checks the render manifest, black and stale frames.
//   node tools/encode.mjs --config ../configs/<cut>.json [--root ..] [--crf 16] [--preset slow]
// Checks every frame exists (frame_start..frame_end) and is an RGB PNG of the configured size, encodes H.264
// yuv420p at the config fps, never overwrites (adds _v2, _v3...), and verifies the result with ffprobe.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { ENGINE_ROOT } from './serve.mjs';

const { values: a } = parseArgs({ options: {
  config: { type: 'string' }, root: { type: 'string', default: path.resolve(ENGINE_ROOT, '..') },
  crf: { type: 'string', default: '16' }, preset: { type: 'string', default: 'slow' }, ffmpeg: { type: 'string', default: 'ffmpeg' }, ffprobe: { type: 'string', default: 'ffprobe' },
} });
if (!a.config) { console.error('usage: node tools/encode.mjs --config configs/<cut>.json'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(a.config, 'utf8'));
const root = path.resolve(a.root);
const framesDir = path.join(root, 'episodes', cfg.cut, 'frames');
const outDir = path.join(root, 'episodes', cfg.cut, 'output');

const bad = [];
for (let n = cfg.frame_start; n <= cfg.frame_end; n++) {
  const f = path.join(framesDir, `frame_${String(n).padStart(4, '0')}.png`);
  if (!fs.existsSync(f)) { bad.push(`${n}: missing`); continue; }
  const h = Buffer.alloc(26);
  const fd = fs.openSync(f, 'r'); fs.readSync(fd, h, 0, 26, 0); fs.closeSync(fd);
  if (h.toString('ascii', 12, 16) !== 'IHDR') { bad.push(`${n}: not a PNG`); continue; }
  const w = h.readUInt32BE(16), ht = h.readUInt32BE(20), ct = h[25];
  if (w !== cfg.width || ht !== cfg.height) bad.push(`${n}: ${w}x${ht}, expected ${cfg.width}x${cfg.height}`);
  else if (ct !== 2) bad.push(`${n}: PNG colour type ${ct}, expected 2 (RGB)`);
}
if (bad.length) { console.error(`REFUSED: ${bad.length} bad frame(s):\n  ${bad.slice(0, 20).join('\n  ')}`); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
let out = path.join(outDir, `${cfg.cut}_${cfg.width}x${cfg.height}.mp4`);
for (let v = 2; fs.existsSync(out); v++) out = path.join(outDir, `${cfg.cut}_${cfg.width}x${cfg.height}_v${v}.mp4`);
const partial = out.replace(/\.mp4$/, '.partial.mp4');
const r = spawnSync(a.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-framerate', String(cfg.fps), '-start_number', String(cfg.frame_start),
  '-i', path.join(framesDir, 'frame_%04d.png'), '-frames:v', String(cfg.frame_end - cfg.frame_start + 1),
  '-c:v', 'libx264', '-preset', a.preset, '-crf', a.crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', partial], { stdio: 'inherit' });
if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }

const p = spawnSync(a.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames', '-of', 'json', partial], { encoding: 'utf8' });
const s = JSON.parse(p.stdout).streams[0];
const expectFrames = cfg.frame_end - cfg.frame_start + 1;
const ok = s.codec_name === 'h264' && s.width === cfg.width && s.height === cfg.height && s.pix_fmt === 'yuv420p'
  && s.r_frame_rate === `${cfg.fps}/1` && Number(s.nb_read_frames) === expectFrames;
console.log(`[verify] ${s.codec_name} ${s.width}x${s.height} ${s.pix_fmt} ${s.r_frame_rate} fps, ${s.nb_read_frames}/${expectFrames} frames -> ${ok ? 'OK' : 'MISMATCH'}`);
if (!ok) { console.error(`kept for inspection: ${partial}`); process.exit(1); }
fs.renameSync(partial, out);
console.log(`wrote ${path.relative(root, out)}`);
