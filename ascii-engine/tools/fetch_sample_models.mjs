#!/usr/bin/env node
// Download sample GLB models for testing the GLTF/GLB -> point-cloud path. They are NOT committed (third-party
// licences): they land in ascii-engine/assets/models/, which is git-ignored.
//   node tools/fetch_sample_models.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_ROOT } from './serve.mjs';

const MODELS = [
  {
    file: 'CesiumMan.glb',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CesiumMan/glTF-Binary/CesiumMan.glb',
    licence: 'CC-BY 4.0, (c) 2017 Analytical Graphics, Inc. (Cesium). Khronos glTF-Sample-Assets. Attribution required if published.',
  },
];

const dir = path.join(ENGINE_ROOT, 'assets', 'models');
fs.mkdirSync(dir, { recursive: true });
for (const m of MODELS) {
  const out = path.join(dir, m.file);
  if (fs.existsSync(out)) { console.log(`exists: ${path.relative(ENGINE_ROOT, out)}`); continue; }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(out + '.LICENSE.txt', `${m.licence}\nSource: ${m.url}\n`);
  console.log(`downloaded ${path.relative(ENGINE_ROOT, out)} (${m.licence})`);
}
