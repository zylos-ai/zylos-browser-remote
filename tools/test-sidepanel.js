'use strict';
/*
 * Side-panel regression tests -- extension/sidepanel.html + sidepanel.js.
 *
 * The panel renders text the agent read off a web page (titles, link labels,
 * model replies). That text is attacker-influenced, so the assertions here are
 * weighted towards XSS resistance first, then the three behaviours the owner
 * would notice within a minute of them breaking: IME-safe Enter (he types
 * Chinese), the 200-entry transcript cap dropping the OLDEST entry, and the
 * optimistic echo of his own message.
 *
 * Offline, no network, no browser, no test framework.
 * Run: node tools/test-sidepanel.js
 *
 * -------------------------------------------------------------------------
 * WHY A HAND-ROLLED DOM, AND WHAT IT DOES NOT COVER
 * -------------------------------------------------------------------------
 * jsdom does not resolve from this repo (`node -e "require.resolve('jsdom')"`
 * fails) and adding a dependency for a test is not worth it, so sidepanel.js is
 * executed in a `vm` context against the ~200-line stub below. The element ids
 * and the `hidden` attribute are parsed out of the real sidepanel.html, so a
 * renamed or deleted id fails here -- but the stub is a behavioural mock, not a
 * browser.
 *
 * COVERED by the stub, i.e. these assertions are real:
 *   - node creation / textContent / append / replaceChildren / childElementCount
 *   - the HTML sinks are TRAPPED: assigning innerHTML or outerHTML, or calling
 *     insertAdjacentHTML / document.write, records a violation instead of
 *     parsing, so a future edit that introduces one fails loudly (and the trap
 *     itself is self-tested below, so a broken trap cannot pass silently)
 *   - addEventListener + synthetic keydown/composition/submit/input/change
 *   - chrome.runtime.sendMessage (resolve, reject, or never settle),
 *     chrome.runtime.onMessage broadcasts, chrome.storage.local get/set with
 *     structured-clone semantics and onChanged echo of the panel's own writes
 *
 * NOT COVERED -- do not read a pass here as coverage of:
 *   - real HTML parsing or CSS. The stub never parses markup, so the
 *     "renders as literal text" proof is: textContent matches byte-for-byte AND
 *     the node has zero element children AND serialising the tree escapes it.
 *     It is not a proof that Chrome's parser would agree (it would; there is no
 *     parse step in the code path at all -- that is the point).
 *   - CSP. sidepanel.html is checked by regex for inline handlers / inline
 *     <script> / remote origins; the manifest's CSP is not evaluated.
 *   - scroll geometry. scrollHeight/clientHeight are faked, so atBottom() is
 *     always true here; "stick to bottom only when already at bottom" is NOT
 *     tested.
 *   - layout, focus, real IME. Composition is simulated by setting
 *     ev.isComposing, which is what Chrome does on Linux/Windows; the known
 *     keydown-after-compositionend quirk on some macOS IMEs cannot be
 *     reproduced without a browser.
 *   - `type="module"` scoping. The vm runs sidepanel.js as a classic script, so
 *     its top-level `const`s become sandbox globals here but stay module-scoped
 *     in Chrome. Nothing asserted below depends on that difference.
 *   - the service worker on the other end of every message.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'extension', 'sidepanel.js');
const HTML_PATH = path.join(ROOT, 'extension', 'sidepanel.html');
const SRC = fs.readFileSync(JS_PATH, 'utf8');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

// sidepanel.js does its startup work inside `void (async () => ...)()`, so a
// throw in there (a renamed element id, say) surfaces as an unhandled rejection
// rather than a failed assertion. Report it in the same shape instead of
// letting node print a bare stack.
function die(what, err) {
  console.error(`sidepanel: ${pass} passed, ${what}`);
  for (const f of failures) console.error('  FAIL', f);
  console.error((err && err.stack) || String(err));
  process.exit(1);
}
process.on('unhandledRejection', (err) => die('panel raised an unhandled rejection', err));
process.on('uncaughtException', (err) => die('panel threw', err));

// ===========================================================================
// DOM stub
// ===========================================================================

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESCAPES[c]);

class TextNode {
  constructor(text) { this.nodeType = 3; this.parentNode = null; this._text = String(text); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class El {
  constructor(tag, id, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.doc = doc;
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this.className = '';
    this.title = '';
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.scrollTop = 0;
    this.clientHeight = 0;
  }

  // --- the trapped sinks. Recording rather than throwing keeps the panel
  // running so the test can report every violation in one pass.
  set innerHTML(v) { this.doc.violations.push(`innerHTML= on <${this.tagName}#${this.id}>: ${String(v).slice(0, 60)}`); }
  get innerHTML() { return serialize(this); }
  set outerHTML(v) { this.doc.violations.push(`outerHTML= on <${this.tagName}#${this.id}>: ${String(v).slice(0, 60)}`); }
  get outerHTML() { return serialize(this, true); }
  insertAdjacentHTML(pos, v) { this.doc.violations.push(`insertAdjacentHTML(${pos}) on <${this.tagName}#${this.id}>: ${String(v).slice(0, 60)}`); }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = v === null || v === undefined ? '' : String(v);
  }

  get childElementCount() { return this.children.filter((c) => c.nodeType === 1).length; }
  get scrollHeight() { return this.children.length * 40; }

  _detach(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
  }

  append(...nodes) {
    if (this._text !== '') { const t = new TextNode(this._text); t.parentNode = this; this.children.push(t); this._text = ''; }
    for (const n of nodes) {
      if (typeof n === 'string') { const t = new TextNode(n); t.parentNode = this; this.children.push(t); continue; }
      if (n.parentNode) n.parentNode._detach(n);
      n.parentNode = this;
      this.children.push(n);
    }
  }

  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  querySelector() { return null; }
}

function serialize(node, includeSelf = true) {
  if (node.nodeType === 3) return esc(node.textContent);
  const inner = node.children.length
    ? node.children.map((c) => serialize(c)).join('')
    : esc(node._text);
  if (!includeSelf) return inner;
  const attrs = [node.id ? ` id="${esc(node.id)}"` : '', node.className ? ` class="${esc(node.className)}"` : ''].join('');
  return `<${node.tagName.toLowerCase()}${attrs}>${inner}</${node.tagName.toLowerCase()}>`;
}

// Element ids + tag names + the `hidden` attribute, read out of the real HTML,
// so a rename in sidepanel.html surfaces as a crash in sidepanel.js here.
function parseElements(html) {
  const out = [];
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const [, tag, attrs] = m;
    const idm = /\bid="([^"]+)"/.exec(attrs);
    if (!idm) continue;
    out.push({ tag, id: idm[1], hidden: /\bhidden(\s|$|=)/.test(attrs) });
  }
  return out;
}

const HTML_ELEMENTS = parseElements(HTML);
const HTML_IDS = new Set(HTML_ELEMENTS.map((e) => e.id));

function makeDocument() {
  const doc = {
    violations: [],
    readyState: 'complete',
    activeElement: null,
    byId: new Map(),
    listeners: new Map(),
  };
  doc.createElement = (tag) => new El(tag, '', doc);
  doc.createTextNode = (t) => new TextNode(t);
  doc.createDocumentFragment = () => new El('#fragment', '', doc);
  doc.getElementById = (id) => doc.byId.get(id) || null;
  doc.querySelector = () => null;
  doc.write = (v) => doc.violations.push(`document.write(): ${String(v).slice(0, 60)}`);
  doc.writeln = doc.write;
  doc.addEventListener = (type, fn) => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, []);
    doc.listeners.get(type).push(fn);
  };
  for (const spec of HTML_ELEMENTS) {
    const el = new El(spec.tag, spec.id, doc);
    el.hidden = spec.hidden;
    doc.byId.set(spec.id, el);
  }
  // Mirror the one nesting relationship the code depends on.
  const transcript = doc.byId.get('transcript');
  const hint = doc.byId.get('emptyHint');
  if (transcript && hint) transcript.append(hint);
  doc.body = new El('body', '', doc);
  return doc;
}

function fire(el, type, init = {}) {
  let defaultPrevented = false;
  const ev = {
    type,
    target: el,
    currentTarget: el,
    preventDefault() { defaultPrevented = true; },
    stopPropagation() {},
    get defaultPrevented() { return defaultPrevented; },
    ...init,
  };
  for (const fn of el.listeners.get(type) || []) fn(ev);
  return { defaultPrevented };
}

// ===========================================================================
// chrome stub
// ===========================================================================

function clone(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

function makeChrome(opts = {}) {
  const store = new Map(Object.entries(clone(opts.storage || {})));
  const api = {
    sent: [],
    sets: [],
    runtimeListeners: [],
    storageListeners: [],
    // Default: the worker is awake and says nothing interesting.
    respond: opts.respond || (async () => ({ ok: true })),
    // Chrome fires storage.onChanged in the writing context too; keeping that
    // exercises the panel's own-write guard in onStorageChanged().
    echoChanges: opts.echoChanges !== false,
  };

  const chrome = {
    runtime: {
      sendMessage(msg) {
        api.sent.push(clone(msg));
        return Promise.resolve().then(() => api.respond(msg));
      },
      onMessage: { addListener: (fn) => api.runtimeListeners.push(fn) },
      lastError: undefined,
    },
    storage: {
      local: {
        get(keys) {
          const want = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
          const out = {};
          for (const k of want) if (store.has(k)) out[k] = clone(store.get(k));
          return Promise.resolve(out);
        },
        set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store.has(k) ? clone(store.get(k)) : undefined, newValue: clone(v) };
            store.set(k, clone(v));
          }
          api.sets.push(clone(obj));
          if (api.echoChanges) {
            Promise.resolve().then(() => {
              for (const fn of api.storageListeners) fn(clone(changes), 'local');
            });
          }
          return Promise.resolve();
        },
        remove(k) { store.delete(k); return Promise.resolve(); },
      },
      onChanged: { addListener: (fn) => api.storageListeners.push(fn) },
    },
  };

  api.chrome = chrome;
  api.store = store;
  api.push = (msg) => { for (const fn of api.runtimeListeners) fn(msg, {}, () => {}); };
  api.changed = (changes, area = 'local') => { for (const fn of api.storageListeners) fn(changes, area); };
  api.ofType = (t) => api.sent.filter((m) => m && m.type === t);
  return api;
}

function makeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    set: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clear: (id) => { pending.delete(id); },
    run: () => { const jobs = [...pending.values()]; pending.clear(); for (const j of jobs) j.fn(); },
  };
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

// Boot a fresh copy of sidepanel.js against fresh stubs. Module-level state in
// the panel (chatLog, connState) makes cross-test reuse unsound.
async function boot(opts = {}) {
  const doc = makeDocument();
  const ch = makeChrome(opts);
  const timers = makeTimers();
  const sandbox = {
    document: doc,
    chrome: ch.chrome,
    console: opts.quiet === false ? console : { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    setInterval: timers.set,
    clearInterval: timers.clear,
    structuredClone,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: 'extension/sidepanel.js' });
  await flush();
  const env = {
    doc, ch, timers, ctx,
    $: (id) => doc.getElementById(id),
    bubbles: () => doc.getElementById('transcript').children
      .filter((c) => c.nodeType === 1 && /^msg /.test(c.className))
      .map((c) => ({ role: c.className.replace('msg ', ''), text: c.children[0] ? c.children[0].textContent : '' })),
  };
  return env;
}

// A connected panel: the composer is only unlocked when state === 'connected'.
const bootConnected = (opts = {}) => boot({
  ...opts,
  storage: { status: { state: 'connected', at: Date.now() }, enabled: true, ...(opts.storage || {}) },
});

// ===========================================================================
// Source-text scanning (comment/string/regex aware)
// ===========================================================================

function stripLiterals(src) {
  let out = '';
  let i = 0;
  let prev = '';
  const canRegex = (p) => p === '' || '(,=:[!&|?{};+-*%~^<>'.includes(p);
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += ' STR '; prev = ')'; continue;
    }
    if (c === '/' && canRegex(prev)) {
      i++; let cls = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') cls = true;
        else if (ch === ']') cls = false;
        else if (ch === '/' && !cls) { i++; break; }
        else if (ch === '\n') break;
        i++;
      }
      while (i < src.length && /[a-z]/.test(src[i])) i++;
      out += ' RE '; prev = ')'; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const CODE = stripLiterals(SRC);
const lineOf = (needle) => {
  const idx = SRC.indexOf(needle);
  return idx < 0 ? 0 : SRC.slice(0, idx).split('\n').length;
};

// ===========================================================================
// 1. Harness self-test -- a disarmed trap must not read as a pass
// ===========================================================================
{
  const doc = makeDocument();
  const probe = doc.createElement('div');
  probe.innerHTML = '<b>x</b>';
  probe.insertAdjacentHTML('beforeend', '<i>y</i>');
  doc.write('<script>');
  ok('harness: HTML sinks are trapped', doc.violations.length === 3,
     `expected 3 recorded violations, got ${doc.violations.length}`);
  const t = doc.createElement('div');
  t.textContent = '<img src=x onerror=alert(1)>';
  ok('harness: serializer escapes markup',
     serialize(t) === '<div>&lt;img src=x onerror=alert(1)&gt;</div>', serialize(t));
}

// ===========================================================================
// 2. XSS surface, by source text
// ===========================================================================
ok('js: no .innerHTML assignment', !/\.\s*innerHTML\s*=/.test(CODE));
ok('js: no innerHTML reference at all', !/\binnerHTML\b/.test(CODE));
ok('js: no outerHTML reference', !/\bouterHTML\b/.test(CODE));
ok('js: no insertAdjacentHTML', !/\binsertAdjacentHTML\b/.test(CODE));
ok('js: no document.write', !/\bdocument\s*\.\s*write(ln)?\s*\(/.test(CODE));
ok('js: no eval()', !/\beval\s*\(/.test(CODE));
ok('js: no new Function()', !/\bnew\s+Function\s*\(/.test(CODE));
ok('js: no createContextualFragment', !/createContextualFragment/.test(CODE));
ok('js: no DOMParser', !/\bDOMParser\b/.test(CODE));
ok('js: no setHTML/srcdoc', !/\b(setHTML|srcdoc)\b/.test(CODE));
// Every createElement() call must name a literal, inert tag: a computed tag
// (createElement(msg.kind)) would let a reply mint <script> or <iframe>.
{
  const tags = [...SRC.matchAll(/createElement\(([^)]*)\)/g)].map((m) => m[1].trim());
  const bad = tags.filter((t) => !/^'(div|span|p|pre|code|br)'$/.test(t));
  ok('js: createElement only ever names a literal inert tag', bad.length === 0, `saw: ${bad.join(', ')}`);
  ok('js: the panel does build nodes programmatically', tags.length >= 2, `${tags.length} createElement calls`);
}
ok('js: writes text with textContent', /\.textContent\s*=/.test(CODE));
ok('js: transcript cap is 200', /CHAT_LOG_MAX\s*=\s*200\b/.test(CODE),
   'CHAT_LOG_MAX must stay 200 -- the cap tests below assume it');

ok('html: no inline event handlers', !/<[^>]*\son[a-z]+\s*=/i.test(HTML),
   'found an on*= attribute in sidepanel.html');
ok('html: no javascript: urls', !/javascript\s*:/i.test(HTML));
ok('html: no inline <script> body', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(HTML),
   'every <script> must load from a file, never inline');
ok('html: script loads sidepanel.js from the extension',
   /<script[^>]*\bsrc="sidepanel\.js"/.test(HTML));
ok('html: no remote origins', !/(?:src|href)="https?:/i.test(HTML),
   'side panel must not fetch anything off-origin');
ok('html: no iframe/object/embed', !/<(iframe|object|embed)\b/i.test(HTML));

// Every id sidepanel.js reaches for must exist in the markup.
{
  const wanted = new Set();
  for (const m of SRC.matchAll(/\$\('([^']+)'\)/g)) wanted.add(m[1]);
  const missing = [...wanted].filter((id) => !HTML_IDS.has(id));
  ok('html/js: every $(id) exists in sidepanel.html', missing.length === 0, `missing: ${missing.join(', ')}`);
  ok('html/js: the panel reaches for a plausible number of ids', wanted.size >= 10, `only ${wanted.size}`);
}

// ===========================================================================
// 3-7 need the panel booted, which is async. CommonJS has no top-level await,
// so everything from here down runs inside main().
// ===========================================================================
async function main() {

// ===========================================================================
// 3. XSS surface, by behaviour
// ===========================================================================
{
  const XSS = '<img src=x onerror=alert(1)>';
  const env = await bootConnected();

  env.ch.push({ type: 'chat.message', role: 'assistant', text: XSS, ts: Date.now() });
  await flush();

  const b = env.bubbles();
  ok('xss: reply rendered as exactly one bubble', b.length === 1, `got ${b.length}`);
  ok('xss: payload survives byte-for-byte as text', b[0] && b[0].text === XSS, JSON.stringify(b[0]));

  const wrap = env.$('transcript').children.find((c) => c.nodeType === 1 && /^msg /.test(c.className));
  const bubble = wrap && wrap.children[0];
  ok('xss: bubble has zero element children', bubble && bubble.childElementCount === 0,
     `childElementCount=${bubble && bubble.childElementCount}`);
  const html = serialize(env.$('transcript'));
  ok('xss: serialized tree escapes the payload', html.includes('&lt;img src=x onerror=alert(1)&gt;'), html.slice(0, 200));
  ok('xss: no <img element materialised', !/<img/i.test(html));

  // A page title is the other attacker-influenced string that reaches the panel.
  env.ch.push({ type: 'chat.message', role: 'assistant', text: '标题</div><script>fetch("//evil")</script>', ts: Date.now() });
  // A user echo, too: the owner can paste anything.
  env.$('input').value = '</textarea><svg onload=alert(1)>';
  fire(env.$('input'), 'keydown', { key: 'Enter', shiftKey: false, isComposing: false });
  await flush();

  const all = serialize(env.$('transcript'));
  ok('xss: reply markup stays escaped', all.includes('&lt;script&gt;') && !/<script/i.test(all));
  ok('xss: pasted user markup stays escaped', all.includes('&lt;svg onload=alert(1)&gt;') && !/<svg/i.test(all));
  ok('xss: no HTML sink was touched during rendering', env.doc.violations.length === 0,
     env.doc.violations.join(' | '));
}

// A hostile error string from the worker also reaches the DOM via systemLine().
{
  const env = await bootConnected({ respond: async (m) => (m.type === 'panel.send' ? { ok: false, error: '<b>boom</b>' } : { ok: true }) });
  env.$('input').value = 'hi';
  fire(env.$('input'), 'keydown', { key: 'Enter' });
  await flush();
  const sys = env.bubbles().filter((x) => x.role === 'system');
  ok('xss: worker error text rendered as text', sys.length === 1 && sys[0].text.includes('<b>boom</b>'), JSON.stringify(sys));
  ok('xss: worker error touched no HTML sink', env.doc.violations.length === 0, env.doc.violations.join(' | '));
}

// ===========================================================================
// 4. IME-safe Enter
// ===========================================================================
{
  const env = await bootConnected();
  const input = env.$('input');

  // Composing a Chinese candidate: Enter confirms the candidate, it must not send.
  fire(input, 'compositionstart', {});
  input.value = '打开B站';
  const during = fire(input, 'keydown', { key: 'Enter', shiftKey: false, isComposing: true });
  await flush();
  ok('ime: Enter during composition does not send', env.ch.ofType('panel.send').length === 0,
     JSON.stringify(env.ch.ofType('panel.send')));
  ok('ime: Enter during composition leaves the draft intact', input.value === '打开B站', input.value);
  ok('ime: Enter during composition renders no bubble', env.bubbles().length === 0);
  ok('ime: Enter during composition does not preventDefault', during.defaultPrevented === false,
     'the IME needs the keystroke');

  // Same keystroke with isComposing set but no composition events seen -- some
  // IMEs fire keydown before compositionstart reaches the page.
  const bare = fire(input, 'keydown', { key: 'Enter', isComposing: true });
  await flush();
  ok('ime: isComposing alone is enough to suppress', env.ch.ofType('panel.send').length === 0);
  ok('ime: suppressed keystroke is left to the IME', bare.defaultPrevented === false);

  // Candidate committed; the next bare Enter is a real send.
  fire(input, 'compositionend', { data: '打开B站' });
  const after = fire(input, 'keydown', { key: 'Enter', shiftKey: false, isComposing: false });
  await flush();
  ok('ime: Enter after composition sends', env.ch.ofType('panel.send').length === 1,
     JSON.stringify(env.ch.ofType('panel.send')));
  ok('ime: real send carries the composed text', env.ch.ofType('panel.send')[0].text === '打开B站');
  ok('ime: real send preventDefaults the newline', after.defaultPrevented === true);
  ok('ime: real send clears the composer', input.value === '');

  // Shift+Enter is a newline, never a send.
  input.value = 'line one';
  const shifted = fire(input, 'keydown', { key: 'Enter', shiftKey: true, isComposing: false });
  await flush();
  ok('ime: Shift+Enter does not send', env.ch.ofType('panel.send').length === 1);
  ok('ime: Shift+Enter keeps the default newline', shifted.defaultPrevented === false);
  ok('ime: Shift+Enter keeps the draft', input.value === 'line one');

  // Whitespace-only is not a message.
  input.value = '   \n  ';
  fire(input, 'keydown', { key: 'Enter', isComposing: false });
  await flush();
  ok('ime: whitespace-only Enter does not send', env.ch.ofType('panel.send').length === 1);
}

// ===========================================================================
// 5. Transcript cap -- 200, dropping the OLDEST
// ===========================================================================
{
  const env = await boot({ echoChanges: false });
  for (let i = 1; i <= 205; i++) {
    env.ch.push({ type: 'chat.message', role: 'assistant', text: `m${i}`, ts: 1_700_000_000_000 + i });
  }
  // Asserted synchronously: this is the append+trim path, before any storage echo.
  const b = env.bubbles();
  ok('cap: transcript holds exactly 200', b.length === 200, `got ${b.length}`);
  ok('cap: oldest entries were dropped', b[0].text === 'm6', `first bubble is ${b[0] && b[0].text}`);
  ok('cap: newest entry survived', b[199].text === 'm205', `last bubble is ${b[199] && b[199].text}`);
  ok('cap: order preserved after trim', b[1].text === 'm7' && b[198].text === 'm204');
  ok('cap: no m1..m5 anywhere in the DOM',
     !b.some((x) => ['m1', 'm2', 'm3', 'm4', 'm5'].includes(x.text)));

  const last = env.ch.sets[env.ch.sets.length - 1].chatLog;
  ok('cap: persisted mirror is capped too', Array.isArray(last) && last.length === 200, `len=${last && last.length}`);
  ok('cap: persisted mirror drops the oldest', last[0].text === 'm6' && last[199].text === 'm205');

  await flush();
  ok('cap: DOM still mirrors the array one-for-one after settling',
     env.$('transcript').childElementCount === 200, `${env.$('transcript').childElementCount}`);
}

// Cold open with an over-long stored log: keep the newest 200.
{
  const stored = Array.from({ length: 300 }, (_, i) => ({ role: 'assistant', text: `s${i + 1}`, ts: 1000 + i }));
  const env = await boot({ storage: { chatLog: stored } });
  const b = env.bubbles();
  ok('cap: stored log truncated on load', b.length === 200, `got ${b.length}`);
  ok('cap: load keeps the newest slice', b[0].text === 's101' && b[199].text === 's300',
     `${b[0] && b[0].text}..${b[199] && b[199].text}`);
}

// Malformed entries are dropped rather than rendered.
{
  const env = await boot({ storage: { chatLog: [
    { role: 'assistant', text: 'good' },
    { role: 'assistant' },
    { text: 'no role' },
    null,
    { role: 'assistant', text: { toString: () => 'object' } },
  ] } });
  ok('cap: unrenderable entries filtered on load', env.bubbles().length === 1, JSON.stringify(env.bubbles()));
}

// A foreign write (second panel window, or the worker) is adopted and capped.
{
  const env = await boot({ echoChanges: false });
  const incoming = Array.from({ length: 250 }, (_, i) => ({ role: 'assistant', text: `x${i + 1}`, ts: 2000 + i }));
  env.ch.changed({ chatLog: { newValue: incoming } }, 'local');
  const b = env.bubbles();
  ok('cap: adopted foreign log is capped at 200', b.length === 200, `got ${b.length}`);
  ok('cap: adopted foreign log drops the oldest', b[0].text === 'x51' && b[199].text === 'x250');
  env.ch.changed({ chatLog: { newValue: incoming } }, 'sync');
  ok('cap: non-local storage area ignored', env.bubbles().length === 200);
}

// ===========================================================================
// 6. Optimistic echo -- the owner's words appear before the round trip
// ===========================================================================
{
  let settle = null;
  const env = await bootConnected({
    respond: (m) => (m.type === 'panel.send' ? new Promise((r) => { settle = r; }) : Promise.resolve({ ok: true })),
  });
  env.$('input').value = '打开B站搜蜘蛛侠';
  fire(env.$('input'), 'keydown', { key: 'Enter', isComposing: false });

  // No await at all: the bubble must already be in the DOM.
  const immediate = env.bubbles();
  ok('echo: user bubble is on screen before any await', immediate.length === 1,
     `got ${immediate.length} -- the echo must not wait on the service worker`);
  ok('echo: bubble carries the typed text', immediate[0] && immediate[0].text === '打开B站搜蜘蛛侠', JSON.stringify(immediate[0]));
  ok('echo: bubble is styled as the user', immediate[0] && immediate[0].role === 'user', String(immediate[0] && immediate[0].role));
  ok('echo: composer cleared immediately', env.$('input').value === '');

  await flush();
  ok('echo: request still in flight', settle !== null && env.ch.ofType('panel.send').length === 1);
  ok('echo: bubble survives the wait', env.bubbles().length === 1);
  ok('echo: panel.send carries the text', env.ch.ofType('panel.send')[0].text === '打开B站搜蜘蛛侠');

  settle({ ok: true });
  await flush();
  ok('echo: successful send adds no extra bubble', env.bubbles().length === 1, JSON.stringify(env.bubbles()));
  ok('echo: user message persisted', env.ch.sets.some((s) => Array.isArray(s.chatLog) && s.chatLog.some((m) => m.role === 'user')));
}

// A dead service worker must not retract the bubble; it explains itself beneath.
{
  const env = await bootConnected({
    respond: async (m) => {
      if (m.type !== 'panel.send') return { ok: true };
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  });
  env.$('input').value = 'hello';
  fire(env.$('input'), 'keydown', { key: 'Enter', isComposing: false });
  await flush();
  const b = env.bubbles();
  ok('echo: failed send keeps the user bubble', b.filter((x) => x.role === 'user').length === 1, JSON.stringify(b));
  ok('echo: failed send appends a system line', b.filter((x) => x.role === 'system').length === 1, JSON.stringify(b));
  ok('echo: system line sits after the user bubble', b.length === 2 && b[0].role === 'user' && b[1].role === 'system');
  ok('echo: asleep worker gets the retry wording', b[1] && /再发一次/.test(b[1].text), String(b[1] && b[1].text));
}

// ===========================================================================
// 7. Composer lock + panel wiring
// ===========================================================================
{
  const env = await boot({ storage: { status: { state: 'unconfigured' } } });
  ok('lock: composer disabled when unconfigured', env.$('input').disabled === true && env.$('send').disabled === true);
  ok('lock: notice is visible', env.$('composerNotice').hidden === false);
  ok('lock: notice explains why', /设置/.test(env.$('composerNotice').textContent), env.$('composerNotice').textContent);
  ok('lock: notice written as text', env.doc.violations.length === 0);

  // A send attempt while locked must be a no-op, not a queued message.
  env.$('input').value = 'x';
  fire(env.$('input'), 'keydown', { key: 'Enter', isComposing: false });
  await flush();
  ok('lock: locked composer sends nothing', env.ch.ofType('panel.send').length === 0);
  ok('lock: locked composer renders nothing', env.bubbles().length === 0);

  // The worker comes up.
  env.ch.push({ type: 'conn.status', status: { state: 'connected' } });
  ok('lock: composer unlocks on connect', env.$('input').disabled === false && env.$('send').disabled === false);
  ok('lock: notice hidden when connected', env.$('composerNotice').hidden === true);
  ok('lock: pill shows the connected label', env.$('connPill').textContent === '已连接', env.$('connPill').textContent);
}

{
  const env = await bootConnected();
  ok('wiring: runtime broadcast listener registered', env.ch.runtimeListeners.length === 1);
  ok('wiring: storage listener registered', env.ch.storageListeners.length === 1);
  ok('wiring: state requested on open', env.ch.ofType('panel.getState').length === 1);

  ok('wiring: empty hint visible on a cold panel',
     env.$('transcript').children.includes(env.$('emptyHint')));
  env.ch.push({ type: 'chat.message', role: 'assistant', text: 'hi', ts: Date.now() });
  ok('wiring: empty hint removed once a message lands',
     !env.$('transcript').children.includes(env.$('emptyHint')) && env.bubbles().length === 1);

  // Task dot reflects the broadcast state; unknown states fall back to idle.
  env.ch.push({ type: 'chat.status', state: 'working' });
  ok('wiring: task dot follows chat.status', env.$('taskDot').className === 'task-dot working', env.$('taskDot').className);
  env.ch.push({ type: 'chat.status', state: 'nonsense' });
  ok('wiring: unknown task state falls back to idle', env.$('taskDot').className === 'task-dot idle', env.$('taskDot').className);

  // Unknown/garbage broadcasts must not throw or render.
  const before = env.bubbles().length;
  env.ch.push({ type: 'something.else' });
  env.ch.push(null);
  env.ch.push({ type: 'chat.message', text: 123 });
  await flush();
  ok('wiring: junk broadcasts ignored', env.bubbles().length === before, `${env.bubbles().length} vs ${before}`);

  // Submitting the form (the send button) goes down the same path as Enter.
  env.$('input').value = 'via button';
  const submit = fire(env.$('composer'), 'submit', {});
  ok('wiring: form submit is intercepted', submit.defaultPrevented === true);
  await flush();
  ok('wiring: form submit sends', env.ch.ofType('panel.send').some((m) => m.text === 'via button'));

  // Settings toggle and the kill switch.
  fire(env.$('settingsToggle'), 'click', {});
  ok('wiring: settings panel opens', env.$('settings').hidden === false);
  ok('wiring: aria-expanded tracks the panel', env.$('settingsToggle').getAttribute('aria-expanded') === 'true',
     String(env.$('settingsToggle').getAttribute('aria-expanded')));
  await flush();
  ok('wiring: settings status written as text', typeof env.$('settingsStatus').textContent === 'string'
     && env.$('settingsStatus').textContent.includes('中继'), env.$('settingsStatus').textContent);

  fire(env.$('enabled'), 'change', { target: { checked: false } });
  await flush();
  ok('wiring: kill switch reaches the worker',
     env.ch.ofType('panel.setEnabled').some((m) => m.enabled === false));
  ok('wiring: kill switch restyles immediately', env.$('killRow').className === 'kill off', env.$('killRow').className);
  ok('wiring: no HTML sink touched by the whole session', env.doc.violations.length === 0,
     env.doc.violations.join(' | '));
}

// Settings are written with .value, never markup, and a bad relay URL is refused.
{
  const env = await bootConnected({ storage: { relayUrl: 'wss://relay.test/browser-remote/ext', token: 'abc' } });
  ok('settings: relay url restored into the field',
     env.$('relayUrl').value === 'wss://relay.test/browser-remote/ext', env.$('relayUrl').value);
  env.$('relayUrl').value = 'http://evil.test/';
  fire(env.$('save'), 'click', {});
  await flush();
  ok('settings: non-ws url refused', env.ch.ofType('panel.saveSettings').length === 0);
  ok('settings: refusal explained in the toast', env.$('toast').hidden === false && /wss/.test(env.$('toast').textContent),
     env.$('toast').textContent);
  env.$('relayUrl').value = 'wss://relay.test/browser-remote/ext';
  fire(env.$('save'), 'click', {});
  await flush();
  ok('settings: valid url saved through the worker', env.ch.ofType('panel.saveSettings').length === 1);
  ok('settings: toast never touches an HTML sink', env.doc.violations.length === 0, env.doc.violations.join(' | '));
}

} // end main()

// ===========================================================================
// report
// ===========================================================================
main().then(() => {
  if (failures.length) {
    console.error(`sidepanel: ${pass} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error('  FAIL', f);
    process.exit(1);
  }
  console.log(`sidepanel: ${pass} assertions passed`);
}, (err) => die('harness crashed before finishing', err));
