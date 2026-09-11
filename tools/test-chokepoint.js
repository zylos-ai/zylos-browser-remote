'use strict';
/*
 * Allowlist-layer tests -- the layer guard.js deliberately does NOT cover.
 *
 * tools/test-guard.js asserts that screen() leaves F1/F4/F5 OPEN (it screens
 * URLs, not behaviour). That is correct for guard.js in isolation. This file
 * asserts the layer that closes them: the default-deny allowlist in
 * relay/chokepoint.js. Do not "fix" test-guard.js to expect these refusals --
 * the two files test different layers on purpose.
 *
 * Offline, no network, no relay process. Run: node tools/test-chokepoint.js
 */

const { check, methodAllowed, isMutating } = require('../relay/chokepoint');

let pass = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

function allowed(name, args) {
  const r = check(args);
  ok(name, r === null, `expected allow, got: ${r}`);
}

function refused(name, args, mustMention) {
  const r = check(args);
  ok(name, typeof r === 'string' && (!mustMention || r.includes(mustMention)),
     `expected refusal${mustMention ? ` mentioning "${mustMention}"` : ''}, got: ${r}`);
}

// --- the ban that matters most --------------------------------------------
// The extension drives the owner's REAL browser with their REAL sessions.
// Arbitrary JS there is account-takeover-equivalent, and no URL blocklist can
// see it coming: `document.querySelector('form#pay').submit()` names no URL.
refused('Runtime.evaluate banned', {
  method: 'Runtime.evaluate',
  params: { expression: "document.querySelector('form#pay').submit()" },
  tabUrl: 'https://shop.example.com/products/1',
}, 'banned');
refused('Runtime.callFunctionOn banned', { method: 'Runtime.callFunctionOn', params: {} }, 'banned');
refused('Runtime.compileScript banned', { method: 'Runtime.compileScript', params: {} }, 'banned');
refused('Debugger.setBreakpoint banned', { method: 'Debugger.setBreakpoint', params: {} }, 'banned');
refused('Page.addScriptToEvaluateOnNewDocument banned',
        { method: 'Page.addScriptToEvaluateOnNewDocument', params: {} }, 'banned');

// Raw input injection: clicking a coordinate is unscreenable. Structured
// actions carry a selector the extension can resolve and guard.
refused('Input.dispatchMouseEvent banned', { method: 'Input.dispatchMouseEvent', params: {} }, 'banned');
refused('Input.insertText banned', { method: 'Input.insertText', params: {} }, 'banned');

// Credential / interception surfaces.
refused('Network.getAllCookies banned', { method: 'Network.getAllCookies', params: {} }, 'banned');
refused('Network.setCookie banned', { method: 'Network.setCookie', params: {} }, 'banned');
refused('Storage.getCookies banned', { method: 'Storage.getCookies', params: {} }, 'banned');
refused('Fetch.enable banned', { method: 'Fetch.enable', params: {} }, 'banned');
refused('Browser.close banned', { method: 'Browser.close', params: {} }, 'banned');
refused('Target.createTarget banned', { method: 'Target.createTarget', params: {} }, 'banned');
refused('Page.setDownloadBehavior banned', { method: 'Page.setDownloadBehavior', params: {} }, 'banned');

// --- default-deny ----------------------------------------------------------
refused('unknown CDP domain denied', { method: 'Emulation.setDeviceMetricsOverride', params: {} }, 'allowlist');
refused('unknown _br.* denied', { method: '_br.exec', params: {} }, 'allowlist');
refused('empty method denied', { method: '', params: {} });
refused('missing method denied', { params: {} });
refused('non-string method denied', { method: { toString: () => 'Page.navigate' }, params: {} });
// Case games must not sneak past: the allowlist is exact-match, the ban list
// is case-insensitive, so both spellings end up refused either way.
refused('case-variant Runtime denied', { method: 'runtime.evaluate', params: {} });
refused('case-variant Page.navigate denied', { method: 'page.navigate', params: { url: 'https://a.test/' } });

// --- P0 allowlist passes ---------------------------------------------------
allowed('Page.navigate allowed', { method: 'Page.navigate', params: { url: 'https://example.com/docs' } });
allowed('Page.captureScreenshot allowed', { method: 'Page.captureScreenshot', params: {} });
allowed('Page.enable allowed', { method: 'Page.enable', params: {} });
allowed('Page.reload allowed', { method: 'Page.reload', params: {} });
allowed('Page.getNavigationHistory allowed', { method: 'Page.getNavigationHistory', params: {} });
allowed('_br.snapshot allowed', { method: '_br.snapshot', params: {} });
allowed('_br.click allowed', { method: '_br.click', params: { selector: '#next' } });
allowed('_br.fill allowed', { method: '_br.fill', params: { selector: '#q', value: 'hello' } });
allowed('_br.listTabs allowed', { method: '_br.listTabs', params: {} });
// _br.press is a named-key pseudo-method, NOT the raw Input.* lane: the agent
// sends a key NAME and the extension owns the descriptor. Raw
// Input.dispatchKeyEvent from the agent stays banned (asserted above).
allowed('_br.press allowed', { method: '_br.press', params: { key: 'Enter', selector: '#q' } });
allowed('_br.press without selector allowed', { method: '_br.press', params: { key: 'Escape' } });
// The relay does not validate the key name -- that is the extension's job, and
// it is the layer that owns NAMED_KEYS. The relay's contract is only that the
// pseudo-method itself is on the allowlist.
refused('_br.pressKey (near-miss name) denied', { method: '_br.pressKey', params: { key: 'Enter' } }, 'allowlist');

// --- allowlist passes, guard still refuses ---------------------------------
// Order matters: allowlist first, then the URL guard. An allowlisted method
// pointed at a blocklisted URL must still be refused.
refused('allowed method + blocklisted url param', {
  method: 'Page.navigate',
  params: { url: 'https://shop.example.com/checkout' },
}, 'blocklisted');
refused('allowed method + blocklisted host', {
  method: 'Page.navigate',
  params: { url: 'https://www.chase.com/' },
}, 'blocklisted');
refused('allowed method + blocklisted active tab', {
  method: 'Page.captureScreenshot',
  params: {},
  tabUrl: 'https://shop.example.com/checkouts/c/abc123',
}, 'active tab');
refused('_br.click on a blocklisted target url', {
  method: '_br.click',
  params: { selector: 'a', expectUrl: 'https://example.com/settings/password' },
}, 'blocklisted');
refused('percent-encoded bypass still refused', {
  method: 'Page.navigate',
  params: { url: 'https://shop.example.com/%63heckout' },
}, 'blocklisted');

// --- mutation classification (drives idempotency) --------------------------
ok('navigate is mutating', isMutating('Page.navigate') === true);
ok('_br.click is mutating', isMutating('_br.click') === true);
ok('_br.fill is mutating', isMutating('_br.fill') === true);
// Enter submits forms, so a retry after a mid-flight cutoff must hit the
// idempotency cache rather than press again.
ok('_br.press is mutating', isMutating('_br.press') === true);
ok('snapshot is not mutating', isMutating('_br.snapshot') === false);
ok('screenshot is not mutating', isMutating('Page.captureScreenshot') === false);

// --- methodAllowed() shape -------------------------------------------------
ok('methodAllowed returns null for allowed', methodAllowed('Page.navigate') === null);
ok('methodAllowed returns string for banned', typeof methodAllowed('Runtime.evaluate') === 'string');

// --- report ----------------------------------------------------------------
if (failures.length) {
  console.error(`chokepoint: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  FAIL', f);
  process.exit(1);
}
console.log(`chokepoint: ${pass} assertions passed`);
