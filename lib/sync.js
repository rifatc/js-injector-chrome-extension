// Registration sync engine: converts stored rules into chrome.userScripts
// registrations, diffing against what is currently registered so repeated
// syncs are idempotent and cheap.
//
// Chrome compatibility: the userScripts API shipped in Chrome 120 and was
// redesigned around Chrome 135+ (getScripts/getRegisteredScripts, runAt
// casing, persistAcrossSessions removal). The adapter below speaks both.

import { buildUserScripts } from './match.js';

const RUN_AT_NATIVE = {
  // canonical (old) -> v2 (snake_case)
  DOCUMENT_START: 'document_start',
  DOCUMENT_END: 'document_end',
  DOCUMENT_IDLE: 'document_idle',
};

/**
 * Detect and wrap the userScripts API flavor available on this Chrome.
 * Returns null when the namespace or its methods are missing (engine off
 * or API unavailable in this context).
 */
export function getUserScriptsApi(chrome) {
  const u = chrome?.userScripts;
  if (!u) return null;
  if (typeof u.getScripts === 'function') {
    return {
      version: 2,
      async getAll() {
        return u.getScripts();
      },
      register(defs) {
        return u.register(defs);
      },
      unregister(ids) {
        return u.unregister({ ids });
      },
      toNative(def) {
        const native = { ...def, runAt: RUN_AT_NATIVE[def.runAt] || def.runAt };
        delete native.persistAcrossSessions;
        return native;
      },
    };
  }
  if (typeof u.getRegisteredScripts === 'function') {
    return {
      version: 1,
      getAll() {
        return u.getRegisteredScripts();
      },
      register(defs) {
        return u.register(defs);
      },
      unregister(ids) {
        return u.unregister({ ids });
      },
      toNative(def) {
        return def;
      },
    };
  }
  return null;
}

/** Fields that define a registered script's identity for diffing. */
export function scriptSignature(def) {
  return JSON.stringify({
    id: def.id,
    matches: [...(def.matches || [])].sort(),
    code: def.js?.[0]?.code ?? '',
    runAt: def.runAt,
    world: def.world,
    allFrames: Boolean(def.allFrames),
  });
}

/**
 * Pure diff: given currently-registered and desired script definitions (in
 * the same API-native shape), return what must be unregistered/registered.
 * Signature: { toUnregister: string[], toRegister: object[] }.
 */
export function diffRegistrations(current, desired) {
  const currentById = new Map(current.map((d) => [d.id, d]));
  const desiredById = new Map(desired.map((d) => [d.id, d]));
  const toUnregister = [];
  const toRegister = [];
  for (const [id, def] of currentById) {
    if (!desiredById.has(id)) toUnregister.push(id);
  }
  for (const [id, def] of desiredById) {
    const cur = currentById.get(id);
    if (!cur) toRegister.push(def);
    else if (scriptSignature(cur) !== scriptSignature(def)) {
      // Same id with different content: unregister first, then re-register.
      toUnregister.push(id);
      toRegister.push(def);
    }
  }
  return { toUnregister, toRegister };
}

/** All desired registrations for a data object (respects global + rule + script toggles). */
export function desiredRegistrations(data) {
  if (!data?.settings?.globalEnabled || !Array.isArray(data.rules)) return [];
  return data.rules.flatMap((rule) => buildUserScripts(rule));
}

/** Probe the userScripts API. { ok: true } or { ok: false, error }. */
export async function probeAvailability(chrome) {
  const api = getUserScriptsApi(chrome);
  if (!api) {
    return { ok: false, error: 'chrome.userScripts API is not available (engine off, or Chrome < 120)' };
  }
  try {
    await api.getAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Bring registered user scripts in line with `data`.
 * Returns { ok, reason?, registered, unregistered, error?, total, apiVersion? }.
 * reason is 'unavailable' when the userScripts engine is not enabled yet.
 */
export async function sync(chrome, data) {
  const desiredCanonical = desiredRegistrations(data);
  const api = getUserScriptsApi(chrome);
  if (!api) {
    return {
      ok: false, reason: 'unavailable',
      error: 'userScripts API is not available. Enable "Allow user scripts" for this extension in chrome://extensions.',
      registered: 0, unregistered: 0, total: desiredCanonical.length,
    };
  }
  let current;
  try {
    current = await api.getAll();
  } catch (e) {
    // Engine off: Chrome throws until the user enables user scripts.
    return {
      ok: false, reason: 'unavailable',
      error: String(e?.message || e),
      registered: 0, unregistered: 0, total: desiredCanonical.length,
    };
  }
  try {
    const desired = desiredCanonical.map((d) => api.toNative(d));
    const { toUnregister, toRegister } = diffRegistrations(current, desired);
    if (toUnregister.length) await api.unregister(toUnregister);
    if (toRegister.length) await api.register(toRegister);
    return {
      ok: true,
      apiVersion: api.version,
      registered: toRegister.length,
      unregistered: toUnregister.length,
      total: desired.length,
      at: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, reason: 'error', error: String(e?.message || e), registered: 0, unregistered: 0, total: desiredCanonical.length };
  }
}

// Best-effort world configuration: allow messaging from USER_SCRIPT world and
// relax its CSP so user code may use eval(). MAIN-world scripts are exempt
// from page CSP by design of the userScripts API.
export async function configureWorld(chrome) {
  if (!chrome?.userScripts?.configureWorld) return;
  const attempts = [
    { messaging: true, csp: "script-src 'self' 'unsafe-eval'; object-src 'self'" },
    { messaging: true }, // older Chrome without the csp option
  ];
  for (const opts of attempts) {
    try {
      await chrome.userScripts.configureWorld(opts);
      return;
    } catch {
      // try next shape
    }
  }
}
