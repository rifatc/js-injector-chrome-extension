import { describe, it, expect } from 'vitest';
import {
  normalizeDomain,
  domainToPatterns,
  validateRegex,
  validatePattern,
  matchPatternToRegExp,
  ruleMatchesUrl,
  buildUserScripts,
} from '../../lib/match.js';

describe('normalizeDomain', () => {
  it.each([
    ['https://WWW.Example.com/path?q=1', 'example.com'],
    ['example.com', 'example.com'],
    ['.example.com', 'example.com'],
    ['www.example.com', 'example.com'],
    ['https://sub.example.com:8080/x', 'sub.example.com'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
  ])('normalizes %s -> %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    ['', null],
    ['not a domain', null],
    ['example..com', null],
    ['https://example.com/path/../..', 'example.com'],
    ['-bad-.com', null],
  ])('rejects or normalizes %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });
});

describe('domainToPatterns', () => {
  it('produces apex + subdomain patterns', () => {
    expect(domainToPatterns('example.com')).toEqual(['*://example.com/*', '*://*.example.com/*']);
  });
  it('normalizes before converting', () => {
    expect(domainToPatterns('https://Example.com/x')).toEqual(['*://example.com/*', '*://*.example.com/*']);
  });
  it('returns [] for garbage', () => {
    expect(domainToPatterns('not a domain')).toEqual([]);
  });
});

describe('validateRegex', () => {
  it('accepts a valid regex', () => {
    expect(validateRegex('^https://a\\.com', '').ok).toBe(true);
  });
  it('rejects a broken regex with a message', () => {
    const res = validateRegex('(', '');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Invalid regex/);
  });
  it('rejects invalid flags', () => {
    expect(validateRegex('a', 'x').ok).toBe(false);
  });
});

describe('validatePattern / matchPatternToRegExp', () => {
  it.each([
    ['<all_urls>'],
    ['*://example.com/*'],
    ['https://example.com/'],
    ['ftp://host/path*'],
    ['file:///*'],
    ['*://*.example.com/foo'],
  ])('accepts %s', (p) => expect(validatePattern(p).ok).toBe(true));

  it.each([
    ['example.com'],
    ['*://'],
    ['banana://x/*'],
    ['*://example.com'],
  ])('rejects %s', (p) => expect(validatePattern(p).ok).toBe(false));

  it('matches host, subdomains via *., ports and path globs', () => {
    const re = matchPatternToRegExp('*://*.example.com/foo*');
    expect(re.test('https://example.com/foo')).toBe(true);
    expect(re.test('https://a.b.example.com/foo/bar/baz')).toBe(true);
    expect(re.test('http://example.com:3000/foo/x')).toBe(true);
    expect(re.test('https://example.com/bar/foo')).toBe(false);
    expect(re.test('https://notexample.com/foo')).toBe(false);
  });

  it('plain host pattern does not match subdomains', () => {
    const re = matchPatternToRegExp('*://example.com/*');
    expect(re.test('https://example.com/')).toBe(true);
    expect(re.test('https://sub.example.com/')).toBe(false);
  });
});

describe('ruleMatchesUrl', () => {
  it('domain rules match domain + subdomains, any scheme/port', () => {
    const rule = { match: { type: 'domain', value: 'example.com' } };
    expect(ruleMatchesUrl(rule, 'https://example.com/')).toBe(true);
    expect(ruleMatchesUrl(rule, 'https://a.b.example.com/x')).toBe(true);
    expect(ruleMatchesUrl(rule, 'http://example.com:3000/')).toBe(true);
    expect(ruleMatchesUrl(rule, 'https://notexample.com/')).toBe(false);
    expect(ruleMatchesUrl(rule, 'https://evilexample.com/')).toBe(false);
  });

  it('regex rules test the full URL', () => {
    const rule = { match: { type: 'regex', value: '^https?://[^/]+:\\d+/sub/', flags: '' } };
    expect(ruleMatchesUrl(rule, 'http://127.0.0.1:8000/sub/page.html')).toBe(true);
    expect(ruleMatchesUrl(rule, 'http://127.0.0.1:8000/other/page.html')).toBe(false);
  });

  it('pattern rules support multiple patterns separated by lines', () => {
    const rule = { match: { type: 'pattern', value: '*://a.com/*\n*://b.com/*' } };
    expect(ruleMatchesUrl(rule, 'https://a.com/x')).toBe(true);
    expect(ruleMatchesUrl(rule, 'https://b.com/x')).toBe(true);
    expect(ruleMatchesUrl(rule, 'https://c.com/x')).toBe(false);
  });

  it('throws on a malformed rule value', () => {
    const rule = { match: { type: 'regex', value: '(', flags: '' } };
    expect(() => ruleMatchesUrl(rule, 'https://x/')).toThrow();
  });

  it('treats a missing path as "/" like the browser does', () => {
    const domain = { match: { type: 'domain', value: 'example.com' } };
    expect(ruleMatchesUrl(domain, 'https://example.com')).toBe(true);
    const regex = { match: { type: 'regex', value: '^https://example\\.com/$', flags: '' } };
    expect(ruleMatchesUrl(regex, 'https://example.com')).toBe(true);
    const pattern = { match: { type: 'pattern', value: '*://example.com/*' } };
    expect(ruleMatchesUrl(pattern, 'https://example.com')).toBe(true);
  });
});

describe('buildUserScripts', () => {
  const baseRule = {
    id: 'r1',
    name: 'Test rule',
    enabled: true,
    allFrames: false,
    match: { type: 'domain', value: 'example.com', flags: '' },
    scripts: [
      { id: 's1', name: 'alpha', code: 'window.__alpha = 1;', runAt: 'documentStart', world: 'MAIN', enabled: true },
      { id: 's2', name: 'beta', code: 'window.__beta = 2;', runAt: 'documentEnd', world: 'USER_SCRIPT', enabled: true },
      { id: 's3', name: 'off', code: 'noop', runAt: 'documentIdle', world: 'MAIN', enabled: false },
    ],
  };

  it('builds one registration per enabled script with stable ids', () => {
    const defs = buildUserScripts(baseRule);
    expect(defs.map((d) => d.id)).toEqual(['r1__s1', 'r1__s2']);
    expect(defs[0]).toMatchObject({
      matches: ['*://example.com/*', '*://*.example.com/*'],
      runAt: 'DOCUMENT_START',
      world: 'MAIN',
      allFrames: false,
      persistAcrossSessions: true,
    });
    expect(defs[1].world).toBe('USER_SCRIPT');
    expect(defs[1].runAt).toBe('DOCUMENT_END');
  });

  it('wraps code in a compiling IIFE with error reporting', () => {
    const [def] = buildUserScripts(baseRule);
    expect(() => new Function(def.js[0].code)).not.toThrow();
    expect(def.js[0].code).toContain('window.__alpha = 1;');
    expect(def.js[0].code).toContain('Test rule/alpha');
  });

  it('returns [] for disabled rules', () => {
    expect(buildUserScripts({ ...baseRule, enabled: false })).toEqual([]);
  });

  it('regex rules register on <all_urls> with a URL guard that compiles', () => {
    const rule = {
      ...baseRule,
      match: { type: 'regex', value: '^https://[\\w.-]+/sub/', flags: 'i' },
      scripts: [{ id: 's1', name: 'x', code: 'window.__x = "a\\"b";', runAt: 'documentIdle', world: 'MAIN', enabled: true }],
    };
    const [def] = buildUserScripts(rule);
    expect(def.matches).toEqual(['<all_urls>']);
    expect(() => new Function(def.js[0].code)).not.toThrow();
    expect(def.js[0].code).toContain('new RegExp');
    // Guard actually gates execution:
    const fn = new Function('location', 'window', def.js[0].code);
    const win = {};
    fn({ href: 'https://example.com/sub/x' }, win);
    expect(win.__x).toBe('a"b');
    const win2 = {};
    fn({ href: 'https://example.com/other' }, win2);
    expect(win2.__x).toBeUndefined(); // guard skipped execution
  });

  it('rejects invalid regex rules', () => {
    const rule = { ...baseRule, match: { type: 'regex', value: '(', flags: '' } };
    expect(buildUserScripts(rule)).toEqual([]);
  });

  it('pattern rules pass patterns through', () => {
    const rule = {
      ...baseRule,
      match: { type: 'pattern', value: '*://a.com/*\n*://b.com/*' },
      scripts: baseRule.scripts.slice(0, 1),
    };
    const [def] = buildUserScripts(rule);
    expect(def.matches).toEqual(['*://a.com/*', '*://b.com/*']);
  });

  it('propagates allFrames', () => {
    const rule = { ...baseRule, allFrames: true, scripts: baseRule.scripts.slice(0, 1) };
    expect(buildUserScripts(rule)[0].allFrames).toBe(true);
  });
});
