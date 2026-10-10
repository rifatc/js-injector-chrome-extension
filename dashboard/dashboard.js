// Dashboard controller. initDashboard(env) is exported for tests; in the
// browser the module self-initializes against the real chrome/document.

import { load, save, validateRule, importJson, exportJson, newRule, newScript } from '../lib/store.js';
import { uid } from '../lib/match.js';
import { testUrls } from './tester.js';

/**
 * The userScripts API only binds in the service worker, so extension pages
 * must ask the background to probe it.
 */
async function probeEngine(chrome) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'jsi:probe' });
    if (res && typeof res.ok === 'boolean') return res;
  } catch { /* SW unavailable */ }
  return { ok: false, error: 'background service worker did not respond' };
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = v;
    else if (k === 'disabled') node.disabled = v;
    else if (k === 'hidden') node.hidden = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function switchEl({ checked, title, onchange, ariaLabel }) {
  const input = el('input', { type: 'checkbox', class: 'switch-input', checked });
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('change', () => onchange(input.checked));
  const wrap = el('label', { class: 'global-switch', title: title || '' }, [
    input,
    el('span', { class: 'switch-track' }, [el('span', { class: 'switch-knob' })]),
  ]);
  return wrap;
}

const MATCH_HINTS = {
  domain: 'Base domain, e.g. example.com — matches example.com and all subdomains, any port.',
  regex: 'JavaScript regex tested against the full URL (location.href), e.g. ^https://[^/]+/docs/',
  pattern: 'Chrome match patterns, one per line, e.g. *://example.com/* (advanced)',
};

export async function initDashboard(env = {}) {
  const chrome = env.chrome || globalThis.chrome;
  const doc = env.document || globalThis.document;
  const loc = env.location || globalThis.location;
  const confirmFn = env.confirm || ((msg) => globalThis.confirm(msg));

  const $ = (id) => doc.getElementById(id);
  const ui = {
    pill: $('status-pill'), banner: $('banner'),
    globalToggle: $('global-toggle'),
    btnNew: $('btn-new'), btnNewEmpty: $('btn-new-empty'),
    btnExport: $('btn-export'), btnImport: $('btn-import'), importFile: $('import-file'),
    editor: $('editor'), rulesList: $('rules-list'), rulesCount: $('rules-count'),
    emptyState: $('empty-state'), toast: $('toast'),
  };

  const state = { data: await load(chrome), editing: null, editingIndex: -1 };
  let toastTimer = null;

  function toast(message, isError = false) {
    ui.toast.textContent = message;
    ui.toast.classList.toggle('toast-error', isError);
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, isError ? 6000 : 2500);
  }

  const requestSync = () => chrome.runtime.sendMessage({ type: 'jsi:sync' }).catch(() => {});

  async function persist() {
    await save(chrome, state.data);
    await requestSync();
  }

  // ---------- status ----------
  async function renderStatus() {
    const res = await probeEngine(chrome);
    if (res.ok) {
      ui.pill.textContent = 'engine ready';
      ui.pill.className = 'pill pill-ok';
      ui.banner.hidden = true;
    } else {
      ui.pill.textContent = 'engine off';
      ui.pill.className = 'pill pill-off';
      ui.banner.hidden = false;
      ui.banner.replaceChildren(
        el('strong', { text: 'Scripts are not running: ' }),
        'the userScripts engine is not enabled for this extension. One-time fix: open ',
        el('code', { text: 'chrome://extensions' }),
        ' → enable ',
        el('strong', { text: 'Developer Mode' }),
        ' (top right) — or, on newer Chrome, open this extension\u2019s ',
        el('strong', { text: 'Details' }),
        ' and turn on ',
        el('strong', { text: 'Allow user scripts' }),
        ' — then reload this page.',
        el('div', { class: 'muted', style: 'margin-top:.4rem;font-size:.78rem' }, [String(res.error)]),
      );
    }
  }

  // ---------- rules list ----------
  function matchChipText(rule) {
    if (rule.match.type === 'regex') return `regex: /${rule.match.value}/${rule.match.flags || ''}`;
    if (rule.match.type === 'pattern') {
      const count = rule.match.value.split(/[\n,]/).filter((s) => s.trim()).length;
      return `pattern: ${count} pattern${count === 1 ? '' : 's'}`;
    }
    return `domain: ${rule.match.value}`;
  }

  function renderRules() {
    ui.rulesList.replaceChildren();
    const rules = state.data.rules;
    ui.rulesCount.textContent = rules.length ? `(${rules.length})` : '';
    ui.emptyState.hidden = rules.length > 0 || !!state.editing;

    for (const rule of rules) {
      const active = rule.scripts.filter((s) => s.enabled).length;
      const card = el('div', { class: 'rule-card' + (rule.enabled ? '' : ' disabled') });
      card.append(
        switchEl({
          checked: rule.enabled,
          ariaLabel: `Toggle ${rule.name}`,
          onchange: async (v) => {
            rule.enabled = v;
            await persist();
            renderRules();
          },
        }),
      );
      const main = el('div', { class: 'rule-main' }, [
        el('div', { class: 'rule-name', text: rule.name }),
        el('div', { class: 'rule-meta' }, [
          el('span', { class: 'chip chip-type', text: matchChipText(rule) }),
          el('span', { class: 'chip', text: `${active}/${rule.scripts.length} scripts` }),
          ...(rule.allFrames ? [el('span', { class: 'chip', text: 'iframes' })] : []),
        ]),
      ]);
      card.append(main);
      const actions = el('div', { class: 'rule-actions' }, [
        el('button', {
          class: 'btn btn-sm', text: 'Edit',
          onclick: () => {
            state.editing = structuredClone(rule);
            state.editingIndex = state.data.rules.indexOf(rule);
            renderEditor();
          },
        }),
        el('button', {
          class: 'btn btn-sm', text: 'Duplicate',
          onclick: async () => {
            const copy = structuredClone(rule);
            copy.id = uid('r');
            copy.name = `${rule.name} (copy)`;
            for (const s of copy.scripts) s.id = uid('s');
            state.data.rules.push(copy);
            await persist();
            renderRules();
            toast('Rule duplicated');
          },
        }),
        el('button', {
          class: 'btn btn-sm btn-danger', text: 'Delete',
          onclick: async () => {
            if (!confirmFn(`Delete rule "${rule.name}"?`)) return;
            state.data.rules = state.data.rules.filter((r) => r !== rule);
            await persist();
            renderRules();
            toast('Rule deleted');
          },
        }),
      ]);
      card.append(actions);
      ui.rulesList.append(card);
    }
  }

  // ---------- editor ----------
  function closeEditor() {
    state.editing = null;
    state.editingIndex = -1;
    ui.editor.hidden = true;
    ui.editor.replaceChildren();
    renderRules();
  }

  function bindInput(node, obj, key, transform = (v) => v) {
    node.addEventListener('input', () => { obj[key] = transform(node.value); });
    node.addEventListener('change', () => { obj[key] = transform(node.value); });
  }

  function renderScriptBlock(script, idx) {
    const block = el('div', { class: 'script-block' + (script.enabled ? '' : ' disabled') });

    const nameIn = el('input', { type: 'text', value: script.name, placeholder: 'Script name' });
    bindInput(nameIn, script, 'name');

    const runAtSel = el('select', { title: 'When to run' },
      [['documentStart', 'document_start'], ['documentEnd', 'document_end'], ['documentIdle', 'document_idle (default)']].map(
        ([v, label]) => el('option', { value: v, text: label, selected: script.runAt === v ? '' : undefined }),
      ));
    runAtSel.value = script.runAt;
    bindInput(runAtSel, script, 'runAt');

    const worldSel = el('select', { title: 'Execution world' },
      [['MAIN', 'MAIN world (page)'], ['USER_SCRIPT', 'isolated world']].map(
        ([v, label]) => el('option', { value: v, text: label }),
      ));
    worldSel.value = script.world;
    bindInput(worldSel, script, 'world');

    const enabledSwitch = switchEl({
      checked: script.enabled,
      ariaLabel: `Toggle ${script.name}`,
      onchange: (v) => {
        script.enabled = v;
        block.classList.toggle('disabled', !v);
      },
    });

    const code = el('textarea', { class: 'code', spellcheck: 'false', placeholder: '// JavaScript to inject — runs in the world selected above' });
    code.value = script.code;
    code.addEventListener('input', () => { script.code = code.value; });
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = code;
        code.value = code.value.slice(0, s) + '  ' + code.value.slice(en);
        code.selectionStart = code.selectionEnd = s + 2;
        script.code = code.value;
      }
    });

    const move = (delta) => () => {
      const scripts = state.editing.scripts;
      const j = idx + delta;
      if (j < 0 || j >= scripts.length) return;
      [scripts[idx], scripts[j]] = [scripts[j], scripts[idx]];
      renderEditor();
    };

    const head = el('div', { class: 'script-head' }, [
      el('div', { class: 'form-field' }, [el('label', { text: 'Name' }), nameIn]),
      el('div', { class: 'form-field' }, [el('label', { text: 'Run at' }), runAtSel]),
      el('div', { class: 'form-field' }, [el('label', { text: 'World' }), worldSel]),
      enabledSwitch,
      el('div', { class: 'script-actions' }, [
        el('button', { class: 'btn btn-sm btn-ghost', text: '↑', title: 'Move up', onclick: move(-1) }),
        el('button', { class: 'btn btn-sm btn-ghost', text: '↓', title: 'Move down', onclick: move(1) }),
        el('button', {
          class: 'btn btn-sm btn-danger', text: 'Remove',
          onclick: () => {
            if (state.editing.scripts.length <= 1) { toast('A rule needs at least one script', true); return; }
            state.editing.scripts.splice(idx, 1);
            renderEditor();
          },
        }),
      ]),
    ]);

    block.append(head, code);
    return block;
  }

  function renderEditor() {
    const rule = state.editing;
    if (!rule) return closeEditor();
    ui.editor.hidden = false;
    ui.emptyState.hidden = true;
    ui.editor.replaceChildren();

    const nameIn = el('input', { type: 'text', value: rule.name, placeholder: 'e.g. GitHub tweaks' });
    bindInput(nameIn, rule, 'name');

    const typeSel = el('select', {},
      [['domain', 'Base domain'], ['regex', 'Regex on full URL'], ['pattern', 'Match patterns (advanced)']].map(
        ([v, label]) => el('option', { value: v, text: label }),
      ));
    typeSel.value = rule.match.type;
    const valueIn = el('input', { type: 'text', value: rule.match.value, placeholder: rule.match.type === 'domain' ? 'example.com' : rule.match.type === 'regex' ? '^https://example\\.com/' : '*://example.com/*' });
    const flagsIn = el('input', { type: 'text', value: rule.match.flags || '', placeholder: 'flags, e.g. i' });
    flagsIn.style.width = '90px';
    const hint = el('div', { class: 'hint', text: MATCH_HINTS[rule.match.type] });
    const flagsField = el('div', { class: 'form-field' }, [el('label', { text: 'Regex flags' }), flagsIn]);
    const syncType = () => {
      rule.match.type = typeSel.value;
      flagsField.style.display = rule.match.type === 'regex' ? '' : 'none';
      hint.textContent = MATCH_HINTS[rule.match.type];
      valueIn.placeholder = rule.match.type === 'domain' ? 'example.com' : rule.match.type === 'regex' ? '^https://example\\.com/' : '*://example.com/*';
      if (rule.match.type === 'pattern') valueIn.setAttribute('rows', '2');
      else valueIn.removeAttribute('rows');
      renderTester();
    };
    typeSel.addEventListener('change', syncType);
    bindInput(valueIn, rule.match, 'value');
    bindInput(flagsIn, rule.match, 'flags');
    flagsField.style.display = rule.match.type === 'regex' ? '' : 'none';

    const allFrames = el('input', { type: 'checkbox', checked: rule.allFrames });
    allFrames.addEventListener('change', () => { rule.allFrames = allFrames.checked; });

    const errorsBox = el('div', { class: 'editor-errors', hidden: true });

    // ---- tester ----
    const testerBox = el('div', { class: 'tester' });
    function renderTester() {
      testerBox.replaceChildren(
        el('label', { class: 'muted', style: 'font-size:.78rem;text-transform:uppercase;letter-spacing:.05em', text: 'Test URLs (one per line)' }),
      );
      const urls = el('textarea', { placeholder: 'https://example.com/page\nhttps://other.com/' });
      const results = el('div', { class: 'tester-results' });
      const run = () => {
        results.replaceChildren();
        for (const r of testUrls(rule, urls.value)) {
          results.append(
            el('div', { class: 'tester-row ' + (r.matches ? 'match-yes' : 'match-no') }, [
              el('span', { class: 'mark', text: r.matches ? '✔' : '✘' }),
              el('code', { text: r.url }),
              r.error ? el('span', { class: 'err', text: `— ${r.error}` }) : null,
            ]),
          );
        }
      };
      urls.addEventListener('input', run);
      const btn = el('button', { class: 'btn btn-sm', text: 'Test', style: 'margin-top:.4rem', onclick: run });
      testerBox.append(el('div', { style: 'margin-top:.4rem' }, [urls, btn]), results);
    }
    renderTester();

    // ---- scripts ----
    const scriptsBox = el('div');
    const renderScripts = () => {
      scriptsBox.replaceChildren(...state.editing.scripts.map((s, i) => renderScriptBlock(s, i)));
    };
    renderScripts();

    const saveBtn = el('button', {
      class: 'btn btn-primary', text: state.editingIndex >= 0 ? 'Save changes' : 'Create rule',
      onclick: async () => {
        const errors = validateRule(rule);
        errorsBox.hidden = errors.length === 0;
        errorsBox.textContent = errors.join('\n');
        if (errors.length) return;
        if (state.editingIndex >= 0) state.data.rules[state.editingIndex] = rule;
        else state.data.rules.push(rule);
        await persist();
        closeEditor();
        renderRules();
        toast(`Saved — "${rule.name}" is live`);
      },
    });

    ui.editor.append(
      el('h2', { text: state.editingIndex >= 0 ? 'Edit rule' : 'New rule' }),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-field' }, [el('label', { text: 'Rule name' }), nameIn]),
        el('div', { class: 'form-field' }, [el('label', { text: 'Match type' }), typeSel]),
        el('div', { class: 'form-field', style: 'flex:1' }, [el('label', { text: rule.match.type === 'pattern' ? 'Patterns (one per line)' : 'Value' }), valueIn, hint]),
        flagsField,
        el('div', { class: 'form-field checkbox-field' }, [
          el('label', { class: 'muted', style: 'text-transform:none;letter-spacing:0', text: 'also run in iframes' }),
          allFrames,
        ]),
      ]),
      el('div', { class: 'scripts-head' }, [
        el('h2', { style: 'margin:0', text: 'Scripts' }),
        el('button', {
          class: 'btn btn-sm', text: '+ Add script',
          onclick: () => {
            state.editing.scripts.push(newScript({ name: `Script ${state.editing.scripts.length + 1}` }));
            renderScripts();
          },
        }),
      ]),
      scriptsBox,
      errorsBox,
      testerBox,
      el('div', { class: 'editor-actions' }, [
        saveBtn,
        el('button', { class: 'btn', text: 'Cancel', onclick: closeEditor }),
      ]),
    );
  }

  // ---------- import / export ----------
  function exportRules() {
    try {
      const blob = new Blob([exportJson(state.data)], { type: 'application/json' });
      const a = doc.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `js-injector-rules-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Export downloaded');
    } catch (e) {
      toast(`Export failed: ${e.message}`, true);
    }
  }

  async function importRules(file) {
    try {
      const text = await file.text();
      const imported = importJson(text);
      const okToReplace = confirmFn(
        `Import will REPLACE all current rules.\n\n` +
        `Current: ${state.data.rules.length} rule(s)\n` +
        `Imported: ${imported.rules.length} rule(s)\n\nContinue?`,
      );
      if (!okToReplace) return;
      state.data = imported;
      await persist();
      renderRules();
      toast(`Imported ${imported.rules.length} rule(s)`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------- wiring ----------
  ui.globalToggle.checked = state.data.settings.globalEnabled;
  ui.globalToggle.addEventListener('change', async () => {
    state.data.settings.globalEnabled = ui.globalToggle.checked;
    await persist();
    toast(ui.globalToggle.checked ? 'Injection enabled' : 'Injection disabled globally');
  });

  const startNew = () => {
    let prefill = null;
    try { prefill = new URL(loc.href).searchParams.get('domain'); } catch { /* ignore */ }
    state.editing = newRule(
      prefill
        ? { name: prefill, match: { type: 'domain', value: prefill, flags: '' } }
        : {},
    );
    state.editingIndex = -1;
    renderEditor();
    ui.editor.scrollIntoView({ behavior: 'smooth' });
  };

  ui.btnNew.addEventListener('click', startNew);
  ui.btnNewEmpty.addEventListener('click', startNew);
  ui.btnExport.addEventListener('click', exportRules);
  ui.btnImport.addEventListener('click', () => ui.importFile.click());
  ui.importFile.addEventListener('change', async () => {
    const [file] = ui.importFile.files;
    ui.importFile.value = '';
    if (file) await importRules(file);
  });

  renderRules();
  renderStatus();

  return { state, toast, renderRules, renderStatus, requestSync };
}

const auto = typeof document !== 'undefined'
  && document.getElementById('ji-dashboard')
  && typeof globalThis.chrome?.storage !== 'undefined';
if (auto) initDashboard();
