import { defineConfig } from 'vitest/config';

// Acceptance runs that measure time (M2: 18 players across the six villages). They run alone, one file at a time,
// so no other test shares the CPU: `npm run test:accept`. The ordinary suite (`npm test`) leaves them out.
export default defineConfig({
  test: {
    include: ['tests/acceptance/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 240_000,
    globalSetup: ['./tests/setup/buildWorker.ts'],
  },
});
