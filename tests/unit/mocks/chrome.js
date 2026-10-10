// In-memory fake of the chrome.* surfaces the extension uses.
// apiVersion: 1 = old userScripts API (getRegisteredScripts, DOCUMENT_* enums),
//             2 = Chrome 135+ redesign (getScripts, snake_case runAt).

export function createChromeMock({ userScriptsUnavailable = false, apiVersion = 1 } = {}) {
  const storageData = new Map();
  const changeListeners = new Set();
  const registered = new Map();
  const calls = { register: [], unregister: [], configureWorld: 0 };

  const snakeRunAt = (v) => ({ DOCUMENT_START: 'document_start', DOCUMENT_END: 'document_end', DOCUMENT_IDLE: 'document_idle' }[v] || v);
  const enumRunAt = (v) => ({ document_start: 'DOCUMENT_START', document_end: 'DOCUMENT_END', document_idle: 'DOCUMENT_IDLE' }[v] || v);

  const unavailableError = () => new Error(
    apiVersion === 2 ? 'userScripts API is not available' : 'Extension must be enabled in Developer Mode to use the userScripts API.',
  );

  const userScripts = {
    ...(apiVersion === 1
      ? {
          async getRegisteredScripts() {
            if (userScriptsUnavailable) throw unavailableError();
            return structuredClone([...registered.values()].map((d) => ({ ...d, runAt: enumRunAt(d.runAt), persistAcrossSessions: true })));
          },
        }
      : {
          async getScripts() {
            if (userScriptsUnavailable) throw unavailableError();
            return structuredClone([...registered.values()].map((d) => ({ ...d, runAt: snakeRunAt(d.runAt) })));
          },
        }),
    async register(defs) {
      calls.register.push(structuredClone(defs));
      for (const def of defs) {
        if (registered.has(def.id)) {
          throw new Error(`Duplicate script id: ${def.id}`);
        }
        registered.set(def.id, structuredClone(def));
      }
    },
    async unregister({ ids }) {
      calls.unregister.push([...ids]);
      for (const id of ids) registered.delete(id);
    },
    async configureWorld(opts) {
      calls.configureWorld++;
      userScripts.lastWorldConfig = opts;
    },
  };

  const storage = {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) {
          return Object.fromEntries(storageData);
        }
        const out = {};
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        for (const k of list) out[k] = storageData.has(k) ? structuredClone(storageData.get(k)) : structuredClone(keys?.[k] ?? undefined);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: storageData.has(k) ? structuredClone(storageData.get(k)) : undefined, newValue: structuredClone(v) };
          storageData.set(k, structuredClone(v));
        }
        for (const fn of changeListeners) fn(changes, 'local');
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) storageData.delete(k);
      },
    },
    onChanged: {
      addListener(fn) { changeListeners.add(fn); },
      removeListener(fn) { changeListeners.delete(fn); },
    },
  };

  const messageListeners = new Set();
  const sent = [];
  const runtime = {
    onMessage: { addListener: (fn) => messageListeners.add(fn) },
    sendMessage: (msg) => {
      sent.push(structuredClone(msg));
      if (msg?.type === 'jsi:probe') {
        return Promise.resolve(userScriptsUnavailable
          ? { ok: false, error: 'userScripts API is not available' }
          : { ok: true });
      }
      let reply;
      for (const fn of messageListeners) {
        const r = fn(msg, {}, (x) => (reply = x));
        if (r === true) continue; // async; caller resolves via callback — tests use background directly
      }
      return Promise.resolve(reply ?? { ok: true });
    },
  };

  return {
    userScripts,
    storage,
    runtime,
    __registered: registered,
    __calls: calls,
    __storageData: storageData,
    __sent: sent,
    setUserScriptsUnavailable(v) { userScriptsUnavailable = v; },
  };
}
