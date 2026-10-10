// Regex matching + strict-CSP exemption.

import { test, expect } from './helpers/extension.js';
import { ensureUserScripts, seedRules, rule, data, getExtensionId } from './helpers/util.js';

const marker = `document.body.insertAdjacentHTML('beforeend', '<div id="ji-regex" class="injected">regex</div>');`;

test.beforeAll(async ({ ext }) => {
  await ensureUserScripts(ext, getExtensionId(ext));
});

test('regex rule fires only on matching URLs', async ({ ext, server, page }) => {
  await seedRules(ext, getExtensionId(ext), data([
    rule({
      name: 'subpath only',
      match: { type: 'regex', value: String.raw`^http://127\.0\.0\.1:\d+/sub/`, flags: '' },
      scripts: [{ id: 's1', name: 'marker', code: marker, runAt: 'documentEnd', world: 'MAIN', enabled: true }],
    }),
  ]));

  await page.goto(`${server.url}/sub/page.html`);
  await expect(page.locator('#ji-regex')).toHaveCount(1);

  await page.goto(`${server.url}/`);
  await expect(page.locator('#ji-regex')).toHaveCount(0);
});

test('user scripts are exempt from a strict page CSP', async ({ ext, server, page }) => {
  await seedRules(ext, getExtensionId(ext), data([
    rule({
      name: 'csp bypass',
      match: { type: 'regex', value: String.raw`/csp\.html$`, flags: '' },
      scripts: [{ id: 's1', name: 'marker', code: marker, runAt: 'documentEnd', world: 'MAIN', enabled: true }],
    }),
  ]));

  const [response] = await Promise.all([page.waitForResponse(server.url + '/csp.html'), page.goto(`${server.url}/csp.html`)]);
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('#ji-regex')).toHaveCount(1);
});
