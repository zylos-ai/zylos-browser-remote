/*
 * Extension-side method allowlist.
 *
 * This is a DELIBERATE second copy of the relay's chokepoint allowlist
 * (relay/chokepoint.js), not an oversight and not something to dedupe away.
 *
 * The relay runs in the agent's container. This extension runs on the owner's
 * machine, inside their logged-in browser. Those are different trust domains,
 * and the side holding the real sessions must not execute whatever the other
 * side hands it just because it arrived over an authenticated socket. If the
 * relay is ever compromised, misconfigured, or simply upgraded past this
 * extension, the browser still refuses anything it was not built to do.
 *
 * The invariant, asserted by tools/test-extension.js:
 *
 *     extension allowlist  ⊆  relay allowlist
 *
 * Drift is allowed in exactly one direction: the extension may be STRICTER.
 * An entry here that the relay does not know is a bug (dead code at best,
 * a bypass at worst) and fails the test.
 */

// Real CDP methods forwarded to chrome.debugger untouched.
export const ALLOWED_CDP_METHODS = new Set([
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

// Pseudo-methods implemented by fixed extension source in actions.js. The agent
// supplies DATA (a selector, a string, a URL) -- never code, never coordinates.
export const ALLOWED_BR_METHODS = new Set([
  '_br.info',
  '_br.listTabs',
  '_br.snapshot',
  '_br.click',
  '_br.fill',
  '_br.press',
  '_br.screenshot',
  '_br.navigate',
  '_br.waitFor',
  // Session methods. These pick/label the tab a task runs in; they touch no
  // page content and forward nothing to CDP. openTarget is the one that can
  // create a tab, so it screens its URL through the guard before doing so.
  '_br.openTarget',
  '_br.setState',
  '_br.endTask',
  '_br.clearFinished',
]);

// Named refusals for the surfaces that must never execute here, so a log line
// says WHY rather than just "unknown method". The allowlist above already denies
// them; this is documentation enforced at the point of enforcement.
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
 * @returns {null} when the method may execute here, or a refusal string.
 */
export function methodAllowed(method) {
  if (typeof method !== 'string' || method === '') {
    return 'refused by extension: missing method';
  }
  if (ALLOWED_BR_METHODS.has(method) || ALLOWED_CDP_METHODS.has(method)) {
    return null;
  }
  for (const { re, why } of BANNED_METHOD_PATTERNS) {
    if (re.test(method)) return `refused by extension: ${method} is banned (${why})`;
  }
  return `refused by extension: ${method} is not in the extension allowlist`;
}

/** True for _br.* pseudo-methods, which actions.js implements rather than forwards. */
export function isBrMethod(method) {
  return typeof method === 'string' && method.startsWith('_br.');
}

// Schemes the extension refuses to attach to at all. chrome:// and the Web Store
// are hard-blocked by Chrome itself; listing them lets us return a clear reason
// instead of a raw attach failure, and devtools:// is added because a debugger on
// a DevTools window is a privilege surface with no legitimate P0 use.
const REFUSED_TAB_SCHEMES = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^devtools:\/\//i,
  /^edge:\/\//i,
  /^about:(?!blank$)/i,
  /^https?:\/\/chrome\.google\.com\/webstore/i,
  /^https?:\/\/chromewebstore\.google\.com/i,
];

/**
 * @returns {null} when the tab may be attached to, or a refusal string.
 */
export function tabAttachAllowed(url) {
  if (typeof url !== 'string' || url === '') return null;   // unknown URL: the guard still screens it
  for (const re of REFUSED_TAB_SCHEMES) {
    if (re.test(url)) return `refused by extension: cannot attach to ${url.slice(0, 60)}`;
  }
  return null;
}

export { BANNED_METHOD_PATTERNS, REFUSED_TAB_SCHEMES };
