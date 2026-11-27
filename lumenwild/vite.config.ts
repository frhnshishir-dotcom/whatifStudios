import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// COOP/COEP make the page cross-origin isolated, which enables SharedArrayBuffer for the simulation worker.
// The app falls back to a main-thread simulation when the page is not isolated (e.g. static hosting without headers).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation, port: 5180, strictPort: false },
  preview: { headers: isolation, port: 4180 },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    include: ['tests/**/*.test.ts'],
    // Timed acceptance runs go alone (vitest.accept.config.ts, `npm run test:accept`).
    exclude: [...configDefaults.exclude, 'tests/acceptance/**'],
    environment: 'node',
    // CI runners are slower than a laptop; tests that need longer set their own timeouts.
    testTimeout: 30_000,
    // Servers in tests generate regions on worker threads, as the real server does (see tests/setup/buildWorker.ts).
    globalSetup: ['./tests/setup/buildWorker.ts'],
  },
});
