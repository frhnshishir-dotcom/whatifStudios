import { defineConfig } from '@playwright/test';

// Browser tests run against `vite preview` (production build). In this container the Playwright browsers are
// preinstalled (PLAYWRIGHT_BROWSERS_PATH); on another machine run `npx playwright install chromium` once.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4180',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'npx vite preview --port 4180 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
