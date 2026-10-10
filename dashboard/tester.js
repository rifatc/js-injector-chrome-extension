// Pure helper for the dashboard's regex/match tester: run a list of URLs
// against a rule and report per-URL results (or rule validation errors).

import { ruleMatchesUrl } from '../lib/match.js';

export function testUrls(rule, urlsText) {
  return String(urlsText ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => {
      try {
        return { url, matches: ruleMatchesUrl(rule, url) };
      } catch (e) {
        return { url, matches: false, error: String(e?.message || e) };
      }
    });
}
