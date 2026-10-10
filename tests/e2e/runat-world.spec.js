// runAt=document_start precedence in MAIN world + USER_SCRIPT world isolation.

import { test, expect } from './helpers/extension.js';
import { ensureUserScripts, seedRules, rule, data, getExtensionId } from './helpers/util.js';

test.beforeAll(async ({ ext }) => {
  await ensureUserScripts(ext, getExtensionId(ext));
});

test('document_start script beats the page\u2019s own inline script in MAIN world', async ({ ext, server, page }) => {
  await seedRules(ext, getExtensionId(ext), data([
    rule({
      name: 'pre-page',
      match: { type: 'regex', value: String.raw`/start\.html$`, flags: '' },
      scripts: [{ id: 's1', name: 'pre', code: 'window.__pre = "injected-before-page";', runAt: 'documentStart', world: 'MAIN', enabled: true }],
    }),
  ]));

  await page.goto(`${server.url}/start.html`);
  await expect(page.locator('#pre-check')).toHaveText('PASS');
});

test('USER_SCRIPT world shares the DOM but not the page JS ext', async ({ ext, server, page }) => {
  await seedRules(ext, getExtensionId(ext), data([
    rule({
      name: 'isolated',
      scripts: [
        {
          id: 's1',
          name: 'iso',
          code: 'window.__iso = "isolated"; document.title = "iso-ran";',
          runAt: 'documentEnd',
          world: 'USER_SCRIPT',
          enabled: true,
        },
      ],
    }),
  ]));

  await page.goto(`${server.url}/`);
  await expect(page).toHaveTitle('iso-ran'); // DOM is shared...
  const pageWindowFlag = await page.evaluate(() => window.__iso); // ...JS ext is not
  expect(pageWindowFlag).toBeUndefined();
});

test('MAIN world script shares the page JS ext', async ({ ext, server, page }) => {
  await seedRules(ext, getExtensionId(ext), data([
    rule({
      name: 'main-world',
      scripts: [{ id: 's1', name: 'main', code: 'window.__main = "shared";', runAt: 'documentEnd', world: 'MAIN', enabled: true }],
    }),
  ]));

  await page.goto(`${server.url}/`);
  await expect.poll(() => page.evaluate(() => window.__main)).toBe('shared');
});
