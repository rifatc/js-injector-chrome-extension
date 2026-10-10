// Worker-scoped Playwright fixtures: one persistent Chromium profile with the
// unpacked extension loaded, plus a local HTTP server for test pages.

import { test as base, chromium, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionRoot = path.resolve(here, '../../..');

export const test = base.extend({
  ext: [
    async ({}, use) => {
      const userDataDir = mkdtempSync(path.join(tmpdir(), 'js-injector-'));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: !!process.env.E2E_HEADLESS,
        viewport: { width: 1280, height: 900 },
        args: [
          `--disable-extensions-except=${extensionRoot}`,
          `--load-extension=${extensionRoot}`,
          '--enable-unsafe-extension-debugging',
        ],
      });
      let sw = context.serviceWorkers()[0];
      if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
      await use(context);
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
  server: [
    async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  page: async ({ ext }, use) => {
    const page = await ext.newPage();
    await use(page);
  },
});

export { expect };
