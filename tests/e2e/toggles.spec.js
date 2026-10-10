// Kill switches: per-rule toggle and global toggle both stop injection.

import { test, expect } from './helpers/extension.js';
import { ensureUserScripts, seedRules, rule, data, dashboardUrl, getExtensionId } from './helpers/util.js';

const marker = `document.body.insertAdjacentHTML('beforeend', '<div id="ji-toggle">on</div>');`;

async function markerCount(page, url) {
  await page.goto(url);
  return page.locator('#ji-toggle').count();
}

test.beforeAll(async ({ ext }) => {
  await ensureUserScripts(ext, getExtensionId(ext));
});

test('per-rule toggle disables injection, re-enable restores it', async ({ ext, server, page }) => {
  const id = getExtensionId(ext);
  await seedRules(ext, id, data([
    rule({ name: 'toggle me', scripts: [{ id: 's1', name: 'one', code: marker, runAt: 'documentEnd', world: 'MAIN', enabled: true }] }),
  ]));

  expect(await markerCount(page, server.url)).toBe(1);

  // Turn the rule off from the dashboard card switch (click the visible label).
  await page.goto(dashboardUrl(id));
  const sw = page.locator('.rule-card label.global-switch');
  await sw.click();
  await expect(page.locator('.rule-card')).toHaveClass(/disabled/);
  expect(await markerCount(page, server.url)).toBe(0);

  // And back on.
  await page.goto(dashboardUrl(id));
  await page.locator('.rule-card label.global-switch').click();
  expect(await markerCount(page, server.url)).toBe(1);
});

test('global kill switch disables everything without touching rules', async ({ ext, server, page }) => {
  const id = getExtensionId(ext);
  await seedRules(ext, id, data([
    rule({ name: 'still enabled', scripts: [{ id: 's1', name: 'one', code: marker, runAt: 'documentEnd', world: 'MAIN', enabled: true }] }),
  ]));

  expect(await markerCount(page, server.url)).toBe(1);

  await page.goto(dashboardUrl(id));
  await page.locator('header .global-switch').click();
  expect(await markerCount(page, server.url)).toBe(0);

  await page.goto(dashboardUrl(id));
  await page.locator('header .global-switch').click();
  expect(await markerCount(page, server.url)).toBe(1);
});

test('disabling a single script stops only that script', async ({ ext, server, page }) => {
  const id = getExtensionId(ext);
  await seedRules(ext, id, data([
    rule({
      name: 'two scripts',
      scripts: [
        { id: 'a', name: 'a', code: `document.body.insertAdjacentHTML('beforeend', '<div id="ji-a">a</div>');`, runAt: 'documentEnd', world: 'MAIN', enabled: true },
        { id: 'b', name: 'b', code: `document.body.insertAdjacentHTML('beforeend', '<div id="ji-b">b</div>');`, runAt: 'documentEnd', world: 'MAIN', enabled: false },
      ],
    }),
  ]));

  await page.goto(server.url);
  await expect(page.locator('#ji-a')).toHaveCount(1);
  await expect(page.locator('#ji-b')).toHaveCount(0);
});
