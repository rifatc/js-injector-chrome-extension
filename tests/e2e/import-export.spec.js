// Export downloads current rules; import replaces them (with dialog confirm)
// and the imported rule is immediately live.

import { test, expect } from './helpers/extension.js';
import { ensureUserScripts, seedRules, rule, data, dashboardUrl, getExtensionId } from './helpers/util.js';

const markerA = `document.body.insertAdjacentHTML('beforeend', '<div id="ji-exp">exported</div>');`;

test.beforeAll(async ({ ext }) => {
  await ensureUserScripts(ext, getExtensionId(ext));
});

test('export then import round-trips rules', async ({ ext, server, page }) => {
  const id = getExtensionId(ext);
  await seedRules(ext, id, data([
    rule({ name: 'before export', scripts: [{ id: 's1', name: 'one', code: markerA, runAt: 'documentEnd', world: 'MAIN', enabled: true }] }),
  ]));

  // sanity: rule is live
  await page.goto(server.url);
  await expect(page.locator('#ji-exp')).toHaveCount(1);

  // export
  await page.goto(dashboardUrl(id));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export'),
  ]);
  const exportPath = await download.path();
  const { readFile } = await import('node:fs/promises');
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  expect(exported.rules).toHaveLength(1);
  expect(exported.rules[0].name).toBe('before export');

  // build an import payload with a renamed rule + different marker code
  const imported = structuredClone(exported);
  imported.rules[0].name = 'after import';
  imported.rules[0].scripts[0].code =
    `document.body.insertAdjacentHTML('beforeend', '<div id="ji-imp">imported</div>');`;

  const importFile = `${imported.rules[0].id}.json`;


  // auto-accept the replace confirm()
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#import-file', {
    name: importFile,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.locator('.rule-card .rule-name')).toHaveText('after import');

  // imported rule injects the new marker
  await page.goto(server.url);
  await expect(page.locator('#ji-imp')).toHaveCount(1);
  await expect(page.locator('#ji-exp')).toHaveCount(0);
});

test('import rejects invalid JSON with an error toast', async ({ ext, page }) => {
  await page.goto(dashboardUrl(getExtensionId(ext)));
  page.once('dialog', () => { throw new Error('confirm should not appear for invalid import'); });
  await page.setInputFiles('#import-file', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"rules": [ { "match": { "type": "regex", "value": "(" } } ]}'),
  });
  await expect(page.locator('#toast')).toHaveClass(/toast-error/);
  await expect(page.locator('#toast')).toContainText('Import rejected');
});
