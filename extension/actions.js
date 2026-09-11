/*
 * _br.* structured actions.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the agent supplies DATA ONLY -- a
 * selector, a string to type, a URL. Every function that runs inside the page is
 * fixed source shipped in this extension, injected with
 * chrome.scripting.executeScript({func, args, world:'ISOLATED'}). Nothing that
 * arrives over the socket is ever compiled, evaluated, or concatenated into code.
 * That is what makes banning Runtime.evaluate at the chokepoint meaningful rather
 * than cosmetic.
 *
 * Two further notes on the mechanics:
 *
 *  - world:'ISOLATED' is not just isolation, it is a correctness requirement for
 *    _br.fill. React patches the *page world's* HTMLInputElement value setter to
 *    track changes; the isolated world has its own unpatched prototype, so a
 *    write there goes through the native setter and React's own listener still
 *    sees the subsequent input event. Writing from the page world instead is the
 *    classic "the box shows text but the app thinks it is empty" bug.
 *
 *  - _br.click and _br.fill DO use Input.dispatchMouseEvent / Input.insertText.
 *    That is not the surface banned at the chokepoint. The ban is on the AGENT
 *    sending raw coordinates and keystrokes; here the coordinates are computed by
 *    this extension from a selector it resolved itself, after screening what the
 *    element would do. Real trusted input events are the only way to drive apps
 *    that (correctly) ignore synthetic ones.
 */

import { isBlockedUrl } from './guard.js';

export const VERSION = '0.1.0';

export const CAPABILITIES = [
  '_br.info',
  '_br.listTabs',
  '_br.snapshot',
  '_br.click',
  '_br.fill',
  '_br.press',
  '_br.screenshot',
  '_br.navigate',
  '_br.waitFor',
  '_br.openTarget',
  '_br.setState',
  '_br.endTask',
  '_br.clearFinished',
];

// The agent sends a key NAME; this table -- fixed extension source -- owns the
// descriptor. That is the same rule as the rest of the file: data in, never
// codes, never coordinates. Exactly three keys, and no modifiers: ctrl/meta
// combos are how a keyboard action becomes a raw-input lane by degrees, and
// this table is the single place anyone has to touch to widen it.
const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};

const NAV_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 15_000;
const WAIT_POLL_MS = 200;
// Enter can submit. Nothing has started navigating the instant the key goes up,
// so the settle poll gets a beat before it starts believing tab.status.
const PRESS_SETTLE_MS = 2500;
const PRESS_LEAD_MS = 300;
const SNAPSHOT_MAX_ELEMENTS = 200;
const SNAPSHOT_MAX_CHARS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ plumbing

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

/**
 * Run one of the fixed functions below inside the page's isolated world.
 * `args` is plain JSON data from the agent -- never source.
 */
async function inject(tabId, func, arg) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func,
    args: [arg],
  });
  const hit = Array.isArray(results) ? results[0] : results;
  if (!hit) throw new Error('page script produced no result (the tab may have navigated)');
  if (hit.error) throw new Error(String(hit.error.message || hit.error));
  return hit.result;
}

/** Injected helpers report failure as data; this is where it becomes an error. */
function unwrap(res) {
  if (!res || typeof res !== 'object') throw new Error('malformed page result');
  if (res.ok === false) throw new Error(res.error || 'page action failed');
  return res;
}

// Only these schemes may ever be navigated to. Without this, `javascript:` in a
// Page.navigate URL would be arbitrary code execution straight through the hole
// the Runtime.* ban was built to close, and `file:`/`data:` would reach the
// owner's disk and bypass origin checks respectively.
function navigableUrl(url) {
  if (typeof url !== 'string' || url === '') return 'refused: navigate requires a url';
  if (/^about:blank$/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) {
    return `refused: only http(s) URLs may be navigated to (got ${url.slice(0, 40)})`;
  }
  if (isBlockedUrl(url)) return `refused: ${url.slice(0, 80)} is on the blocklist`;
  return null;
}

// ------------------------------------------------------------------ injected: snapshot

/* eslint-disable no-undef */
// Runs in the page. Self-contained by necessity: executeScript serializes this
// function, so it can reference nothing from the module scope above.
function pageSnapshot({ maxElements, maxChars }) {
  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]',
    '[role=tab]', '[role=menuitem]', '[role=switch]', '[role=combobox]',
    '[contenteditable=""]', '[contenteditable=true]',
  ].join(',');

  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  }

  function uniq(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  }

  // Preference order is stability first, brevity second: an id survives a
  // re-render, an nth-of-type path often does not.
  function stableSelector(el) {
    if (el.id && uniq('#' + esc(el.id))) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name && uniq(`${tag}[name="${name}"]`)) return `${tag}[name="${name}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 64 && uniq(`${tag}[aria-label="${aria}"]`)) {
      return `${tag}[aria-label="${aria}"]`;
    }
    const testid = el.getAttribute('data-testid');
    if (testid && uniq(`[data-testid="${testid}"]`)) return `[data-testid="${testid}"]`;

    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
      if (cur.id && uniq('#' + esc(cur.id))) { parts.unshift('#' + esc(cur.id)); break; }
      const t = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(t); break; }
      const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName);
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(cur) + 1})` : t);
      cur = parent;
    }
    const sel = parts.join(' > ');
    return uniq(sel) ? sel : `${sel}`;   // reported as-is; the caller sees matches>1 via _br.waitFor
  }

  function visible(el, rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  }

  // Labels are single-line by contract: the 120-char cap should carry ~120
  // characters of meaning, not the first line of a blob plus its newlines.
  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // label[for] resolved ONCE, up front, as DATA. The old code built
  // `label[for="<el.id>"]` by concatenating a page-controlled id into a selector:
  // an id containing a quote or a bracket silently changes what that matches, and
  // an id that makes it invalid throws -- out of labelOf, out of the loop, taking
  // the whole snapshot with it. Comparing htmlFor can do neither, and it is O(1)
  // per element instead of a DOM query.
  const labelByFor = new Map();
  for (const lab of document.querySelectorAll('label[for]')) {
    if (lab.htmlFor && !labelByFor.has(lab.htmlFor)) labelByFor.set(lab.htmlFor, lab);
  }

  // el.type reflects the IDL attribute: lowercase, defaulted, and -- unlike
  // getAttribute('type') -- it follows a type assigned from script.
  function fieldType(el) {
    return String((el.tagName === 'INPUT' ? el.type : el.getAttribute('type')) || '').toLowerCase();
  }

  // DELIBERATELY ASYMMETRIC, and the asymmetry is the point: this broad heuristic
  // gates READS (redaction) only. Over-redacting costs nothing -- the field is
  // still reported, so the agent knows it exists. _br.fill's REFUSAL stays at the
  // narrow `type === 'password'` test in pagePrepareFill, because over-refusing a
  // write breaks ordinary form filling.
  function isSecret(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    if (fieldType(el) === 'password') return true;
    const hint = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id].join(' ').toLowerCase();
    return /pass(wd|word)?|passcode|\botp\b|one-?time|\bcvv\b|\bcvc\b|security-?code|secret|token|\bpin\b/.test(hint);
  }

  function labelOf(el) {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const joined = labelledBy.trim().split(/\s+/)
        .map((id) => { const t = document.getElementById(id); return t ? (t.innerText || t.textContent) : ''; })
        .join(' ');
      const v = norm(joined);
      if (v) return v;
    }

    if (el.id) {
      const lab = labelByFor.get(el.id);
      const v = lab ? norm(lab.innerText || lab.textContent) : '';
      if (v) return v;
    }

    const wrap = el.closest && el.closest('label');
    if (wrap) {
      const v = norm(wrap.innerText || wrap.textContent);
      if (v) return v;
    }

    // DIRECT child text nodes only. On machine-generated markup a card is a
    // wrapper <a> with no text of its own, and taking its whole innerText labels
    // it with every metric inside ("6.5万 109 02:25:21" -- true, useless, and it
    // crowds out the real title). A wrapper has no direct text, so it falls
    // through to title/descendant below; a plain button still matches here.
    let own = '';
    for (const node of el.childNodes) if (node.nodeType === 3) own += node.nodeValue;
    own = norm(own);
    if (own) return own;

    const title = norm(el.getAttribute('title'));
    if (title) return title;

    const inner = el.querySelector('[aria-label], [title], img[alt], h1, h2, h3, h4');
    if (inner) {
      const v = norm(inner.getAttribute('aria-label') || inner.getAttribute('title') ||
        inner.getAttribute('alt') || inner.innerText || inner.textContent);
      if (v) return v;
    }

    const placeholder = norm(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;

    // el.value as a label is right for a submit button and a leak for a password
    // field: rec.value is redacted below, but this path would have carried the
    // same secret out under a different key. Same gate, same call.
    if (!isSecret(el)) {
      const value = norm(el.value);
      if (value) return value;
    }

    // Last resort, not third: when there IS text and nothing above matched, a
    // noisy label still beats an empty one.
    return norm(el.innerText);
  }

  const out = [];
  let truncated = false;
  const nodes = document.querySelectorAll(INTERACTIVE);
  for (const el of nodes) {
    if (out.length >= maxElements) { truncated = true; break; }
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect)) continue;

    const tag = el.tagName.toLowerCase();
    const type = fieldType(el);
    const rec = {
      selector: stableSelector(el),
      tag,
      label: labelOf(el).slice(0, 120),
    };
    if (type) rec.type = type;
    const role = el.getAttribute('role');
    if (role) rec.role = role;
    if (el.hasAttribute('disabled')) rec.disabled = true;
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) rec.checked = Boolean(el.checked);
    if (tag === 'a' && el.href) rec.href = el.href;

    if (tag === 'input' || tag === 'textarea') {
      // A secret value must never leave the browser -- not to the relay, not
      // into a log, not into the agent's context. The field is still reported so
      // the agent knows it exists and can refuse for itself.
      if (isSecret(el)) rec.redacted = true;
      else if (el.value) rec.value = String(el.value).slice(0, 200);
    }
    out.push(rec);
  }

  let text = (document.body && document.body.innerText) || '';
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }

  return {
    ok: true,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    elements: out,
    elementsTotal: nodes.length,
    text,
    truncated,
  };
}

// ------------------------------------------------------------------ injected: click

function pageLocateForClick({ selector }) {
  let el;
  try { el = document.querySelector(selector); }
  catch { return { ok: false, error: `invalid selector: ${selector}` }; }
  if (!el) return { ok: false, error: `no element matches ${selector}` };

  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { ok: false, error: `${selector} has zero size` };

  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
    return { ok: false, error: `${selector} is still outside the viewport after scrolling` };
  }

  // What is actually on top at that point? Clicking blind is how an agent
  // dismisses a cookie banner it never saw, or worse, accepts one.
  const top = document.elementFromPoint(x, y);
  const covered = !(top && (top === el || el.contains(top) || top.contains(el)));
  const link = el.closest ? el.closest('a[href]') : null;

  return {
    ok: true,
    x, y,
    covered,
    coveredBy: covered && top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : null,
    href: link ? link.href : null,
    tag: el.tagName.toLowerCase(),
    disabled: Boolean(el.disabled),
  };
}

// ------------------------------------------------------------------ injected: fill

function pagePrepareFill({ selector }) {
  let el;
  try { el = document.querySelector(selector); }
  catch { return { ok: false, error: `invalid selector: ${selector}` }; }
  if (!el) return { ok: false, error: `no element matches ${selector}` };

  const tag = el.tagName.toLowerCase();
  // el.type, not getAttribute('type'): a field whose type was set from script
  // (el.type = 'password') carries no type ATTRIBUTE at all, and reading the
  // attribute would have walked straight past it into the password box.
  const type = String((el.tagName === 'INPUT' ? el.type : el.getAttribute('type')) || '').toLowerCase();
  if (type === 'password') {
    return { ok: false, error: 'refused: _br.fill will not type into a password field' };
  }
  if (!(tag === 'input' || tag === 'textarea' || el.isContentEditable)) {
    return { ok: false, error: `${selector} is a <${tag}>, not a fillable field` };
  }
  if (el.disabled || el.readOnly) return { ok: false, error: `${selector} is disabled or read-only` };

  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  // Clearing in the ISOLATED world hits the native value setter (see the header
  // note): the page's own framework instrumentation is not in the way.
  if (el.isContentEditable) el.textContent = '';
  else el.value = '';

  return { ok: true, tag, type, focused: document.activeElement === el };
}

function pageFinishFill({ selector }) {
  let el;
  try { el = document.querySelector(selector); }
  catch { return { ok: false, error: `invalid selector: ${selector}` }; }
  if (!el) return { ok: false, error: 'element vanished while filling' };
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const value = el.isContentEditable ? el.textContent : el.value;
  return { ok: true, value: String(value == null ? '' : value).slice(0, 200) };
}

// ------------------------------------------------------------------ injected: press

function pagePrepareKey({ selector }) {
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); }
    catch { return { ok: false, error: `invalid selector: ${selector}` }; }
    if (!el) return { ok: false, error: `no element matches ${selector}` };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
  }

  // A keystroke with nothing focused is the keyboard equivalent of a blind
  // click: it goes to the document and does whatever that page decided a bare
  // Enter means. Refuse instead of guessing.
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) {
    return {
      ok: false,
      error: selector
        ? `${selector} could not be focused, so the key would go nowhere`
        : 'refused: nothing is focused -- pass params.selector to say where the key should go',
    };
  }
  if (el && active !== el && !(el.contains && el.contains(active))) {
    return { ok: false, error: `${selector} could not be focused (focus is on <${active.tagName.toLowerCase()}>)` };
  }

  const type = String((active.tagName === 'INPUT' ? active.type : active.getAttribute('type')) || '').toLowerCase();
  if (type === 'password') {
    return { ok: false, error: 'refused: _br.press will not send keys to a password field' };
  }

  // Enter submits, and the form's action is the ONLY place that destination is
  // visible: it is not in params, and not in the tab URL the relay screened.
  const form = active.closest ? active.closest('form') : null;
  return {
    ok: true,
    tag: active.tagName.toLowerCase(),
    type,
    formAction: form ? String(form.action || '') : null,
  };
}

// ------------------------------------------------------------------ injected: waitFor

function pageCheckState({ selector, state }) {
  if (!selector) {
    return { ok: true, satisfied: document.readyState === 'complete', readyState: document.readyState };
  }
  let els;
  try { els = document.querySelectorAll(selector); }
  catch { return { ok: false, error: `invalid selector: ${selector}` }; }

  if (state === 'gone') return { ok: true, satisfied: els.length === 0, matches: els.length };
  if (els.length === 0) return { ok: true, satisfied: false, matches: 0 };
  if (state === 'present') return { ok: true, satisfied: true, matches: els.length };

  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    return { ok: true, satisfied: true, matches: els.length };
  }
  return { ok: true, satisfied: false, matches: els.length };
}
/* eslint-enable no-undef */

// ------------------------------------------------------------------ actions

async function brSnapshot(tabId, params) {
  const res = unwrap(await inject(tabId, pageSnapshot, {
    maxElements: clampInt(params.maxElements, 1, 1000, SNAPSHOT_MAX_ELEMENTS),
    maxChars: clampInt(params.maxChars, 200, 200_000, SNAPSHOT_MAX_CHARS),
  }));
  delete res.ok;
  return res;
}

async function brClick(tabId, params) {
  const selector = requireSelector(params);
  const loc = unwrap(await inject(tabId, pageLocateForClick, { selector }));

  // The extension is the ONLY party that can see where a link actually points:
  // the relay screened the method and the params, but `href` exists solely in
  // this DOM. A blocklisted destination is refused here or nowhere.
  if (loc.href && isBlockedUrl(loc.href)) {
    throw new Error(`refused: ${selector} links to a blocklisted URL (${loc.href.slice(0, 80)})`);
  }
  if (loc.disabled) throw new Error(`refused: ${selector} is disabled`);
  if (loc.covered) {
    throw new Error(
      `refused: ${selector} is covered by <${loc.coveredBy}> at the click point -- ` +
      'dismiss the overlay first, or target the element that is actually on top'
    );
  }

  const { x, y } = loc;
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

  return { clicked: selector, tag: loc.tag, x, y, href: loc.href || null };
}

async function brFill(tabId, params) {
  const selector = requireSelector(params);
  const text = params.text;
  if (typeof text !== 'string') throw new Error('_br.fill requires params.text (a string)');
  if (text.length > 10_000) throw new Error('_br.fill refuses text longer than 10000 characters');

  const prep = unwrap(await inject(tabId, pagePrepareFill, { selector }));
  if (!prep.focused) throw new Error(`${selector} could not be focused`);

  // insertText produces a real, trusted input event -- apps that ignore
  // synthetic events (most of them, correctly) still see this one.
  if (text !== '') await cdp(tabId, 'Input.insertText', { text });

  const done = unwrap(await inject(tabId, pageFinishFill, { selector }));
  return { filled: selector, type: prep.type || prep.tag, value: done.value };
}

async function brPress(tabId, params) {
  const name = params.key;
  const descriptor = typeof name === 'string' && Object.prototype.hasOwnProperty.call(NAMED_KEYS, name)
    ? NAMED_KEYS[name]
    : null;
  if (!descriptor) {
    throw new Error(
      `_br.press accepts only these key names: ${Object.keys(NAMED_KEYS).join(', ')} ` +
      `(got ${JSON.stringify(name === undefined ? null : name)}). ` +
      'Raw key codes and modifier combos are deliberately unavailable.'
    );
  }
  const selector = params.selector == null ? null : String(params.selector);

  const prep = unwrap(await inject(tabId, pagePrepareKey, { selector }));
  if (prep.formAction && isBlockedUrl(prep.formAction)) {
    throw new Error(
      `refused: the focused field submits to a blocklisted URL (${String(prep.formAction).slice(0, 80)})`
    );
  }

  const base = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
    nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
  };
  // `text` is what makes Chrome treat this as a character-producing key, which
  // is what implicit form submission on Enter keys off.
  await cdp(tabId, 'Input.dispatchKeyEvent',
    descriptor.text ? { type: 'keyDown', text: descriptor.text, ...base } : { type: 'rawKeyDown', ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });

  // Same re-screen as _br.navigate, for the same reason: Enter can land the tab
  // somewhere the request never named.
  await sleep(PRESS_LEAD_MS);
  const deadline = Date.now() + clampInt(params.timeoutMs, 200, 30_000, PRESS_SETTLE_MS);
  let tab = await chrome.tabs.get(tabId);
  while (Date.now() < deadline) {
    tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') break;
    await sleep(150);
  }
  if (isBlockedUrl(tab.url)) {
    throw new Error(`refused: pressing ${descriptor.key} landed on a blocklisted URL (${String(tab.url).slice(0, 80)})`);
  }

  return {
    pressed: descriptor.key,
    target: selector,
    tag: prep.tag,
    url: tab.url,
    settled: tab.status === 'complete',
  };
}

async function brNavigate(tabId, params) {
  const refusal = navigableUrl(params.url);
  if (refusal) throw new Error(refusal);

  await cdp(tabId, 'Page.navigate', { url: params.url });

  // Page.frameStoppedLoading needs Page.enable and an event subscription; polling
  // chrome.tabs.get is coarser but needs neither, and "the tab finished loading"
  // is exactly the tab-level fact the caller asked about.
  const deadline = Date.now() + clampInt(params.timeoutMs, 1000, 60_000, NAV_TIMEOUT_MS);
  let tab = await chrome.tabs.get(tabId);
  while (Date.now() < deadline) {
    tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') break;
    await sleep(150);
  }
  const settled = tab.status === 'complete';

  // A redirect can land somewhere the original URL never revealed, so the
  // destination is screened again after the fact.
  if (isBlockedUrl(tab.url)) {
    throw new Error(`refused: navigation landed on a blocklisted URL (${String(tab.url).slice(0, 80)})`);
  }
  return { url: tab.url, title: tab.title, settled };
}

async function brWaitFor(tabId, params) {
  const selector = params.selector == null ? null : String(params.selector);
  const state = params.state || 'visible';
  if (!['present', 'visible', 'gone'].includes(state)) {
    throw new Error(`_br.waitFor state must be present|visible|gone (got ${state})`);
  }
  const deadline = Date.now() + clampInt(params.timeoutMs, 200, 60_000, WAIT_TIMEOUT_MS);

  let last = null;
  while (Date.now() < deadline) {
    last = unwrap(await inject(tabId, pageCheckState, { selector, state }));
    if (last.satisfied) {
      return { satisfied: true, selector, state, matches: last.matches ?? null, waitedMs: null };
    }
    await sleep(WAIT_POLL_MS);
  }
  return {
    satisfied: false,
    selector,
    state,
    matches: last ? (last.matches ?? null) : null,
    timedOut: true,
  };
}

async function brScreenshot(tabId, params) {
  const format = params.format === 'png' ? 'png' : 'jpeg';
  const req = { format, captureBeyondViewport: false };
  // A full-page PNG of a long document is multiple megabytes, and every byte
  // crosses the edge WS and then lands in the agent's context. JPEG q80 is the
  // default for that reason; png is available when detail actually matters.
  if (format === 'jpeg') req.quality = clampInt(params.quality, 1, 100, 80);

  const res = await cdp(tabId, 'Page.captureScreenshot', req);
  const data = (res && res.data) || '';
  return { format, data, bytes: data.length };
}

async function brListTabs(_tabId, _params, state) {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      task: t.id === state.taskTabId,
    })),
  };
}

async function brInfo(_tabId, _params, state) {
  return {
    name: 'zylos-browser-remote extension',
    version: VERSION,
    capabilities: CAPABILITIES,
    taskTabId: state.taskTabId ?? null,
    attachedTabId: state.attachedTabId ?? null,
  };
}

const HANDLERS = {
  '_br.snapshot': brSnapshot,
  '_br.click': brClick,
  '_br.fill': brFill,
  '_br.press': brPress,
  '_br.navigate': brNavigate,
  '_br.waitFor': brWaitFor,
  '_br.screenshot': brScreenshot,
  '_br.listTabs': brListTabs,
  '_br.info': brInfo,
};

/**
 * Dispatch one _br.* pseudo-method.
 * @param {object} a
 * @param {string} a.method
 * @param {object} a.params  plain JSON from the agent -- data, never code
 * @param {number} a.tabId   the tab this lease is driving
 * @param {object} a.state   {taskTabId, attachedTabId}
 */
export function execBr({ method, params = {}, tabId, state = {} }) {
  const fn = HANDLERS[method];
  if (!fn) throw new Error(`unimplemented _br method: ${method}`);
  return fn(tabId, params, state);
}

/** Real CDP, already past both allowlists and both guards. */
export function execCdp({ method, params = {}, tabId }) {
  return cdp(tabId, method, params);
}

// ------------------------------------------------------------------ small helpers

function requireSelector(params) {
  const sel = params.selector;
  if (typeof sel !== 'string' || sel.trim() === '') {
    throw new Error('params.selector is required (a CSS selector, never coordinates)');
  }
  return sel;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export { navigableUrl, clampInt };
