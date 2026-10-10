// Storage layer: schema, defaults, validation, import/export.
// All extension data lives under a single chrome.storage.local key so
// background sync is triggered atomically by storage.onChanged.

import { MATCH_TYPES, RUN_ATS, WORLDS, uid, normalizeDomain, validateRegex, validatePattern } from './match.js';

export const KEY = 'jsInjectorData';
export const STATUS_KEY = 'jsiSyncStatus';
export const SCHEMA_VERSION = 1;

export function defaultData() {
  return {
    version: SCHEMA_VERSION,
    settings: { globalEnabled: true },
    rules: [],
  };
}

export function newRule(partial = {}) {
  return {
    id: uid('r'),
    name: 'New rule',
    enabled: true,
    match: { type: 'domain', value: '', flags: '' },
    allFrames: false,
    scripts: [newScript()],
    ...partial,
  };
}

export function newScript(partial = {}) {
  return {
    id: uid('s'),
    name: 'Script 1',
    code: '',
    runAt: 'documentIdle',
    world: 'MAIN',
    enabled: true,
    ...partial,
  };
}

export async function load(chrome) {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return normalizeData(stored);
}

export async function save(chrome, data) {
  await chrome.storage.local.set({ [KEY]: data });
}

export function normalizeData(input) {
  const data = defaultData();
  if (!input || typeof input !== 'object') return data;
  if (Number.isInteger(input.version)) data.version = input.version;
  if (input.settings && typeof input.settings === 'object') {
    data.settings.globalEnabled = input.settings.globalEnabled !== false;
  }
  if (Array.isArray(input.rules)) {
    data.rules = input.rules.filter((r) => r && typeof r === 'object').map(normalizeRule);
  }
  return data;
}

function normalizeRule(rule) {
  return {
    id: String(rule.id || uid('r')),
    name: String(rule.name || 'Unnamed rule'),
    enabled: rule.enabled !== false,
    match: {
      type: MATCH_TYPES.includes(rule.match?.type) ? rule.match.type : 'domain',
      value: String(rule.match?.value ?? ''),
      flags: String(rule.match?.flags ?? ''),
    },
    allFrames: Boolean(rule.allFrames),
    scripts: Array.isArray(rule.scripts)
      ? rule.scripts.filter((s) => s && typeof s === 'object').map(normalizeScript)
      : [],
  };
}

function normalizeScript(script) {
  return {
    id: String(script.id || uid('s')),
    name: String(script.name || 'Script'),
    code: String(script.code ?? ''),
    runAt: RUN_ATS.includes(script.runAt) ? script.runAt : 'documentIdle',
    world: WORLDS.includes(script.world) ? script.world : 'MAIN',
    enabled: script.enabled !== false,
  };
}

/** Structural validation of a rule. Returns array of error strings (empty = valid). */
export function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return ['Rule is not an object'];
  if (!String(rule.name || '').trim()) errors.push('Rule name is required');
  const match = rule.match || {};
  if (!MATCH_TYPES.includes(match.type)) errors.push(`Match type must be one of ${MATCH_TYPES.join(', ')}`);
  if (!String(match.value ?? '').trim()) {
    errors.push('Match value is required');
  } else if (match.type === 'domain') {
    if (!normalizeDomain(match.value)) errors.push(`Invalid base domain: ${match.value}`);
  } else if (match.type === 'regex') {
    const check = validateRegex(match.value, match.flags || '');
    if (!check.ok) errors.push(check.error);
  } else if (match.type === 'pattern') {
    for (const p of String(match.value).split(/[\n,]/).map((s) => s.trim()).filter(Boolean)) {
      const check = validatePattern(p);
      if (!check.ok) errors.push(check.error);
    }
  }
  if (!Array.isArray(rule.scripts) || rule.scripts.length === 0) {
    errors.push('At least one script is required');
  } else {
    for (const [i, s] of rule.scripts.entries()) {
      const label = s?.name || `script #${i + 1}`;
      if (!String(s?.name || '').trim()) errors.push(`${label}: name is required`);
      if (typeof s?.code !== 'string' || !s.code.trim()) errors.push(`${label}: code is required`);
      else {
        try {
          // Best-effort syntax check by compiling as a function body. On
          // extension pages MV3 CSP may block this entirely — treat a CSP
          // error as "cannot verify" rather than rejecting valid code.
          // eslint-disable-next-line no-new-func
          new Function(s.code);
        } catch (e) {
          if (!/Content Security Policy/i.test(String(e?.message))) {
            errors.push(`${label}: invalid JavaScript: ${e.message}`);
          }
        }
      }
      if (s && !RUN_ATS.includes(s.runAt)) errors.push(`${label}: invalid runAt`);
      if (s && !WORLDS.includes(s.world)) errors.push(`${label}: invalid world`);
    }
  }
  return errors;
}

export function exportJson(data) {
  return JSON.stringify(data, null, 2);
}

/**
 * Parse and validate an imported JSON document. Throws Error with a readable
 * message on anything malformed. Returns normalized data.
 */
export function importJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  if (parsed.version !== undefined && parsed.version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${parsed.version} (expected ${SCHEMA_VERSION})`);
  }
  if (parsed.rules !== undefined && !Array.isArray(parsed.rules)) {
    throw new Error('"rules" must be an array');
  }
  const ruleErrors = [];
  for (const [i, rule] of (parsed.rules || []).entries()) {
    for (const err of validateRule(rule)) ruleErrors.push(`Rule #${i + 1} (${rule?.name || 'unnamed'}): ${err}`);
  }
  if (ruleErrors.length) {
    throw new Error(`Import rejected — ${ruleErrors.length} problem(s):\n- ${ruleErrors.join('\n- ')}`);
  }
  return normalizeData(parsed);
}

export function onChanged(chrome, cb) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) cb(normalizeData(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
