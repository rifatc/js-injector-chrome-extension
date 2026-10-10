// Helpers shared by E2E specs: enabling the userScripts engine via
// chrome://extensions UI automation (when needed) and seeding rule storage.

import { expect } from '@playwright/test';

export function dashboardUrl(extensionId, query = '') {
  return `chrome-extension://${extensionId}/dashboard/dashboard.html${query}`;
}

export function getExtensionId(context) {
  const sw = context.serviceWorkers()[0];
  return new URL(sw.url()).host;
}

/** Current engine status as reported by the dashboard pill. */
export async function engineStatus(page, extensionId) {
  await page.goto(dashboardUrl(extensionId));
  await page.waitForSelector('#status-pill', { state: 'attached' });
  await expect.poll(async () => page.textContent('#status-pill'), { timeout: 10_000 }).toBeTruthy();
  return (await page.textContent('#status-pill')).trim();
}

/**
 * Make sure the userScripts engine is usable. Chrome gates chrome.userScripts
 * behind a one-time consent: a global "Developer mode" toggle or (Chrome 135+)
 * a per-extension "Allow user scripts" toggle. We probe first and only drive
 * chrome://extensions when needed.
 */
/** Probe the engine inside the service worker, where the API binds. */
export async function engineProbe(context) {
  const sw = context.serviceWorkers()[0];
  if (!sw) return 'no-sw';
  return sw.evaluate(async () => {
    try {
      const u = chrome.userScripts;
      if (!u) return 'missing';
      const getAll = u.getScripts || u.getRegisteredScripts;
      if (!getAll) return 'missing';
      await getAll.call(u);
      return 'ready';
    } catch {
      return 'off';
    }
  });
}

export async function ensureUserScripts(context, extensionId) {
  if ((await engineProbe(context)) === 'ready') return;

  const page = await context.newPage();
  try {
    // Per-extension "Allow user scripts" toggle on the details page
    // (Chrome 135+); deep-linking with ?id= opens details directly.
    await page.goto(`chrome://extensions/?id=${extensionId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1200);

    const allowSel = 'extensions-toggle-row#allow-user-scripts cr-toggle';
    try {
      const toggle = page.locator(allowSel);
      await toggle.waitFor({ state: 'attached', timeout: 6000 });
      if ((await toggle.getAttribute('aria-checked')) !== 'true') {
        await toggle.click();
        await page.waitForTimeout(600);
      }
    } catch (e) {
      // Legacy fallback (Chrome 120-134): global Developer mode toggle.
      try {
        const dev = page.locator('extensions-toolbar cr-toggle#devMode');
        await dev.waitFor({ state: 'attached', timeout: 4000 });
        if ((await dev.getAttribute('aria-checked')) !== 'true') {
          await dev.click();
          await page.waitForTimeout(600);
        }
      } catch {
        console.error('[ensureUserScripts] could not flip any toggle:', e.message);
      }
    }
  } finally {
    await page.close();
  }

  await expect
    .poll(() => engineProbe(context), { timeout: 15_000, intervals: [500, 1000] })
    .toBe('ready');
}

/**
 * Replace rule storage from an extension page, then force a background sync.
 * This is the fast path for specs that don't need the dashboard UI flow.
 */
export async function seedRules(context, extensionId, data) {
  const page = await context.newPage();
  await page.goto(dashboardUrl(extensionId));
  await page.evaluate(async (payload) => {
    await chrome.storage.local.set({ jsInjectorData: payload });
    await chrome.runtime.sendMessage({ type: 'jsi:sync' });
  }, data);
  await page.close();
}

export function rule(over = {}) {
  return {
    id: 'r_e2e',
    name: 'E2E rule',
    enabled: true,
    allFrames: false,
    match: { type: 'domain', value: '127.0.0.1', flags: '' },
    scripts: [
      { id: 's_1', name: 'one', code: '', runAt: 'documentIdle', world: 'MAIN', enabled: true },
    ],
    ...over,
  };
}

export function data(rules) {
  return { version: 1, settings: { globalEnabled: true }, rules };
}
