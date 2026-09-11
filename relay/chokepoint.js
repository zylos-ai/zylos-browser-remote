'use strict';
/*
 * The single gate every agent->extension frame passes through.
 *
 * Order is fixed and must stay fixed:
 *   1. methodAllowed()  -- default-deny allowlist (this file)
 *   2. screen()         -- URL blocklist walk (guard.js, shared with the extension)
 *   3. paramsAllowed()  -- per-method payload shape (this file)
 *   4. idempotency      -- replay a recorded answer instead of re-executing
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
  // _br.press takes a key NAME from a three-entry table the extension owns
  // (Enter/Tab/Escape). It is NOT a widening of BANNED_METHOD_PATTERNS: raw
  // Input.* from the agent stays banned below, exactly as before.
  '_br.press',
  '_br.screenshot',
  '_br.navigate',
  '_br.waitFor',
  // --- task-session methods (SIDEPANEL-SPEC.md D) ---------------------------
  // Same bar as the rest of this list: each carries DATA the extension
  // interprets (a URL, one of three state words) and never code. Tab/group
  // management stays entirely inside the extension, which re-screens the URL
  // against its own guard copy before it touches anything -- these do not widen
  // what can be executed on a page, only which tab the session is pointed at.
  '_br.openTarget',
  '_br.setState',
  '_br.endTask',
  '_br.clearFinished',
]);

// Data-shape screening for the session methods. The allowlist says WHICH method
// may run; this says the payload is the narrow data the method is allowed to
// carry. `state` in particular is a closed set of three words -- an unchecked
// string here would reach chrome.tabGroups.update as a title/colour input.
const BR_STATES = new Set(['working', 'waiting', 'stopped']);

const BR_PARAM_RULES = {
  '_br.openTarget': (p) => (typeof p.url === 'string' && p.url !== ''
    ? null
    : 'refused: _br.openTarget requires a url string'),
  '_br.setState': (p) => (typeof p.state === 'string' && BR_STATES.has(p.state)
    ? null
    : `refused: _br.setState state must be one of ${[...BR_STATES].join('|')}`),
  '_br.endTask': () => null,
  '_br.clearFinished': () => null,
};

/**
 * @returns {null} when the params are the shape the method may carry, or a
 * refusal string. Methods without a rule are unconstrained here by design --
 * their params are already walked by screen().
 */
function paramsAllowed(method, params) {
  const rule = BR_PARAM_RULES[method];
  if (!rule) return null;
  if (params === undefined || params === null) return rule({});
  if (typeof params !== 'object' || Array.isArray(params)) {
    return `refused: ${method} params must be an object`;
  }
  return rule(params);
}

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
  // URL screening stays ahead of shape screening: when a payload is both
  // malformed and points at a blocklisted URL, the blocklist is the answer the
  // caller needs to see.
  const blocked = screen({ method, params, tabUrl });
  if (blocked) return blocked;
  return paramsAllowed(method, params);
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
  // Enter submits forms. A retry after a mid-flight cutoff must replay the
  // recorded answer rather than submit a second time.
  '_br.press',
  // Opening a target can CREATE a tab; a retry after a cutoff would leave the
  // owner with two. setState/endTask/clearFinished are naturally idempotent
  // (applying the same state twice is the same state), so they stay out.
  '_br.openTarget',
]);

function isMutating(method) {
  return MUTATING_METHODS.has(method);
}

module.exports = {
  check,
  methodAllowed,
  paramsAllowed,
  isMutating,
  BR_STATES,
  IdempotencyCache,
  ALLOWED_CDP_METHODS,
  ALLOWED_BR_METHODS,
  BANNED_METHOD_PATTERNS,
  IDEMPOTENCY_MAX,
};
