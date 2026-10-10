// Service worker: keeps chrome.userScripts registrations in sync with storage.
// The userScripts API only binds in the service worker context (on current
// Chrome, extension pages see an empty chrome.userScripts object), so the SW
// is the single place that touches it; dashboard/popup ask via messages.

import { load, KEY, STATUS_KEY } from './lib/store.js';
import { sync, probeAvailability, configureWorld } from './lib/sync.js';

let syncChain = Promise.resolve();

// Serialize syncs: storage.onChanged and explicit messages can race, and
// concurrent register() calls for the same id throw duplicate-id errors.
function runSync() {
  syncChain = syncChain.then(async () => {
    const data = await load(chrome);
    const result = await sync(chrome, data);
    if (result.ok) await configureWorld(chrome);
    await chrome.storage.local.set({ [STATUS_KEY]: result });
    return result;
  });
  return syncChain;
}

chrome.runtime.onInstalled.addListener(() => {
  runSync().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  runSync().catch(console.error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEY]) {
    runSync().catch(console.error);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'jsi:sync') {
    runSync().then(sendResponse).catch((e) => sendResponse({ ok: false, reason: 'error', error: String(e) }));
    return true; // async response
  }
  if (msg?.type === 'jsi:probe') {
    probeAvailability(chrome).then(sendResponse);
    return true;
  }
  return false;
});
