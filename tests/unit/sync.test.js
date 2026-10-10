import { describe, it, expect } from 'vitest';
import { diffRegistrations, scriptSignature, desiredRegistrations, probeAvailability, sync, getUserScriptsApi } from '../../lib/sync.js';
import { createChromeMock } from './mocks/chrome.js';

const rule = (over = {}) => ({
  id: 'r1',
  name: 'Rule',
  enabled: true,
  allFrames: false,
  match: { type: 'domain', value: 'example.com', flags: '' },
  scripts: [{ id: 's1', name: 'a', code: 'window.__a=1;', runAt: 'documentIdle', world: 'MAIN', enabled: true }],
  ...over,
});

const data = (over = {}) => ({
  version: 1,
  settings: { globalEnabled: true },
  rules: [rule()],
  ...over,
});

const defOf = (d) => desiredRegistrations(d)[0];

describe('scriptSignature / diffRegistrations', () => {
  it('produces no ops for identical sets', () => {
    const def = defOf(data());
    const cur = structuredClone([def]);
    expect(diffRegistrations(cur, [def])).toEqual({ toUnregister: [], toRegister: [] });
  });

  it('detects new, removed and changed scripts', () => {
    const a = { id: 'A', matches: ['*://a/*'], js: [{ code: '1' }], runAt: 'DOCUMENT_IDLE', world: 'MAIN' };
    const aChanged = { ...a, js: [{ code: '2' }] };
    const b = { id: 'B', matches: ['*://b/*'], js: [{ code: '3' }], runAt: 'DOCUMENT_IDLE', world: 'MAIN' };
    const { toUnregister, toRegister } = diffRegistrations([a], [aChanged, b]);
    expect(toUnregister).toEqual(['A']);
    expect(toRegister.map((d) => d.id)).toEqual(['A', 'B']);
  });

  it('is insensitive to match order but sensitive to world/runAt/allFrames', () => {
    const base = { id: 'A', matches: ['*://a/*', '*://b/*'], js: [{ code: '1' }], runAt: 'DOCUMENT_IDLE', world: 'MAIN', allFrames: false };
    const reordered = { ...base, matches: ['*://b/*', '*://a/*'] };
    expect(scriptSignature(base)).toBe(scriptSignature(reordered));
    for (const variant of [
      { ...base, world: 'USER_SCRIPT' },
      { ...base, runAt: 'DOCUMENT_START' },
      { ...base, allFrames: true },
      { ...base, matches: ['*://a/*'] },
    ]) {
      expect(scriptSignature(base)).not.toBe(scriptSignature(variant));
    }
  });
});

describe('desiredRegistrations', () => {
  it('respects the global kill switch', () => {
    expect(desiredRegistrations(data({ settings: { globalEnabled: false } }))).toEqual([]);
  });
  it('respects rule and script toggles', () => {
    expect(desiredRegistrations(data({ rules: [rule({ enabled: false })] }))).toEqual([]);
    const d = data({ rules: [rule({ scripts: [{ id: 's1', name: 'a', code: 'x', runAt: 'documentIdle', world: 'MAIN', enabled: false }] })] });
    expect(desiredRegistrations(d)).toEqual([]);
  });
});

describe('probeAvailability', () => {
  it('reports ok when the API works', async () => {
    const chrome = createChromeMock();
    expect((await probeAvailability(chrome)).ok).toBe(true);
  });
  it('reports unavailable when the API throws (userScripts disabled)', async () => {
    const chrome = createChromeMock({ userScriptsUnavailable: true });
    const res = await probeAvailability(chrome);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Developer Mode/i);
  });
});

describe('sync', () => {
  it('registers desired scripts on first run and is idempotent', async () => {
    const chrome = createChromeMock();
    const first = await sync(chrome, data());
    expect(first).toMatchObject({ ok: true, registered: 1, unregistered: 0, total: 1 });
    expect(chrome.__registered.size).toBe(1);
    const second = await sync(chrome, data());
    expect(second).toMatchObject({ ok: true, registered: 0, unregistered: 0, total: 1 });
    expect(chrome.__calls.register).toHaveLength(1);
  });

  it('re-registers changed code', async () => {
    const chrome = createChromeMock();
    await sync(chrome, data());
    const changed = data();
    changed.rules[0].scripts[0].code = 'window.__a=2;';
    const res = await sync(chrome, changed);
    expect(res).toMatchObject({ ok: true, registered: 1, unregistered: 1 });
    const def = [...chrome.__registered.values()][0];
    expect(def.js[0].code).toContain('window.__a=2;');
  });

  it('unregisters everything when the global switch turns off', async () => {
    const chrome = createChromeMock();
    await sync(chrome, data());
    const res = await sync(chrome, data({ settings: { globalEnabled: false } }));
    expect(res).toMatchObject({ ok: true, registered: 0, unregistered: 1 });
    expect(chrome.__registered.size).toBe(0);
  });

  it('returns reason unavailable without touching anything when API is disabled', async () => {
    const chrome = createChromeMock({ userScriptsUnavailable: true });
    const res = await sync(chrome, data());
    expect(res).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(chrome.__calls.register).toHaveLength(0);
  });

  it('surfaces registration errors as reason error', async () => {
    const chrome = createChromeMock();
    chrome.userScripts.register = async () => { throw new Error('Invalid match pattern'); };
    const res = await sync(chrome, data());
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    expect(res.error).toMatch(/Invalid match pattern/);
  });
});

describe('Chrome 135+ API flavor (v2)', () => {
  it('detects the API version', () => {
    expect(getUserScriptsApi(createChromeMock({ apiVersion: 1 })).version).toBe(1);
    expect(getUserScriptsApi(createChromeMock({ apiVersion: 2 })).version).toBe(2);
    expect(getUserScriptsApi({ userScripts: {} })).toBeNull();
    expect(getUserScriptsApi({})).toBeNull();
  });

  it('converts canonical defs to the native snake_case shape and is idempotent', async () => {
    const chrome = createChromeMock({ apiVersion: 2 });
    const first = await sync(chrome, data());
    expect(first).toMatchObject({ ok: true, registered: 1, apiVersion: 2 });
    const def = [...chrome.__registered.values()][0];
    expect(def.runAt).toBe('document_idle');
    expect(def).not.toHaveProperty('persistAcrossSessions');
    expect(def.matches).toEqual(['*://example.com/*', '*://*.example.com/*']);
    const second = await sync(chrome, data());
    expect(second).toMatchObject({ ok: true, registered: 0, unregistered: 0 });
  });

  it('re-registers changed scripts under v2 too', async () => {
    const chrome = createChromeMock({ apiVersion: 2 });
    await sync(chrome, data());
    const changed = data();
    changed.rules[0].scripts[0].runAt = 'documentStart';
    const res = await sync(chrome, changed);
    expect(res).toMatchObject({ ok: true, registered: 1, unregistered: 1 });
    expect([...chrome.__registered.values()][0].runAt).toBe('document_start');
  });

  it('reports unavailable when the engine is off (v2 throws on getScripts)', async () => {
    const chrome = createChromeMock({ apiVersion: 2, userScriptsUnavailable: true });
    const res = await sync(chrome, data());
    expect(res).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
