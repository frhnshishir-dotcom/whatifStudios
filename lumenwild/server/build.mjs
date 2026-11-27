// Builds the world server and its region worker into dist-server/ (npm run server:build).
import { build } from 'vite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'dist-server');
const entries = (process.argv[3] ?? 'main,regionWorker').split(',');
for (const [k, name] of entries.entries()) {
  await build({ root, logLevel: 'warn', build: { ssr: join(root, 'server', `${name}.ts`), outDir: out, emptyOutDir: k === 0, sourcemap: true } });
}
console.log(`Built ${entries.join(', ')} into ${out}`);
