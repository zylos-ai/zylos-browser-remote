'use strict';
/*
 * The single gate every agent->extension frame passes through.
 *
 * Order is fixed and must stay fixed:
 *   1. methodAllowed()  -- default-deny allowlist (this file)
 *   2. screen()         -- URL blocklist walk (guard.js, shared with the extension)
 *   3. idempotency      -- replay a recorded answer instead of re-executing
 *
 * The guard sits BELOW the provider seam on purpose: swapping LocalRelayProvider
 * for a future ConnectorProvider cannot route around it, because there is exactly
 * one code path from an agent frame to the extension and it runs through here.
 */

const { screen } = require('./guard');

// --- allowlist -------------------------------------------------------------

// Real CDP methods forwarded to chrome.debugger untouched. Deliberately small:
// this drives the owner's real browser with their real sessions, so "probably
// harmless" is not the bar -- "we actually need it for P0" is.
const ALLOWED_CDP_METHODS = new Set([
  'Page.enable',
  'Page.disable',
  'Page.navigate',
  'Page.reload',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.captureScreenshot',
  'Page.bringToFront',
  'Page.getFrameTree',
]);

// Pseudo-methods implemented by trusted extension code. These are the structured
// actions: they take selectors, never coordinates and never code, and the
// extension applies its own copy of the guard to whatever URL they would reach.
const ALLOWED_BR_METHODS = new Set([
  '_br.info',
  '_br.listTabs',
  '_br.snapshot',
  '_br.click',
  '_br.fill',
  '_br.screenshot',
  '_br.navigate',
  '_br.waitFor',
]);

// Not required for correctness -- the allowlist already denies these -- but a
// named refusal ("banned by policy") beats a generic "not allowed" when the
// reason matters, and it documents the decision at the point it is enforced.
//
// GUARD-REVIEW.md F1: guard.js screens URLs, not behaviour. An expression like
// `document.querySelector('form#pay').submit()` carries no URL and sails past
// screen(). Arbitrary JS in a logged-in browser is account-takeover-equivalent,
// so the ban has to live HERE, at the allowlist, not inside guard.js. The 42
// assertions in tools/test-guard.js still (correctly) assert F1/F4/F5 OPEN for
// screen() in isolation; tools/test-chokepoint.js covers this layer instead.
const BANNED_METHOD_PATTERNS = [
  { re: /^Runtime\./i, why: 'arbitrary code execution in a logged-in browser' },
  { re: /^Debugger\./i, why: 'arbitrary code execution / breakpoint control' },
  { re: /^Input\./i, why: 'raw input injection -- use the structured _br.* actions' },
  { re: /^Fetch\./i, why: 'request interception' },
  { re: /^Network\.(setCookie|setCookies|getCookies|getAllCookies|deleteCookies|setExtraHTTPHeaders)$/i,
    why: 'cookie/credential surface' },
  { re: /^Storage\./i, why: 'origin storage and credential surface' },
  { re: /^Page\.addScriptToEvaluateOnNewDocument$/i, why: 'persistent script injection' },
  { re: /^Page\.setDownloadBehavior$/i, why: 'writes to the owner\'s filesystem' },
  { re: /^Browser\./i, why: 'browser-wide control' },
  { re: /^Target\./i, why: 'target/session creation is out of P0 scope' },
];

/**
 * @returns {null} when the method may proceed, or a refusal string.
 */
function methodAllowed(method) {
  if (typeof method !== 'string' || method === '') {
    return 'refused: missing method';
  }
  if (ALLOWED_BR_METHODS.has(method) || ALLOWED_CDP_METHODS.has(method)) {
    return null;
  }
  for (const { re, why } of BANNED_METHOD_PATTERNS) {
    if (re.test(method)) return `refused: ${method} is banned (${why})`;
  }
  // Default-deny. Unknown _br.* is just as unknown as unknown CDP.
  return `refused: ${method} is not in the P0 allowlist`;
}

// --- idempotency -----------------------------------------------------------

const IDEMPOTENCY_MAX = 500;

class IdempotencyCache {
  constructor(max = IDEMPOTENCY_MAX) {
    this.max = max;
    this.map = new Map();   // insertion-ordered == LRU by age
  }
  get(key) {
    return key ? this.map.get(key) : undefined;
  }
  set(key, value) {
    if (!key) return;
    this.map.set(key, value);
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  }
  get size() {
    return this.map.size;
  }
}

// --- the gate --------------------------------------------------------------

/**
 * Runs the allowlist then the URL guard.
 * @returns {null} when allowed, or a human-readable refusal string.
 */
function check({ method, params, tabUrl } = {}) {
  const banned = methodAllowed(method);
  if (banned) return banned;
  return screen({ method, params, tabUrl });
}

// Mutating actions are the ones where a mid-flight cutoff + retry would do the
// thing twice. Reads are cheap to repeat and must NOT be served from cache, or a
// snapshot would go stale the moment the page moved.
const MUTATING_METHODS = new Set([
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry',
  '_br.navigate',
  '_br.click',
  '_br.fill',
]);

function isMutating(method) {
  return MUTATING_METHODS.has(method);
}

module.exports = {
  check,
  methodAllowed,
  isMutating,
  IdempotencyCache,
  ALLOWED_CDP_METHODS,
  ALLOWED_BR_METHODS,
  BANNED_METHOD_PATTERNS,
  IDEMPOTENCY_MAX,
};
