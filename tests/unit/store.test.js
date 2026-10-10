import { describe, it, expect } from 'vitest';
import {
  defaultData, load, save, normalizeData, validateRule, importJson, exportJson, newRule, newScript, KEY,
} from '../../lib/store.js';
import { createChromeMock } from './mocks/chrome.js';

const validRule = () => ({
  id: 'r1',
  name: 'Example',
  enabled: true,
  allFrames: false,
  match: { type: 'domain', value: 'example.com', flags: '' },
  scripts: [{ id: 's1', name: 'a', code: 'console.log(1)', runAt: 'documentIdle', world: 'MAIN', enabled: true }],
});

describe('load / save', () => {
  it('returns defaults when storage is empty', async () => {
    const chrome = createChromeMock();
    expect(await load(chrome)).toEqual(defaultData());
  });
  it('round-trips data', async () => {
    const chrome = createChromeMock();
    const data = defaultData();
    data.rules.push(validRule());
    await save(chrome, data);
    expect(await load(chrome)).toEqual(data);
  });
});

describe('normalizeData', () => {
  it('fills defaults for partial input', () => {
    const out = normalizeData({ rules: [{ id: 'x', name: 'n', match: { type: 'domain', value: 'a.com' } }] });
    expect(out.settings.globalEnabled).toBe(true);
    expect(out.rules[0]).toMatchObject({ enabled: true, allFrames: false });
    expect(out.rules[0].scripts).toEqual([]);
    expect(out.rules[0].match).toEqual({ type: 'domain', value: 'a.com', flags: '' });
  });
  it('drops non-object rules/scripts', () => {
    const out = normalizeData({ rules: [null, 5, validRule()] });
    expect(out.rules).toHaveLength(1);
  });
});

describe('validateRule', () => {
  it('accepts a valid rule', () => expect(validateRule(validRule())).toEqual([]));

  it('flags missing name and value', () => {
    const errors = validateRule({ ...validRule(), name: ' ', match: { type: 'domain', value: '' } });
    expect(errors).toContain('Rule name is required');
    expect(errors).toContain('Match value is required');
  });

  it('flags invalid domain, regex, pattern values', () => {
    expect(validateRule({ ...validRule(), match: { type: 'domain', value: 'not a domain' } })[0]).toMatch(/Invalid base domain/);
    expect(validateRule({ ...validRule(), match: { type: 'regex', value: '(' } })[0]).toMatch(/Invalid regex/);
    expect(validateRule({ ...validRule(), match: { type: 'pattern', value: 'example.com' } })[0]).toMatch(/Expected/);
  });

  it('requires at least one script and flags JS syntax errors', () => {
    expect(validateRule({ ...validRule(), scripts: [] })[0]).toMatch(/At least one script/);
    const bad = validRule();
    bad.scripts[0].code = 'function { nope';
    expect(validateRule(bad).join(' ')).toMatch(/invalid JavaScript/);
  });

  it('flags invalid runAt/world', () => {
    const r = validRule();
    r.scripts[0].runAt = 'whenever';
    expect(validateRule(r)[0]).toMatch(/runAt/);
  });
});

describe('import / export', () => {
  it('round-trips through JSON', () => {
    const data = defaultData();
    data.rules.push(validRule());
    expect(importJson(exportJson(data))).toEqual(data);
  });

  it('rejects non-JSON and non-object payloads', () => {
    expect(() => importJson('{nope')).toThrow(/Not valid JSON/);
    expect(() => importJson('[1,2]')).toThrow(/Expected a JSON object/);
  });

  it('rejects unknown schema versions', () => {
    expect(() => importJson(JSON.stringify({ version: 99, rules: [] }))).toThrow(/Unsupported schema version/);
  });

  it('rejects rules that fail validation, listing them', () => {
    const payload = JSON.stringify({ version: 1, rules: [validRule(), { ...validRule(), name: 'bad regex', match: { type: 'regex', value: '(' } }] });
    expect(() => importJson(payload)).toThrow(/bad regex[\s\S]*Invalid regex/);
  });

  it('imports a minimal valid document and normalizes it', () => {
    const out = importJson(JSON.stringify({ version: 1, rules: [validRule()] }));
    expect(out.rules[0].enabled).toBe(true);
    expect(out.settings.globalEnabled).toBe(true);
  });
});

describe('factories', () => {
  it('newRule/newScript create unique ids', () => {
    const a = newRule();
    const b = newRule();
    expect(a.id).not.toBe(b.id);
    expect(a.scripts).toHaveLength(1);
    expect(newScript().id).toMatch(/^s_/);
  });
});

describe('mock chrome storage wiring', () => {
  it('change events fire for the data key', async () => {
    const chrome = createChromeMock();
    const events = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (changes[KEY]) events.push(area);
    });
    await save(chrome, defaultData());
    expect(events).toEqual(['local']);
  });
});
