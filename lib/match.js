// Matching engine: converts rules into chrome.userScripts registrations and
// provides URL matching for the popup, dashboard tester and tests.

export const MATCH_TYPES = ['domain', 'regex', 'pattern'];
export const RUN_ATS = ['documentStart', 'documentEnd', 'documentIdle'];
export const WORLDS = ['MAIN', 'USER_SCRIPT'];

const RUN_AT_ENUM = {
  documentStart: 'DOCUMENT_START',
  documentEnd: 'DOCUMENT_END',
  documentIdle: 'DOCUMENT_IDLE',
};

export function uid(prefix) {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/**
 * Normalize a user-supplied base domain: strip scheme, path, port, "www.",
 * leading dots and lowercase. Returns null when nothing usable remains.
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/\/.*$/, ''); // path
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/^\.+/, ''); // leading dots
  s = s.replace(/^[^.\/]+\./, (m) => (m === 'www.' ? '' : m)); // www. only
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s)) return null;
  if (s.includes('..') || s.length > 253) return null;
  return s;
}

/** Chrome match patterns for a base domain (matches domain + subdomains, any port). */
export function domainToPatterns(domain) {
  const d = normalizeDomain(domain);
  if (!d) return [];
  return [`*://${d}/*`, `*://*.${d}/*`];
}

/** Validate a JS regex. Returns { ok, error, regex? }. */
export function validateRegex(source, flags = '') {
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, error: 'Regex is empty' };
  }
  if (typeof flags !== 'string' || /[^dgimsuvy]/.test(flags)) {
    return { ok: false, error: `Invalid flags: ${flags}` };
  }
  try {
    const regex = new RegExp(source, flags);
    return { ok: true, regex };
  } catch (e) {
    return { ok: false, error: `Invalid regex: ${e.message}` };
  }
}

const VALID_SCHEMES = new Set(['*', 'http', 'https', 'ws', 'wss', 'ftp', 'file']);

/** Validate a Chrome match pattern syntactically. */
export function validatePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return { ok: false, error: 'Pattern is empty' };
  const p = pattern.trim();
  if (p === '<all_urls>') return { ok: true };
  const m = /^([^:]+):\/\/([^/:]*)(\/.*)?$/.exec(p);
  if (!m) return { ok: false, error: 'Expected <scheme>://<host>/<path>, e.g. *://example.com/*' };
  const [, scheme, host, path = ''] = m;
  if (!VALID_SCHEMES.has(scheme)) return { ok: false, error: `Unsupported scheme: ${scheme}` };
  if (scheme === 'file' ? host !== '' && host !== '*' : host === '') {
    return { ok: false, error: 'Invalid host' };
  }
  const bareHost = host.startsWith('*.') ? host.slice(2) : host;
  if (host !== '*' && bareHost !== '' && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(bareHost)) {
    return { ok: false, error: `Invalid host: ${host}` };
  }
  if (path === '') return { ok: false, error: 'Path is required (use / for any path)' };
  return { ok: true };
}

/** Parse a match pattern into an equivalent RegExp (full-anchored). */
export function matchPatternToRegExp(pattern) {
  const p = pattern.trim();
  if (p === '<all_urls>') {
    return new RegExp('^(?:https?|wss?|ftp|file|data):.+');
  }
  const m = /^([^:]+):\/\/([^/:]*)(\/.*)?$/.exec(p);
  if (!m) return null;
  const [, scheme, host, path = '/'] = m;
  const schemeRe = scheme === '*' ? 'https?' : scheme.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  let hostRe;
  if (host === '*') hostRe = '[^/?#:]*';
  else if (host.startsWith('*.')) {
    const rest = host.slice(2).replace(/[.+?^${}()|[\]\\$]/g, '\\$&').replace(/\*/g, '\\*');
    hostRe = `(?:[^/?#:]+\\.)?${rest}`;
  } else {
    hostRe = host.replace(/[.+?^${}()|[\]\\$]/g, '\\$&').replace(/\*/g, '\\*');
  }
  const pathRe = path
    .split('*')
    .map((seg) => seg.replace(/[.+?^${}()|[\]\\$]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${schemeRe}:\\/\\/${hostRe}(?::\\d+)?${pathRe}$`);
}

function rulePatterns(rule) {
  if (rule.match.type === 'domain') return domainToPatterns(rule.match.value);
  if (rule.match.type === 'pattern') {
    return String(rule.match.value)
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Browsers normalize URLs to always include at least "/" as the path
 * (location.href of http://example.com is http://example.com/). Normalize
 * input URLs the same way so pattern matching matches runtime behavior.
 */
export function normalizeUrlForMatch(url) {
  return String(url).replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)([?#]|$)/, '$1/$2');
}

/** Does this rule match a full URL string? Throws for malformed rule values. */
export function ruleMatchesUrl(rule, urlString) {
  const url = normalizeUrlForMatch(urlString);
  if (rule.match?.type === 'regex') {
    const flags = rule.match.flags || '';
    const check = validateRegex(rule.match.value, flags);
    if (!check.ok) throw new Error(check.error);
    return check.regex.test(url);
  }
  for (const pattern of rulePatterns(rule)) {
    const re = matchPatternToRegExp(pattern);
    if (re && re.test(url)) return true;
  }
  return false;
}

/** Wrap user code with an IIFE + try/catch so errors are logged, not swallowed. */
export function wrapCode(rule, script, code) {
  return [
    `// JS Injector :: ${rule.name} / ${script.name}`,
    '(() => {',
    '  try {',
    code,
    '  } catch (e) {',
    `    console.error("[JS Injector] ${rule.name}/${script.name}:", e);`,
    '  }',
    '})();',
  ].join('\n');
}

function regexGuardSource(rule) {
  const source = JSON.stringify(String(rule.match.value));
  const flags = JSON.stringify(String(rule.match.flags || ''));
  return `if (!(new RegExp(${source}, ${flags})).test(location.href)) return;`;
}

/**
 * Build chrome.userScripts RegisteredUserScript objects for every enabled
 * script of a rule. Returns [] when nothing should run.
 */
export function buildUserScripts(rule) {
  const out = [];
  if (!rule?.enabled || !Array.isArray(rule.scripts)) return out;
  let matches;
  let guard = '';
  if (rule.match.type === 'domain') {
    matches = domainToPatterns(rule.match.value);
    if (!matches.length) return out;
  } else if (rule.match.type === 'pattern') {
    matches = rulePatterns(rule);
    if (!matches.length) return out;
  } else if (rule.match.type === 'regex') {
    const check = validateRegex(rule.match.value, rule.match.flags || '');
    if (!check.ok) return out;
    matches = ['<all_urls>'];
    guard = regexGuardSource(rule);
  } else {
    return out;
  }

  for (const script of rule.scripts) {
    if (!script?.enabled) continue;
    const code = String(script.code || '');
    const body = [
      `// JS Injector :: ${rule.name} / ${script.name}`,
      '(() => {',
      ...(guard ? ['  ' + guard] : []),
      '  try {',
      code,
      '  } catch (e) {',
      `    console.error("[JS Injector] ${rule.name}/${script.name}:", e);`,
      '  }',
      '})();',
    ].join('\n');
    out.push({
      id: `${rule.id}__${script.id}`,
      js: [{ code: body }],
      matches,
      runAt: RUN_AT_ENUM[script.runAt] || 'DOCUMENT_IDLE',
      world: script.world === 'USER_SCRIPT' ? 'USER_SCRIPT' : 'MAIN',
      allFrames: Boolean(rule.allFrames),
      persistAcrossSessions: true,
    });
  }
  return out;
}
