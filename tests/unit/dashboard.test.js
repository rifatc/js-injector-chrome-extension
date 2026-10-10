// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import html from '../../dashboard/dashboard.html?raw';
import { initDashboard } from '../../dashboard/dashboard.js';
import { load, KEY } from '../../lib/store.js';
import { createChromeMock } from './mocks/chrome.js';

async function boot(seed) {
  document.documentElement.innerHTML = html.replace('<link rel="stylesheet" href="dashboard.css">', '');
  const chrome = createChromeMock();
  if (seed) await chrome.storage.local.set({ [KEY]: seed });
  const api = await initDashboard({
    chrome,
    document,
    location: { href: 'chrome-extension://abc/dashboard/dashboard.html' },
    confirm: () => true,
  });
  return { chrome, api };
}

const seedRule = {
  id: 'r1',
  name: 'GitHub tweaks',
  enabled: true,
  allFrames: false,
  match: { type: 'domain', value: 'github.com', flags: '' },
  scripts: [
    { id: 's1', name: 'dark nav', code: 'document.body.style.background = "#000"', runAt: 'documentIdle', world: 'MAIN', enabled: true },
    { id: 's2', name: 'off', code: 'console.log(1)', runAt: 'documentIdle', world: 'MAIN', enabled: false },
  ],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('dashboard', () => {
  it('renders rules from storage with chips and counts', async () => {
    await boot({ version: 1, settings: { globalEnabled: true }, rules: [seedRule] });
    const card = document.querySelector('.rule-card');
    expect(card).toBeTruthy();
    expect(card.querySelector('.rule-name').textContent).toBe('GitHub tweaks');
    const chips = [...card.querySelectorAll('.chip')].map((c) => c.textContent);
    expect(chips).toContain('domain: github.com');
    expect(chips).toContain('1/2 scripts');
    expect(document.getElementById('empty-state').hidden).toBe(true);
  });

  it('shows the empty state when there are no rules', async () => {
    await boot(null);
    expect(document.getElementById('empty-state').hidden).toBe(false);
    expect(document.querySelectorAll('.rule-card').length).toBe(0);
  });

  it('persists the global kill switch', async () => {
    const { chrome } = await boot({ version: 1, settings: { globalEnabled: true }, rules: [seedRule] });
    const t = document.getElementById('global-toggle');
    t.checked = false;
    t.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => {
      expect((await load(chrome)).settings.globalEnabled).toBe(false);
    });
  });

  it('creates a rule end-to-end through the editor', async () => {
    const { chrome } = await boot(null);
    document.getElementById('btn-new').click();
    const editor = document.getElementById('editor');
    expect(editor.hidden).toBe(false);

    const nameIn = editor.querySelector('input[type="text"]');
    nameIn.value = 'Local demo';
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));

    const valueIn = [...editor.querySelectorAll('input[type="text"]')].find((i) => i !== nameIn);
    valueIn.value = '127.0.0.1';
    valueIn.dispatchEvent(new Event('input', { bubbles: true }));

    const code = editor.querySelector('textarea.code');
    code.value = 'window.__demo = 1;';
    code.dispatchEvent(new Event('input', { bubbles: true }));

    const save = [...editor.querySelectorAll('button')].find((b) => b.textContent === 'Create rule');
    save.click();
    await flush();

    const data = await load(chrome);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].name).toBe('Local demo');
    expect(data.rules[0].match).toEqual({ type: 'domain', value: '127.0.0.1', flags: '' });
    expect(data.rules[0].scripts[0].code).toBe('window.__demo = 1;');
    expect(chrome.__sent.at(-1)).toEqual({ type: 'jsi:sync' });
    expect(document.querySelector('.rule-card .rule-name').textContent).toBe('Local demo');
    expect(editor.hidden).toBe(true);
  });

  it('rejects a save with an invalid regex and keeps the editor open', async () => {
    const { chrome } = await boot(null);
    document.getElementById('btn-new').click();
    const editor = document.getElementById('editor');

    const typeSel = editor.querySelector('select');
    typeSel.value = 'regex';
    typeSel.dispatchEvent(new Event('change'));

    const nameIn = editor.querySelector('input[type="text"]');
    nameIn.value = 'Bad';
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));
    const valueIn = [...editor.querySelectorAll('input[type="text"]')].filter((i) => i !== nameIn)[0];
    valueIn.value = '(';
    valueIn.dispatchEvent(new Event('input', { bubbles: true }));
    const code = editor.querySelector('textarea.code');
    code.value = 'x()';
    code.dispatchEvent(new Event('input', { bubbles: true }));

    const save = [...editor.querySelectorAll('button')].find((b) => b.textContent === 'Create rule');
    save.click();
    await flush();

    const errors = editor.querySelector('.editor-errors');
    expect(errors.hidden).toBe(false);
    expect(errors.textContent).toMatch(/Invalid regex/);
    expect((await load(chrome)).rules).toHaveLength(0);
    expect(editor.hidden).toBe(false);
  });

  it('runs the match tester against sample URLs', async () => {
    await boot(null);
    document.getElementById('btn-new').click();
    const editor = document.getElementById('editor');
    const nameIn = editor.querySelector('input[type="text"]');
    nameIn.value = 'T';
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));
    const valueIn = [...editor.querySelectorAll('input[type="text"]')].filter((i) => i !== nameIn)[0];
    valueIn.value = 'example.com';
    valueIn.dispatchEvent(new Event('input', { bubbles: true }));

    const testerIn = editor.querySelector('.tester textarea');
    testerIn.value = 'https://example.com/x\nhttps://other.com/';
    testerIn.dispatchEvent(new Event('input', { bubbles: true }));

    const rows = [...editor.querySelectorAll('.tester-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain('match-yes');
    expect(rows[1].className).toContain('match-no');
  });

  it('toggles and deletes rules from cards', async () => {
    const { chrome } = await boot({ version: 1, settings: { globalEnabled: true }, rules: [seedRule] });
    const card = document.querySelector('.rule-card');
    const toggle = card.querySelector('input.switch-input');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => {
      expect((await load(chrome)).rules[0].enabled).toBe(false);
    });

    const del = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Delete');
    del.click();
    await flush();
    expect((await load(chrome)).rules).toHaveLength(0);
    expect(document.getElementById('empty-state').hidden).toBe(false);
  });

  it('warns when the userScripts engine is unavailable', async () => {
    const chrome = createChromeMock({ userScriptsUnavailable: true });
    document.documentElement.innerHTML = html;
    await initDashboard({ chrome, document, location: { href: 'x://y/' }, confirm: () => true });
    await vi.waitFor(() => {
      expect(document.getElementById('status-pill').textContent).toBe('engine off');
    });
    expect(document.getElementById('banner').hidden).toBe(false);
    expect(document.getElementById('banner').textContent).toMatch(/Developer Mode/);
  });
});
