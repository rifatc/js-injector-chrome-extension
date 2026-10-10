// Full user flow: enable engine, create a rule with two scripts through the
// dashboard UI, verify both scripts inject (in order) on a matched page.

import { test, expect } from './helpers/extension.js';
import { ensureUserScripts, dashboardUrl, getExtensionId } from './helpers/util.js';

test.beforeAll(async ({ ext }) => {
  await ensureUserScripts(ext, getExtensionId(ext));
});

test('engine is enabled and ready', async ({ ext }) => {
  await ensureUserScripts(ext, getExtensionId(ext));
});

test('create a two-script rule via the dashboard UI and see it inject', async ({ ext, server, page }) => {
  const id = getExtensionId(ext);

  await page.goto(dashboardUrl(id));
  await expect(page.locator('#status-pill')).toHaveText('engine ready');

  await page.click('#btn-new');
  await expect(page.locator('#editor')).toBeVisible();

  await page.locator('#editor .form-row input[type="text"]').first().fill('Localhost demo');
  await page.locator('#editor .form-row input[type="text"]').nth(1).fill('127.0.0.1');

  const code = `document.getElementById('markers').insertAdjacentHTML('beforeend', '<div data-ji="A">A</div>');`;
  await page.locator('#editor textarea.code').first().fill(code);

  await page.getByRole('button', { name: '+ Add script' }).click();
  const code2 = `document.getElementById('markers').insertAdjacentHTML('beforeend', '<div data-ji="B">B</div>');`;
  await page.locator('#editor textarea.code').nth(1).fill(code2);
  await page.locator('#editor .script-block').nth(1).locator('input[type="text"]').first().fill('second');

  await page.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.locator('.rule-card .rule-name')).toHaveText('Localhost demo');

  // Open a page on the fixture server and verify injection.
  await page.goto(server.url);
  await expect(page.locator('[data-ji="A"]')).toHaveText('A');
  await expect(page.locator('[data-ji="B"]')).toHaveText('B');
  const order = await page.locator('#markers > div').evaluateAll((els) => els.map((e) => e.dataset.ji));
  expect(order).toEqual(['A', 'B']);

  // Persistence across reloads.
  await page.reload();
  await expect(page.locator('[data-ji="A"]')).toHaveText('A');
});

test('dashboard tester shows live match results', async ({ ext, server, page }) => {
  const id = getExtensionId(ext);
  await page.goto(dashboardUrl(id));
  await expect(page.locator('.rule-card .rule-name')).toHaveText('Localhost demo');

  await page.getByRole('button', { name: 'Edit' }).click();
  const tester = page.locator('.tester textarea');
  await tester.fill(`${server.url}\nhttps://example.com/`);
  const rows = page.locator('.tester-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass(/match-yes/);
  await expect(rows.nth(1)).toHaveClass(/match-no/);
  await page.getByRole('button', { name: 'Cancel' }).click();
});
