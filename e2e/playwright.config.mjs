// Playwright e2e suite: real Chrome + real extension + real bridge.
// Excluded from `npm test` — needs a Chrome binary (OPENCODE_CHROME_BIN or the
// usual install paths). Run with: npm run test:e2e
// Each worker boots a full environment; serial workers keep one Chrome at a time.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  retries: 0,
});
