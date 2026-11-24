#!/usr/bin/env node
// Reference comparison sheets (Phase 4 checklist). Extracts N evenly spaced stills from the reference video and
// from a rendered cut, and stacks them as side-by-side pairs (reference left, render right) in one PNG.
//   node tools/compare.mjs --ref reference/<video>.mp4 --cut <cut> [--count 6] [--mp4 <render.mp4>]
// Output: episodes/<cut>/previews/compare_<time>.png (never overwrites). Also writes a reference-only contact sheet.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { ENGINE_ROOT } from './serve.mjs';

const { values: a } = parseArgs({ options: {
  ref: { type: 'string' }, cut: { type: 'string' }, mp4: { type: 'string' }, count: { type: 'string', default: '6' },
  root: { type: 'string', default: path.resolve(ENGINE_ROOT, '..') }, height: { type: 'string', default: '640' },
} });
if (!a.ref || !a.cut) { console.error('usage: node tools/compare.mjs --ref <video> --cut <cut> [--count 6]'); process.exit(2); }
const root = path.resolve(a.root);
const cutDir = path.join(root, 'episodes', a.cut);
let mp4 = a.mp4;
if (!mp4) {
  const outs = fs.readdirSync(path.join(cutDir, 'output')).filter((f) => f.endsWith('.mp4') && !f.includes('.partial'));
  if (!outs.length) throw new Error(`no MP4 in ${cutDir}/output; render with --encode first or pass --mp4`);
  mp4 = path.join(cutDir, 'output', outs.sort().at(-1));
}
const dur = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());
const n = Number(a.count), H = Number(a.height);
const dRef = dur(a.ref), dOut = dur(mp4);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const tmp = fs.mkdtempSync(path.join(cutDir, 'previews', '.compare_'));
const grab = (file, t, out) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=-2:${H}`, out]);
  if (r.status !== 0) throw new Error(`ffmpeg could not grab ${t}s from ${file}`);
};
const pairs = [];
for (let i = 0; i < n; i++) {
  const u = (i + 0.5) / n;
  const r = path.join(tmp, `ref_${i}.png`), o = path.join(tmp, `out_${i}.png`);
  grab(a.ref, u * dRef, r);
  grab(mp4, u * dOut, o);
  pairs.push([r, o]);
}
const inputs = pairs.flat().flatMap((f) => ['-i', f]);
const rows = pairs.map((_, i) => `[${i * 2}][${i * 2 + 1}]hstack=2[r${i}]`).join(';');
const stack = pairs.map((_, i) => `[r${i}]`).join('') + `vstack=${n}`;
let out = path.join(cutDir, 'previews', `compare_${stamp}.png`);
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', ...inputs, '-filter_complex', `${rows};${stack}`, out], { stdio: 'inherit' });
const sheet = path.join(cutDir, 'previews', `reference_sheet_${stamp}.png`);
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', ...pairs.flatMap(([r]) => ['-i', r]), '-filter_complex', `${pairs.map((_, i) => `[${i}]`).join('')}hstack=${n}`, sheet], { stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`reference ${path.basename(a.ref)} (${dRef.toFixed(1)} s) vs ${path.basename(mp4)} (${dOut.toFixed(1)} s)`);
console.log(`wrote ${path.relative(root, out)} and ${path.relative(root, sheet)}`);
console.log('Checklist: character readability, particle density, ASCII pattern quality, environment detail, lighting, colour balance, depth.');
