#!/usr/bin/env node
// Zero-dependency static server for the engine folder (real-time preview, and the render tool's host page).
//   node tools/serve.mjs [--port 5173]   then open http://127.0.0.1:5173/?scene=prototype
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Start the server; resolves to { server, port, url }. port 0 = any free port. Serves 127.0.0.1 only. */
export function startServer({ root = ENGINE_ROOT, port = 0 } = {}) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      let rel = decodeURIComponent(u.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(base, '.' + rel);
      if (!file.startsWith(base + path.sep) && file !== base) { res.writeHead(403).end(); return; }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
      });
    } catch {
      res.writeHead(400).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({ server, port: p, url: `http://127.0.0.1:${p}/` });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 5173;
  startServer({ port }).then(({ url }) => {
    console.log(`ASCII engine preview: ${url}?scene=prototype`);
    console.log('Options: &format=9x16|16x9|1x1  &quality=preview|draft|final  &t=<seconds>');
  });
}
