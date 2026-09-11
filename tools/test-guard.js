'use strict';
// Regression test for the tightenings applied after GUARD-REVIEW.md.
// Offline, no deps, no browser, no network:  node tools/test-guard.js
//
// Every REFUSE case below is a bypass that was CONFIRMED ALLOWED by the review.
// Every ALLOW case is either a documented remaining gap (F1/F4/F5 -- design
// decisions awaiting a call, asserted here so a future change to them is loud)
// or a control that must not regress into over-blocking.

const { screen, isBlockedUrl } = require('../relay/guard');

let pass = 0;
const failures = [];

function refuse(label, url) {
  if (isBlockedUrl(url)) pass++;
  else failures.push(`REFUSE expected but ALLOWED: ${label} -- ${url}`);
}

function allow(label, url) {
  if (!isBlockedUrl(url)) pass++;
  else failures.push(`ALLOW expected but REFUSED: ${label} -- ${url}`);
}

function screenRefused(label, call) {
  const r = screen(call);
  if (r) pass++;
  else failures.push(`screen() REFUSE expected but returned null: ${label}`);
}

function screenAllowed(label, call) {
  const r = screen(call);
  if (!r) pass++;
  else failures.push(`screen() ALLOW expected but refused: ${label} -- ${r}`);
}

// ---- F2: terminator class + pluralized noun ----
refuse('F2 fragment terminator', 'https://shop.example/checkout#step2');
refuse('F2 semicolon terminator', 'https://shop.example/checkout;jsessionid=abc');
refuse('F2 ampersand terminator', 'https://shop.example/pay&next=1');
refuse('F2 real Shopify checkout path', 'https://shop.example/checkouts/c/tok123');
refuse('F2 plural payments', 'https://shop.example/payments#tab');

// ---- F3: percent-encoding ----
refuse('F3 encoded leading char', 'https://shop.example/%63heckout');
refuse('F3 encoded interior char', 'https://shop.example/check%6fut');
refuse('F3 double-encoded', 'https://shop.example/%2563heckout');
allow('F3 malformed escape must not throw', 'https://shop.example/%zz/cart');

// ---- F7: financial hosts ----
refuse('F7 chase', 'https://www.chase.com/transfer');
refuse('F7 binance', 'https://binance.com/withdraw');
refuse('F7 icbc', 'https://mybank.icbc.com.cn/');
refuse('F7 coinbase', 'https://coinbase.com/');
refuse('F7 gemini exchange', 'https://gemini.com/trade');

// ---- F8: account-takeover-equivalent paths ----
refuse('F8 ssh keys', 'https://github.com/settings/ssh');
refuse('F8 emails', 'https://github.com/settings/emails');
refuse('F8 oauth apps', 'https://github.com/settings/applications');
refuse('F8 sessions', 'https://github.com/settings/sessions');
refuse('F8 /user/security', 'https://example.com/user/security');
refuse('F8 /me/password', 'https://example.com/me/password');

// ---- controls: must stay refused (original behaviour) ----
refuse('control checkout', 'https://shop.example/checkout');
refuse('control account security password', 'https://example.com/account/security/password');
refuse('control tokens', 'https://example.com/settings/tokens');
refuse('control reset-password', 'https://example.com/reset-password');

// ---- controls: must stay allowed (no over-blocking regression) ----
allow('worldbank has no word boundary before bank', 'https://worldbank.org/data');
allow('gemini.google.com is not an exchange', 'https://gemini.google.com/app');
allow('ordinary cart page', 'https://shop.example/cart');
allow('payment-guide is prose, not a checkout', 'https://example.com/docs/payment-guide');
allow('profile page', 'https://github.com/settings/profile');
allow('empty / non-string', '');

// ---- F6: nested URLs are now screened ----
screenRefused('F6 Network.setCookies cookies[].url', {
  method: 'Network.setCookies',
  params: { cookies: [{ name: 'a', value: 'b', url: 'https://shop.example/checkout' }] },
});
screenRefused('F6 DOM.setOuterHTML href', {
  method: 'DOM.setOuterHTML',
  params: { nodeId: 4, outerHTML: '<a href="https://example.com/account/security/password">x</a>' },
});
screenRefused('F6 Fetch.fulfillRequest Location header', {
  method: 'Fetch.fulfillRequest',
  params: { responseHeaders: [{ name: 'Location', value: 'https://shop.example/checkouts/c/t1' }] },
});
screenRefused('F6 deep nesting', {
  method: 'X',
  params: { a: { b: { c: [{ d: 'https://chase.com/transfer' }] } } },
});
screenRefused('fails closed on over-deep payload', {
  method: 'X',
  params: JSON.parse('{"a":'.repeat(12) + '"x"' + '}'.repeat(12)),
});

// ---- flat cases still work, and clean payloads still pass ----
screenRefused('Page.navigate to checkout', {
  method: 'Page.navigate',
  params: { url: 'https://shop.example/checkout' },
});
screenAllowed('clean navigate', {
  method: 'Page.navigate',
  params: { url: 'https://example.com/products/1' },
});
screenRefused('blocklisted active tab', {
  method: 'Input.dispatchMouseEvent',
  params: { type: 'mousePressed' },
  tabUrl: 'https://shop.example/checkout',
});

// ---- F1 partial: an expression NAMING a blocked URL is now caught... ----
screenRefused('F1 partial: evaluate naming a blocked URL', {
  method: 'Runtime.evaluate',
  params: { expression: "location.href='https://shop.example/checkout'" },
});
// ---- ...but these remain OPEN by design. Asserted so a future fix is visible. ----
screenAllowed('F1 OPEN: in-page action carries no URL', {
  method: 'Runtime.evaluate',
  params: { expression: "document.querySelector('form#pay').submit()" },
});
screenAllowed('F4 OPEN: omitted tabUrl is a relay-side no-op', {
  method: 'Input.dispatchMouseEvent',
  params: { type: 'mousePressed' },
});
screenAllowed('F5 OPEN: history navigation carries no URL', {
  method: 'Page.navigateToHistoryEntry',
  params: { entryId: 3 },
});

if (failures.length) {
  console.error(`guard-test FAIL: ${failures.length} of ${pass + failures.length} assertions failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`guard-test OK: ${pass} assertions passed.`);
console.log('Note: F1 (in-page actions), F4 (optional tabUrl), F5 (history nav) remain OPEN by design -- see GUARD-REVIEW.md.');
