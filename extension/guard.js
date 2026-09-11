
// Shared safety guard -- COPY of relay/guard.js (an MV3 service worker cannot
// import from the relay). Keep the two in sync by hand.
// The region between the SHARED GUARD BLOCK markers must be byte-identical in both
// copies; `node tools/check-guard-sync.js` asserts it (see GUARD-REVIEW.md F9).

// --- SHARED GUARD BLOCK START ---

// Hosts/paths that must never be driven without a per-case go-ahead from the owner.
// Matching is intentionally broad: a false refusal is cheap, a wrong click is not.
const BLOCKED_URL_PATTERNS = [
  // payment / checkout / banking
  // The old terminator class was (\/|$|\?), so /checkout#step2 and
  // /checkout;jsessionid=.. slipped through, as did a quoted URL embedded in a
  // script string. A negative lookahead terminates on ANY non-word character
  // instead of an enumerated list, while still letting /payment-guide and
  // /payload through -- '-' and '_' stay in the excluded set deliberately, so
  // prose paths are not over-blocked. The noun is pluralizable so Shopify's real
  // /checkouts/c/<token> path matches (F2).
  /\/(checkouts?|payments?|billing|cart\/checkout|pay)(?![a-z0-9_-])/i,
  /\b(paypal|stripe|alipay|wechatpay|unionpay|klarna|afterpay|braintree|adyen)\b/i,
  /\b(bank|banking|netbanking|onlinebanking)\b/i,
  // account + security settings
  /\/(accounts?|settings|preferences|profile|users?|me)\/(security|password|passwd|payment|payments|billing|delete|close|2fa|mfa|otp|recovery)/i,
  // account-takeover-equivalent surfaces: key/email/session/app management (F8)
  /\/(accounts?|settings|preferences|profile|users?|me)\/(ssh|ssh[-_]?keys|gpg|gpg[-_]?keys|keys|emails?|phone|applications|authorized|connections|sessions|devices)/i,
  /\/(change|reset|forgot)[-_]?password/i,
  /\/(security|privacy)[-_]?settings/i,
  /\/(api[-_]?keys|tokens|credentials|oauth\/authorize)(?![a-z0-9_-])/i,
  // destructive account actions
  /\/(delete|deactivate|close)[-_]?account/i,
];

// Financial / custodial hostnames (F7). The \b(bank)\b path pattern above misses
// every real bank domain -- "chase.com", "usbank.com" and "bankofamerica.com" all
// slip past it -- so hosts are screened separately against the URL's authority.
const BLOCKED_HOST_PATTERNS = [
  /(^|\.)(chase|wellsfargo|bankofamerica|citi|citibank|hsbc|barclays|lloyds|santander|usbank|pnc|capitalone|amex|americanexpress)\./i,
  /(^|\.)(schwab|fidelity|vanguard|etrade|robinhood|interactivebrokers|revolut|wise|monzo|n26|paypal|stripe)\./i,
  /(^|\.)(icbc|ccb|abchina|boc|bankcomm|bocom|cmbchina|spdb|psbc|pingan|alipay|antgroup)\./i,
  /(^|\.)(binance|coinbase|kraken|okx|bybit|bitfinex|metamask|ledger|trezor)\./i,
  // Anchored to their exact domain: the bare words collide with unrelated hosts
  // (gemini.google.com is not an exchange, discover.<corp>.com is not a card issuer).
  /(^|\.)(gemini|blockchain|discover)\.(com|info)$/i,
];

// Screening walks every string in `params`, so there is no carrier allowlist to
// keep current (F6/F10). These caps bound the walk; hitting either fails CLOSED.
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 4000;
const SCAN_LIMIT = Symbol('scan-limit');

// Percent-encoding is a trivial bypass (/%63heckout), so every candidate is tested
// raw and decoded, up to two rounds of decoding (F3). Malformed escapes throw --
// decodeURIComponent('%zz') -- so each round is guarded.
function decodeVariants(s) {
  const out = [s];
  let cur = s;
  for (let i = 0; i < 2; i++) {
    let next;
    try {
      next = decodeURIComponent(cur);
    } catch {
      break;
    }
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

// Authority component of an absolute URL, minus userinfo and port. '' when the
// string is not an absolute URL (relative paths carry no host to screen).
function hostOf(s) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s);
  if (!m) return '';
  return m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
}

function isBlockedUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  for (const variant of decodeVariants(url)) {
    if (BLOCKED_URL_PATTERNS.some((re) => re.test(variant))) return true;
    const host = hostOf(variant);
    if (host && BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) return true;
  }
  return false;
}

// Depth-first walk of every string reachable from `params`. Returns the dotted
// path of the first blocklisted string, SCAN_LIMIT if the caps were hit before
// the walk finished, or null when the whole payload is clean.
function firstBlockedPath(root) {
  const stack = [{ node: root, path: 'params', depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { node, path, depth } = stack.pop();
    if (++nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) return SCAN_LIMIT;
    if (typeof node === 'string') {
      if (isBlockedUrl(node)) return path;
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push({ node: node[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
      continue;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        stack.push({ node: node[key], path: `${path}.${key}`, depth: depth + 1 });
      }
    }
  }
  return null;
}

// Returns null when allowed, or a human-readable reason string when refused.
// NOTE (GUARD-REVIEW.md F1): this screens URLs, not behaviour. Runtime.evaluate
// expressions are walked like any other string, so an expression that *names* a
// blocklisted URL is refused -- but an expression that acts on the current page
// (form#pay.submit(), el.click()) carries no URL and still passes. Keep /eval out
// of any flow where that distinction matters.
function screen({ method, params, tabUrl } = {}) {
  if (isBlockedUrl(tabUrl)) {
    return `refused: active tab URL is on the blocklist (payment/account-settings class page)`;
  }
  if (params && typeof params === 'object') {
    const hit = firstBlockedPath(params);
    if (hit === SCAN_LIMIT) {
      return `refused: ${method} params are too large or too deeply nested to screen safely`;
    }
    if (hit) {
      return `refused: ${method} ${hit} targets a blocklisted URL`;
    }
  }
  return null;
}

// Exported by reference, so freeze them: nothing in-process should be able to
// empty the blocklist (F9).
Object.freeze(BLOCKED_URL_PATTERNS);
Object.freeze(BLOCKED_HOST_PATTERNS);

// --- SHARED GUARD BLOCK END ---

export { screen, isBlockedUrl, BLOCKED_URL_PATTERNS, BLOCKED_HOST_PATTERNS };
