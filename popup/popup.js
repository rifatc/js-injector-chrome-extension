// Popup: global toggle + per-rule toggles for whatever the active tab shows.

import { load, save } from '../lib/store.js';
import { ruleMatchesUrl, normalizeDomain } from '../lib/match.js';

async function probeEngine() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'jsi:probe' });
    if (res && typeof res.ok === 'boolean') return res;
  } catch { /* SW unavailable */ }
  return { ok: false };
}

const $ = (id) => document.getElementById(id);

function switchEl(checked, onchange, ariaLabel) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch-input';
  input.checked = checked;
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('change', () => onchange(input.checked));
  const label = document.createElement('label');
  label.className = 'global-switch';
  const track = document.createElement('span');
  track.className = 'switch-track';
  const knob = document.createElement('span');
  knob.className = 'switch-knob';
  track.append(knob);
  label.append(input, track);
  return label;
}

async function requestSync() {
  try { await chrome.runtime.sendMessage({ type: 'jsi:sync' }); } catch { /* background unavailable */ }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  let host = null;
  try { host = new URL(url).hostname; } catch { /* not a normal page */ }

  const data = await load(chrome);

  // engine status (asked via the service worker, where the API binds)
  probeEngine().then((res) => {
    const pill = $('status-pill');
    pill.textContent = res.ok ? 'ready' : 'engine off';
    pill.className = 'pill ' + (res.ok ? 'pill-ok' : 'pill-off');
    $('engine-warning').hidden = res.ok;
  });

  // global toggle
  const globalToggle = $('global-toggle');
  globalToggle.checked = data.settings.globalEnabled;
  globalToggle.addEventListener('change', async () => {
    data.settings.globalEnabled = globalToggle.checked;
    await save(chrome, data);
    await requestSync();
  });

  // matching rules
  $('site-host').textContent = host || 'This page';
  $('site-host').title = url || '';
  const matching = [];
  for (const rule of data.rules) {
    try {
      if (ruleMatchesUrl(rule, url)) matching.push(rule);
    } catch { /* malformed rule values are surfaced by the dashboard */ }
  }

  const list = $('rules-list');
  for (const rule of matching) {
    const active = rule.scripts.filter((s) => s.enabled).length;
    const row = document.createElement('div');
    row.className = 'rule-row' + (rule.enabled ? '' : ' off');
    const name = document.createElement('span');
    name.className = 'rule-name';
    name.textContent = rule.name;
    name.title = rule.name;
    const count = document.createElement('span');
    count.className = 'rule-scripts';
    count.textContent = `${active}/${rule.scripts.length}`;
    const sw = switchEl(rule.enabled, async (v) => {
      rule.enabled = v;
      await save(chrome, data);
      await requestSync();
      row.classList.toggle('off', !v);
    }, `Toggle ${rule.name}`);
    row.append(sw, name, count);
    list.append(row);
  }
  $('no-rules').hidden = matching.length > 0;

  // add rule for this site -> dashboard prefill
  $('btn-add-site').addEventListener('click', () => {
    const base = normalizeDomain(host || '') || host || '';
    const q = base ? `?domain=${encodeURIComponent(base)}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${q}`) });
  });

  $('btn-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });
}

init().catch((e) => {
  document.getElementById('site-host').textContent = 'Error';
  console.error(e);
});
