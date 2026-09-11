'use strict';
/*
 * Integration test: the REAL extension service worker against the REAL relay.
 *
 * extension/background.js is imported unmodified and run on a stubbed `chrome.*`
 * surface (storage.local, tabs, debugger, scripting, alarms, runtime, action).
 * The relay is the real one on loopback ports, and a real CDP client drives it.
 * Nothing is mocked between the agent frame and chrome.debugger.sendCommand --
 * that whole path, including both enforcement layers, executes for real.
 *
 * WHAT THIS FILE DOES NOT COVER, on purpose:
 *  - The injected page functions (pageSnapshot, pageLocateForClick, ...). They
 *    need a real DOM; chrome.scripting.executeScript here returns canned results
 *    shaped like theirs. A hand-rolled fake DOM would test the fake, not them --
 *    the real-Chrome round trip (PLAN.md task 3) is what exercises those.
 *  - Service-worker teardown/recycle. Node has no equivalent; the alarm backstop
 *    is asserted to exist, not to fire after a real eviction.
 *
 * The most valuable cases here are the ones the smoke test structurally cannot
 * reach: those that bypass the relay's chokepoint by calling ExtLane.request()
 * directly, i.e. "what does the browser still refuse if the relay is compromised
 * or simply runs ahead of this extension?". See "compromised relay" below.
 *
 * Run: node tools/test-extension.js
 */

const { start } = require('../relay/server');
const relayChokepoint = require('../relay/chokepoint');

const EXT_PORT = 3912;            // not 3802/3803 (live) and not 3902/3903 (smoke)
const AGENT_PORT = 3913;
const TOKEN = 'test-extension-token-not-a-secret';
const BASE = `http://127.0.0.1:${AGENT_PORT}`;
const TASK_TAB = 42;

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll rather than sleep: the worker's reconnects are timer-driven and jittered. */
async function waitFor(what, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function expectRejection(promise) {
  try {
    const result = await promise;
    return { rejected: false, message: `resolved with ${JSON.stringify(result)}` };
  } catch (err) {
    return { rejected: true, message: String(err.message || err) };
  }
}

// ---------------------------------------------------------------- chrome stub

/**
 * Enough of MV3's surface for background.js, plus `fire*` hooks so the test can
 * play Chrome: close a tab, navigate one, deliver a debugger event.
 */
function makeChromeStub() {
  const storage = new Map();
  const storageListeners = [];
  const tabs = new Map();
  const groups = new Map();
  const alarms = new Map();
  let nextTabId = 100;
  let nextGroupId = 500;
  const calls = {
    attach: [], detach: [], sendCommand: [], executeScript: [], openOptions: 0,
    created: [], grouped: [], ungrouped: [], groupUpdates: [], messages: [],
  };
  const debuggerEventListeners = [];
  const debuggerDetachListeners = [];
  const tabUpdatedListeners = [];
  const tabRemovedListeners = [];
  const runtimeMessageListeners = [];

  // Canned answers. Tests overwrite entries to drive a specific branch.
  const cdpResults = {
    'Page.navigate': { frameId: 'FRAME-1' },
    'Page.reload': {},
    'Page.enable': {},
    'Page.captureScreenshot': { data: 'ZmFrZS1zY3JlZW5zaG90' },
    'Input.dispatchMouseEvent': {},
    'Input.insertText': {},
    'Input.dispatchKeyEvent': {},
  };
  const injectResults = {
    pageSnapshot: {
      ok: true,
      url: 'https://example.com/docs',
      title: 'Docs',
      readyState: 'complete',
      elements: [{ selector: '#go', tag: 'a', label: 'Go' }],
      elementsTotal: 1,
      text: 'hello docs',
      truncated: false,
    },
    pageLocateForClick: {
      ok: true, x: 12, y: 34, covered: false, coveredBy: null,
      href: null, tag: 'button', disabled: false,
    },
    pagePrepareFill: { ok: true, tag: 'input', type: 'text', focused: true },
    // A focused text input inside a harmless form. Tests overwrite formAction to
    // drive the blocklist branch.
    pagePrepareKey: { ok: true, tag: 'input', type: 'text', formAction: 'https://example.com/search' },
    pageFinishFill: { ok: true, value: 'typed text' },
    pageCheckState: { ok: true, satisfied: true, matches: 1 },
  };
  // Tabs the extension must refuse to attach to are still listed by Chrome.
  const attachFailures = new Map();

  function fireStorageChange(changes) {
    for (const fn of storageListeners.slice()) {
      try { fn(changes, 'local'); } catch (err) { console.error('storage listener threw', err); }
    }
  }

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const want = keys == null ? [...storage.keys()]
            : Array.isArray(keys) ? keys
            : typeof keys === 'string' ? [keys]
            : Object.keys(keys);
          const out = {};
          for (const k of want) if (storage.has(k)) out[k] = storage.get(k);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: storage.get(k), newValue: v };
            storage.set(k, v);
          }
          fireStorageChange(changes);
        },
        async remove(key) {
          const keys = Array.isArray(key) ? key : [key];
          const changes = {};
          for (const k of keys) {
            if (!storage.has(k)) continue;
            changes[k] = { oldValue: storage.get(k) };
            storage.delete(k);
          }
          if (Object.keys(changes).length) fireStorageChange(changes);
        },
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },

    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        return { ...tabs.get(id) };
      },
      // Chrome filters by the properties present on the query object; session.js
      // uses both the match-everything form and a groupId lookup.
      async query(q = {}) {
        return [...tabs.values()]
          .filter((t) => (q.groupId === undefined ? true : (t.groupId ?? -1) === q.groupId))
          .filter((t) => (q.active === undefined ? true : Boolean(t.active) === q.active))
          .map((t) => ({ ...t }));
      },
      async create({ url, active }) {
        const tab = {
          id: nextTabId++, url, title: `New: ${url}`, active: Boolean(active),
          status: 'complete', windowId: 1, groupId: -1, lastAccessed: Date.now(),
        };
        if (tab.active) for (const t of tabs.values()) t.active = false;
        tabs.set(tab.id, tab);
        calls.created.push({ url, active: Boolean(active), id: tab.id });
        return { ...tab };
      },
      async update(id, props) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        if (props.active) for (const t of tabs.values()) t.active = false;
        tabs.set(id, { ...tabs.get(id), ...props });
        return { ...tabs.get(id) };
      },
      async group({ tabIds }) {
        const id = nextGroupId++;
        groups.set(id, { id, title: '', color: 'grey', collapsed: false });
        for (const tid of tabIds) if (tabs.has(tid)) tabs.get(tid).groupId = id;
        calls.grouped.push({ tabIds: [...tabIds], groupId: id });
        return id;
      },
      async ungroup(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const tid of list) if (tabs.has(tid)) tabs.get(tid).groupId = -1;
        calls.ungrouped.push([...list]);
      },
      onUpdated: { addListener: (fn) => tabUpdatedListeners.push(fn) },
      onRemoved: { addListener: (fn) => tabRemovedListeners.push(fn) },
    },

    tabGroups: {
      async query(q = {}) {
        return [...groups.values()]
          .filter((g) => (q.title === undefined ? true : g.title === q.title))
          .map((g) => ({ ...g }));
      },
      async update(id, props) {
        if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
        groups.set(id, { ...groups.get(id), ...props });
        calls.groupUpdates.push({ id, ...props });
        return { ...groups.get(id) };
      },
    },

    windows: {
      async update(id, props) { return { id, ...props }; },
    },

    debugger: {
      async attach(target, version) {
        const fail = attachFailures.get(target.tabId);
        if (fail) throw new Error(fail);
        calls.attach.push({ ...target, version });
      },
      async detach(target) {
        calls.detach.push({ ...target });
      },
      async sendCommand(target, method, params) {
        calls.sendCommand.push({ tabId: target.tabId, method, params });
        if (!(method in cdpResults)) throw new Error(`stub has no canned result for ${method}`);
        return cdpResults[method];
      },
      onEvent: { addListener: (fn) => debuggerEventListeners.push(fn) },
      onDetach: { addListener: (fn) => debuggerDetachListeners.push(fn) },
    },

    scripting: {
      async executeScript({ target, world, func, args }) {
        calls.executeScript.push({ tabId: target.tabId, world, func, funcName: func.name, args });
        const canned = injectResults[func.name];
        if (!canned) throw new Error(`stub has no canned result for injected ${func.name}`);
        return [{ result: canned }];
      },
    },

    alarms: {
      create(name, opts) { alarms.set(name, { name, ...opts }); },
      async get(name) { return alarms.get(name); },
      onAlarm: { addListener: () => {} },
    },

    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      // Recorded, not ignored: the side panel and the options page reach the
      // worker through here, and `panel.saveSettings` / `reconnect` are two of
      // the three paths that retire a live socket. See sendRuntimeMessage.
      onMessage: { addListener: (fn) => runtimeMessageListeners.push(fn) },
      openOptionsPage() { calls.openOptions++; },
      // The side panel is absent in this harness, so a real Chrome would reject
      // here ("no receiving end"). background.js swallows that; record and
      // resolve, since the assertions below only care that it was attempted.
      async sendMessage(message) { calls.messages.push(message); },
    },

    action: { onClicked: { addListener: () => {} } },
  };

  return {
    chrome,
    calls,
    alarms,
    cdpResults,
    injectResults,
    attachFailures,
    // --- test-side controls -------------------------------------------------
    groups,
    setTab(tab) { tabs.set(tab.id, { groupId: -1, windowId: 1, ...tab }); },
    patchTab(id, patch) { tabs.set(id, { ...tabs.get(id), ...patch }); },
    getTab(id) { return tabs.get(id); },
    dropTab(id) { tabs.delete(id); },
    groupOf(id) { return groups.get(id); },
    seedStorage(obj) { for (const [k, v] of Object.entries(obj)) storage.set(k, v); },
    readStorage(k) { return storage.get(k); },
    fireTabUpdated(id, changeInfo) {
      for (const fn of tabUpdatedListeners.slice()) fn(id, changeInfo, { ...tabs.get(id) });
    },
    fireTabRemoved(id) {
      this.dropTab(id);
      for (const fn of tabRemovedListeners.slice()) fn(id, { isWindowClosing: false });
    },
    fireDebuggerEvent(source, method, params) {
      for (const fn of debuggerEventListeners.slice()) fn(source, method, params);
    },
    fireDebuggerDetach(source, reason) {
      for (const fn of debuggerDetachListeners.slice()) fn(source, reason);
    },
    /**
     * Play the side panel / options page: deliver a runtime message and wait for
     * the worker's answer. background.js registers TWO onMessage listeners and
     * each returns false for types it does not own, so the message goes to both
     * and the first sendResponse wins -- exactly Chrome's dispatch.
     */
    sendRuntimeMessage(message) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let willRespond = false;
        const respond = (response) => { if (!settled) { settled = true; resolve(response); } };
        for (const fn of runtimeMessageListeners.slice()) {
          if (fn(message, {}, respond) === true) willRespond = true;
        }
        if (settled) return;
        if (!willRespond) { resolve(undefined); return; }
        const timer = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error(`no response to ${message.type}`)); }
        }, 5000);
        if (timer.unref) timer.unref();
      });
    },
  };
}

// ---------------------------------------------------------------- CDP client

function cdpClient(WS, url) {
  const ws = new WS(url);
  const waiters = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ready.catch(() => {});
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  });
  return {
    ws,
    ready,
    send(method, params) {
      const mid = ++id;
      return new Promise((resolve) => {
        waiters.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      });
    },
    close() { try { ws.close(); } catch { /* gone */ } },
  };
}

// ---------------------------------------------------------------- run

(async () => {
  // The service worker dials out the moment it is imported, so the relay has to
  // be listening and the settings seeded BEFORE the import below.
  const relay = await start({ token: TOKEN, extPort: EXT_PORT, agentPort: AGENT_PORT });

  const stub = makeChromeStub();
  stub.setTab({ id: TASK_TAB, url: 'https://example.com/docs', title: 'Docs', active: true, status: 'complete' });
  stub.setTab({ id: 7, url: 'chrome://settings', title: 'Settings', active: false, status: 'complete' });
  stub.setTab({ id: 9, url: 'https://other.example.com/', title: 'Other', active: false, status: 'complete' });
  stub.seedStorage({
    relayUrl: `ws://127.0.0.1:${EXT_PORT}/ext`,
    token: TOKEN,
    // There is no arm gate any more: what the extension drives is the CURRENT
    // TASK's tab, and a task is what _br.openTarget creates. Seeding one here
    // puts the worker in mid-task so the CDP path below has something to drive;
    // the no-task and openTarget cases are exercised further down.
    taskTabId: TASK_TAB,
    taskGroupId: null,
    taskState: 'working',
  });

  globalThis.chrome = stub.chrome;
  // Node 22 ships a spec WebSocket (subprotocols, onopen/onmessage, event.data),
  // which is what the worker is written against. `ws` is the fallback.
  const WS = globalThis.WebSocket || require('ws');
  if (!globalThis.WebSocket) globalThis.WebSocket = WS;

  const events = [];
  relay.ext.on('event', (frame) => events.push(frame));

  // === static invariants =====================================================
  const policy = await import('../extension/policy.js');
  const actions = await import('../extension/actions.js');

  const extraCdp = [...policy.ALLOWED_CDP_METHODS].filter((m) => !relayChokepoint.ALLOWED_CDP_METHODS.has(m));
  const extraBr = [...policy.ALLOWED_BR_METHODS].filter((m) => !relayChokepoint.ALLOWED_BR_METHODS.has(m));
  ok('extension CDP allowlist is a subset of the relay\'s', extraCdp.length === 0, extraCdp.join(','));
  ok('extension _br allowlist is a subset of the relay\'s', extraBr.length === 0, extraBr.join(','));
  ok('advertised capabilities match the _br allowlist exactly',
     actions.CAPABILITIES.length === policy.ALLOWED_BR_METHODS.size &&
     actions.CAPABILITIES.every((c) => policy.ALLOWED_BR_METHODS.has(c)),
     actions.CAPABILITIES.join(','));
  ok('every advertised capability passes the extension allowlist',
     actions.CAPABILITIES.every((c) => policy.methodAllowed(c) === null));
  ok('an unknown _br method is default-denied', /not in the extension allowlist/.test(String(policy.methodAllowed('_br.bogus'))));

  // === the worker boots and dials out ========================================
  await import('../extension/background.js');

  await waitFor('the extension to connect', () => relay.ext.isConnected());
  ok('service worker dialled out and the relay accepted it', relay.ext.isConnected());
  ok('keepalive alarm was created', Boolean(stub.alarms.get('zylos-browser-remote-keepalive')));

  await waitFor('hello', () => relay.ext.tabs.length === 1);
  ok('hello reports ONLY the task tab', relay.ext.tabs.length === 1 && relay.ext.tabs[0].id === TASK_TAB,
     JSON.stringify(relay.ext.tabs));
  ok('hello marks that tab as the task tab', relay.ext.tabs[0].task === true);
  ok('hello carries the capability list', (relay.ext.status().capabilities || []).includes('_br.snapshot'));
  await waitFor('status', () => stub.readStorage('status')?.state === 'connected');
  ok('status in storage.local reads connected', stub.readStorage('status').state === 'connected');

  // === a real CDP client drives it through the relay ==========================
  const leaseRes = await (await fetch(`${BASE}/lease`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 120_000 }),
  })).json();
  ok('lease targets the task tab', leaseRes.ok === true && leaseRes.tabId === TASK_TAB, JSON.stringify(leaseRes));

  const client = cdpClient(WS, leaseRes.cdpUrl);
  await client.ready;
  await waitFor('chrome.debugger.attach', () => stub.calls.attach.length === 1);
  ok('agent attach reached chrome.debugger.attach on the task tab',
     stub.calls.attach[0].tabId === TASK_TAB && stub.calls.attach[0].version === '1.3',
     JSON.stringify(stub.calls.attach));

  const nav = await client.send('Page.navigate', { url: 'https://example.com/docs/intro' });
  const navCall = stub.calls.sendCommand.find((c) => c.method === 'Page.navigate');
  ok('Page.navigate travelled agent -> relay -> extension -> chrome.debugger',
     Boolean(navCall) && navCall.params.url === 'https://example.com/docs/intro' && navCall.tabId === TASK_TAB,
     JSON.stringify(navCall));
  ok('the CDP result came back to the agent', nav.result && nav.result.frameId === 'FRAME-1', JSON.stringify(nav));

  const snap = await client.send('_br.snapshot', {});
  const snapInject = stub.calls.executeScript.find((c) => c.funcName === 'pageSnapshot');
  ok('_br.snapshot injected the fixed pageSnapshot function', Boolean(snapInject));
  ok('injection runs in the ISOLATED world', snapInject && snapInject.world === 'ISOLATED');
  ok('injected args are plain JSON data, never code',
     snapInject && JSON.stringify(JSON.parse(JSON.stringify(snapInject.args))) === JSON.stringify(snapInject.args));
  ok('_br.snapshot returned the page shape to the agent',
     snap.result && snap.result.title === 'Docs' && Array.isArray(snap.result.elements) && snap.result.ok === undefined,
     JSON.stringify(snap.result));

  const click = await client.send('_br.click', { selector: '#go' });
  const mouse = stub.calls.sendCommand.filter((c) => c.method === 'Input.dispatchMouseEvent');
  ok('_br.click dispatched moved/pressed/released with extension-computed coordinates',
     mouse.length === 3 && mouse.every((m) => m.params.x === 12 && m.params.y === 34),
     JSON.stringify(mouse.map((m) => m.params.type)));
  ok('_br.click reported what it clicked', click.result && click.result.clicked === '#go', JSON.stringify(click));

  const fill = await client.send('_br.fill', { selector: '#q', text: 'typed text' });
  const insert = stub.calls.sendCommand.find((c) => c.method === 'Input.insertText');
  ok('_br.fill typed via Input.insertText', Boolean(insert) && insert.params.text === 'typed text');
  ok('_br.fill reported the resulting value', fill.result && fill.result.value === 'typed text', JSON.stringify(fill));

  // _br.press: the agent sends a key NAME, never a descriptor. Raw
  // Input.dispatchKeyEvent from the agent stays banned (asserted further down);
  // this lane exists so the extension can own the key table.
  const press = await client.send('_br.press', { key: 'Enter', selector: '#q' });
  const keyEvents = stub.calls.sendCommand.filter((c) => c.method === 'Input.dispatchKeyEvent');
  ok('_br.press dispatched exactly one keyDown + keyUp pair',
     keyEvents.length === 2 && keyEvents[0].params.type === 'keyDown' && keyEvents[1].params.type === 'keyUp',
     JSON.stringify(keyEvents.map((k) => k.params.type)));
  ok('_br.press sent the extension-owned Enter descriptor, not anything the agent supplied',
     keyEvents[0] && keyEvents[0].params.key === 'Enter' && keyEvents[0].params.code === 'Enter'
     && keyEvents[0].params.windowsVirtualKeyCode === 13 && keyEvents[0].params.text === '\r',
     JSON.stringify(keyEvents[0] && keyEvents[0].params));
  const keyInject = stub.calls.executeScript.find((c) => c.funcName === 'pagePrepareKey');
  ok('_br.press prepared focus through the fixed injected function in the ISOLATED world',
     Boolean(keyInject) && keyInject.world === 'ISOLATED' && keyInject.args[0].selector === '#q',
     JSON.stringify(keyInject && keyInject.args));
  ok('_br.press reported what it pressed', press.result && press.result.pressed === 'Enter', JSON.stringify(press));

  // Anything outside NAMED_KEYS is refused, and the refusal has to name the
  // three accepted values -- an agent that guessed 'Return' needs to be told.
  const badKey = await expectRejection(relay.ext.request({ method: '_br.press', params: { key: 'Return' }, tabId: TASK_TAB }));
  ok('_br.press refuses a key name outside the table',
     badKey.rejected && /Enter/.test(badKey.message) && /Tab/.test(badKey.message) && /Escape/.test(badKey.message),
     badKey.message);
  const modifierKey = await expectRejection(relay.ext.request({ method: '_br.press', params: { key: 'Enter', modifiers: 2 }, tabId: TASK_TAB }));
  ok('_br.press ignores an agent-supplied modifier rather than forwarding it',
     !modifierKey.rejected
     || !stub.calls.sendCommand.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params.modifiers),
     modifierKey.message);
  ok('a refused key name never reached chrome.debugger',
     stub.calls.sendCommand.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'Return').length === 0);

  // Enter submits, and the form's action is the only place that destination is
  // visible -- it is in neither the params nor the tab URL the relay screened.
  const goodAction = stub.injectResults.pagePrepareKey.formAction;
  const keyEventsBefore = stub.calls.sendCommand.filter((c) => c.method === 'Input.dispatchKeyEvent').length;
  stub.injectResults.pagePrepareKey = { ...stub.injectResults.pagePrepareKey, formAction: 'https://shop.example.com/checkout' };
  const pressBlocked = await expectRejection(relay.ext.request({ method: '_br.press', params: { key: 'Enter' }, tabId: TASK_TAB }));
  ok('_br.press refuses when the focused field submits to a blocklisted URL',
     pressBlocked.rejected && /blocklist/.test(pressBlocked.message), pressBlocked.message);
  ok('the blocklisted-form press dispatched no key event at all',
     stub.calls.sendCommand.filter((c) => c.method === 'Input.dispatchKeyEvent').length === keyEventsBefore);
  stub.injectResults.pagePrepareKey = { ...stub.injectResults.pagePrepareKey, formAction: goodAction };

  const shot = await client.send('_br.screenshot', { format: 'jpeg' });
  ok('_br.screenshot came back as base64 with a byte count',
     shot.result && shot.result.format === 'jpeg' && shot.result.bytes === shot.result.data.length,
     JSON.stringify(shot.result && { ...shot.result, data: '<omitted>' }));

  const list = await client.send('_br.listTabs', {});
  const taskFlags = (list.result?.tabs || []).filter((t) => t.task).map((t) => t.id);
  ok('_br.listTabs lists every tab but marks only the task one',
     list.result?.tabs?.length === 3 && taskFlags.length === 1 && taskFlags[0] === TASK_TAB,
     JSON.stringify(taskFlags));

  // === compromised relay: what the browser refuses on its own =================
  // These bypass the chokepoint entirely by calling ExtLane.request() directly --
  // exactly what a compromised or newer relay could do. The extension is the last
  // line, and the assertions below are the reason policy.js/guard.js are duplicated
  // on this side at all.
  const sendCommandsBefore = stub.calls.sendCommand.length;

  const evil = await expectRejection(relay.ext.request({ method: 'Runtime.evaluate', params: { expression: '1+1' }, tabId: TASK_TAB }));
  ok('extension refuses Runtime.evaluate even when the relay forwards it',
     evil.rejected && /banned/.test(evil.message), evil.message);

  const rawInput = await expectRejection(relay.ext.request({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1 }, tabId: TASK_TAB }));
  ok('extension refuses raw Input.* from the relay',
     rawInput.rejected && /banned/.test(rawInput.message), rawInput.message);

  const foreignTab = await expectRejection(relay.ext.request({ method: 'Page.navigate', params: { url: 'https://other.example.com/' }, tabId: 9 }));
  ok('extension refuses a tab that is not the current task\'s',
     foreignTab.rejected && /not the task tab/.test(foreignTab.message), foreignTab.message);

  const blocked = await expectRejection(relay.ext.request({ method: '_br.navigate', params: { url: 'https://shop.example.com/checkout' }, tabId: TASK_TAB }));
  ok('extension refuses a blocklisted destination on its own',
     blocked.rejected && /blocklist/.test(blocked.message), blocked.message);

  // The task tab navigates itself somewhere dangerous and the relay's cached URL
  // has not caught up. The relay would allow; the extension re-reads the live URL.
  stub.patchTab(TASK_TAB, { url: 'https://shop.example.com/checkout' });
  ok('the relay would have allowed this frame against its stale cached URL',
     relayChokepoint.check({ method: '_br.click', params: { selector: '#buy' }, tabUrl: 'https://example.com/docs' }) === null);
  const stale = await expectRejection(relay.ext.request({ method: '_br.click', params: { selector: '#buy' }, tabId: TASK_TAB }));
  ok('extension re-screens against the tab\'s ACTUAL current URL and refuses',
     stale.rejected && /blocklist/.test(stale.message), stale.message);
  stub.patchTab(TASK_TAB, { url: 'https://example.com/docs' });

  ok('no refused frame reached chrome.debugger', stub.calls.sendCommand.length === sendCommandsBefore,
     JSON.stringify(stub.calls.sendCommand.slice(sendCommandsBefore)));

  client.close();

  // === events ================================================================
  events.length = 0;
  stub.fireDebuggerEvent({ tabId: TASK_TAB }, 'Page.loadEventFired', { timestamp: 1 });
  await waitFor('the event to reach the relay', () => events.length === 1);
  ok('a debugger event from the attached tab reaches the relay', events[0].method === 'Page.loadEventFired');

  stub.fireDebuggerEvent({ tabId: 9 }, 'Page.loadEventFired', { timestamp: 2 });
  await sleep(100);
  ok('an event from a tab we are not driving is dropped', events.length === 1, JSON.stringify(events.map((e) => e.method)));

  stub.fireDebuggerEvent({ tabId: TASK_TAB }, 'Network.responseReceived', { body: 'x'.repeat(70_000) });
  await sleep(150);
  ok('an oversized event frame is dropped, not truncated', events.length === 1, String(events.length));
  ok('the drop is recorded in status', stub.readStorage('status')?.lastDroppedEvent === 'Network.responseReceived',
     JSON.stringify(stub.readStorage('status')));

  // === between tasks: no tab, and that is a normal state =====================
  // The old model's "unarmed" fault is now the resting state. Tabless methods
  // must still answer, page-touching ones must refuse with an actionable
  // message, and the relay must stop handing out leases.
  await stub.chrome.storage.local.remove('taskTabId');
  await waitFor('the relay to be told there is no task tab', () => relay.ext.tabs.length === 0);
  ok('ending a task pushes an empty tab list, so the relay stops leasing', relay.ext.tabs.length === 0);

  const info = await relay.ext.request({ method: '_br.info', tabId: null });
  ok('_br.info answers with no task tab and nothing attached',
     info.taskTabId === null && Array.isArray(info.capabilities), JSON.stringify(info));

  const noTask = await expectRejection(relay.ext.request({ method: 'Page.navigate', params: { url: 'https://example.com/' }, tabId: null }));
  ok('a page-touching method is refused when no task is open, and says how to start one',
     noTask.rejected && /no active task tab/.test(noTask.message) && /_br\.openTarget/.test(noTask.message),
     noTask.message);

  // === session methods: openTarget / setState / endTask / clearFinished ======
  // The whole point of the redesign: the agent picks the tab, the owner does not
  // have to authorize one. These run against the real session.js on the stub.

  // A blocklisted destination must be refused BEFORE a tab exists. Getting this
  // wrong means navigating the owner's browser to a checkout page and only then
  // declining to click -- the refusal would be worthless.
  const tabsBeforeRefusal = stub.calls.created.length;
  const badTarget = await expectRejection(
    relay.ext.request({ method: '_br.openTarget', params: { url: 'https://shop.example.com/checkout' }, tabId: null }));
  ok('_br.openTarget refuses a blocklisted URL',
     badTarget.rejected && /blocklist/.test(badTarget.message), badTarget.message);
  ok('the refused target never became a tab', stub.calls.created.length === tabsBeforeRefusal,
     JSON.stringify(stub.calls.created.slice(tabsBeforeRefusal)));

  // Reuse: tab 9 is already on other.example.com, so no new tab and -- because
  // it is the owner's own tab -- no regrouping of his tab strip.
  const groupsBeforeReuse = stub.calls.grouped.length;
  const reuse = await relay.ext.request({
    method: '_br.openTarget', params: { url: 'https://other.example.com/some/page' }, tabId: null });
  ok('_br.openTarget reuses a tab already on that site instead of opening one',
     reuse.reused === true && reuse.tabId === 9, JSON.stringify(reuse));
  ok('a reused tab is left in the owner\'s layout, not pulled into a group',
     stub.calls.grouped.length === groupsBeforeReuse && reuse.groupId === null,
     JSON.stringify({ grouped: stub.calls.grouped.length, groupId: reuse.groupId }));
  ok('the reused tab was focused', stub.getTab(9).active === true);
  await waitFor('the reused tab to reach the relay', () => relay.ext.tabs[0]?.id === 9);
  ok('the relay now leases the reused tab', relay.ext.tabs.length === 1 && relay.ext.tabs[0].id === 9,
     JSON.stringify(relay.ext.tabs));

  // A site nothing is open on: new tab, grouped, green.
  const opened = await relay.ext.request({
    method: '_br.openTarget', params: { url: 'https://docs.example.org/guide' }, tabId: null });
  ok('_br.openTarget opens a new tab when no tab is on that site',
     opened.reused === false && stub.calls.created.at(-1)?.url === 'https://docs.example.org/guide',
     JSON.stringify(opened));
  ok('the new tab was put in a group', opened.groupId != null && stub.getTab(opened.tabId).groupId === opened.groupId,
     JSON.stringify({ groupId: opened.groupId, tabGroup: stub.getTab(opened.tabId)?.groupId }));
  ok('the group is green and labelled working',
     stub.groupOf(opened.groupId)?.color === 'green' && /工作中/.test(stub.groupOf(opened.groupId)?.title || ''),
     JSON.stringify(stub.groupOf(opened.groupId)));
  ok('opening a target attached the debugger to it',
     stub.calls.attach.at(-1)?.tabId === opened.tabId, JSON.stringify(stub.calls.attach.at(-1)));

  // waiting = yellow, and the panel is told.
  stub.calls.messages.length = 0;
  const waitState = await relay.ext.request({ method: '_br.setState', params: { state: 'waiting' }, tabId: null });
  ok('_br.setState waiting recolours the group yellow',
     stub.groupOf(opened.groupId)?.color === 'yellow' && /等待你/.test(stub.groupOf(opened.groupId)?.title || ''),
     JSON.stringify(stub.groupOf(opened.groupId)));
  ok('_br.setState reports the new state back', waitState.state === 'waiting', JSON.stringify(waitState));
  ok('the side panel is told the state changed',
     stub.calls.messages.some((m) => m.type === 'chat.status' && m.state === 'waiting'),
     JSON.stringify(stub.calls.messages));

  const badState = await expectRejection(
    relay.ext.request({ method: '_br.setState', params: { state: 'chartreuse' }, tabId: null }));
  ok('_br.setState refuses a colour outside working/waiting/stopped', badState.rejected, badState.message);

  // endTask: debugger goes away, the group goes grey, the tab STAYS.
  const detachesBeforeEnd = stub.calls.detach.length;
  const ended = await relay.ext.request({ method: '_br.endTask', params: {}, tabId: null });
  ok('_br.endTask detaches the debugger so the banner disappears',
     stub.calls.detach.length > detachesBeforeEnd, `${detachesBeforeEnd} -> ${stub.calls.detach.length}`);
  ok('_br.endTask greys the group', stub.groupOf(opened.groupId)?.color === 'grey',
     JSON.stringify(stub.groupOf(opened.groupId)));
  ok('_br.endTask does NOT close the tab', Boolean(stub.getTab(opened.tabId)), String(ended.tabId));
  await waitFor('the empty push after endTask', () => relay.ext.tabs.length === 0);
  ok('after endTask the relay has no tab to lease', relay.ext.tabs.length === 0);

  // clearFinished tidies grey groups only, and still never closes a tab.
  const ownGroup = await stub.chrome.tabs.group({ tabIds: [] });
  await stub.chrome.tabGroups.update(ownGroup, { title: 'My own research', color: 'blue' });
  const cleared = await relay.ext.request({ method: '_br.clearFinished', params: {}, tabId: null });
  ok('_br.clearFinished ungrouped the finished group', cleared.cleared === 1, JSON.stringify(cleared));
  ok('_br.clearFinished left the tab open', Boolean(stub.getTab(opened.tabId)));
  ok('_br.clearFinished ungrouped that tab', stub.getTab(opened.tabId).groupId === -1,
     String(stub.getTab(opened.tabId).groupId));
  ok('_br.clearFinished never touches a group the owner made himself',
     stub.groupOf(ownGroup)?.title === 'My own research', JSON.stringify(stub.groupOf(ownGroup)));

  // === a tabless session must be DRIVABLE, not merely mintable ===============
  // Everything above reaches the extension through relay.ext.request(), which
  // skips the agent lane. That is exactly how the first real-Chrome run got
  // through a green suite and then could not take one step: the agent lane's
  // connect handshake eagerly asked the extension to attach, the extension
  // answered "no active task tab: call _br.openTarget first", and the relay
  // closed the socket -- before the agent could send _br.openTarget, the one
  // call that creates the tab. Chicken and egg, and no site was reachable.
  //
  // So drive it the way the agent really does: zero tabs -> /json/list -> CDP
  // socket -> _br.openTarget -> a page-touching command. Asserting the lease is
  // minted and carries a webSocketDebuggerUrl (test-chat-bridge) is not enough;
  // that passed throughout.
  await fetch(`${BASE}/lease/${leaseRes.leaseId}`, { method: 'DELETE' });
  const tabless = await (await fetch(`${BASE}/json/list`)).json();
  ok('with no tab, /json/list still offers a session to connect to',
     tabless.length === 1 && tabless[0].zylosHasTab === false && Boolean(tabless[0].webSocketDebuggerUrl),
     JSON.stringify(tabless));

  const fresh = cdpClient(WS, tabless[0].webSocketDebuggerUrl);
  await fresh.ready;
  // If the handshake deadlocks, the relay closes the socket and nothing ever
  // answers -- so time out rather than hang the suite for good.
  const timeout = (p, ms = 4000) =>
    Promise.race([p, sleep(ms).then(() => ({ error: { message: `timed out after ${ms}ms` } }))]);

  const createdBefore = stub.calls.created.length;
  const firstOpen = await timeout(fresh.send('_br.openTarget', { url: 'https://fresh.example.net/start' }));
  ok('an agent that connects with no tab open can still call _br.openTarget',
     !firstOpen.error && firstOpen.result?.tabId != null, JSON.stringify(firstOpen));
  ok('_br.openTarget over the agent lane really opened the tab',
     stub.calls.created.length === createdBefore + 1 &&
     stub.calls.created.at(-1)?.url === 'https://fresh.example.net/start',
     JSON.stringify(stub.calls.created.at(-1)));
  ok('the tab it opened got the debugger attached',
     stub.calls.attach.at(-1)?.tabId === firstOpen.result?.tabId, JSON.stringify(stub.calls.attach.at(-1)));

  // The half that proves the session is usable and not just alive: a command
  // that touches the page, on a tab this same socket created moments ago.
  // Guarded so a regression reports both failures instead of crashing the run.
  const freshTabId = firstOpen.result?.tabId ?? null;
  if (freshTabId == null) {
    ok('and can then drive the tab it just opened', false, 'no tab was opened to drive');
  } else {
    await waitFor('the new task tab to reach the relay', () => relay.ext.tabs[0]?.id === freshTabId);
    const firstNav = await timeout(fresh.send('Page.navigate', { url: 'https://fresh.example.net/next' }));
    ok('and can then drive the tab it just opened',
       !firstNav.error && stub.calls.sendCommand.at(-1)?.tabId === freshTabId,
       JSON.stringify({ firstNav, last: stub.calls.sendCommand.at(-1) }));
  }
  fresh.close();
  await relay.ext.request({ method: '_br.endTask', params: {}, tabId: null });
  await waitFor('the tabless state to come back', () => relay.ext.tabs.length === 0);


  // Back to the seeded task tab for the lifecycle sections below.
  await stub.chrome.storage.local.set({ taskTabId: TASK_TAB, taskGroupId: null, taskState: 'working' });
  await waitFor('the task tab to be re-announced', () => relay.ext.tabs.length === 1);
  ok('setting a task tab pushes it back to the relay', relay.ext.tabs[0].id === TASK_TAB);

  // === tab lifecycle =========================================================
  stub.patchTab(TASK_TAB, { url: 'https://example.com/docs/other', title: 'Other page' });
  stub.fireTabUpdated(TASK_TAB, { url: 'https://example.com/docs/other' });
  await waitFor('the state push', () => relay.ext.tabUrl(TASK_TAB) === 'https://example.com/docs/other');
  ok('a self-navigating page refreshes the relay\'s cached URL',
     relay.ext.tabUrl(TASK_TAB) === 'https://example.com/docs/other');

  // === attaching to a forbidden tab ==========================================
  await stub.chrome.storage.local.set({ taskTabId: 7 });     // chrome://settings
  await sleep(100);
  const forbidden = await expectRejection(relay.ext.request({ type: 'attach', tabId: 7 }));
  ok('extension refuses to attach the debugger to a chrome:// tab',
     forbidden.rejected && /cannot attach/.test(forbidden.message), forbidden.message);
  // Same refusal via the session lane: a chrome:// URL must not become a task
  // either, or openTarget would be a way around tabAttachAllowed.
  const forbiddenTarget = await expectRejection(
    relay.ext.request({ method: '_br.openTarget', params: { url: 'chrome://settings' }, tabId: null }));
  ok('_br.openTarget refuses a chrome:// URL', forbiddenTarget.rejected, forbiddenTarget.message);
  await stub.chrome.storage.local.set({ taskTabId: TASK_TAB });
  await sleep(100);

  // === kill switch ===========================================================
  // Re-attach first: _br.endTask above dropped the debugger, and "the kill
  // switch detaches" only means anything against a LIVE attachment.
  await relay.ext.request({ method: '_br.snapshot', params: {}, tabId: TASK_TAB });
  ok('a command re-attached the debugger to the task tab',
     stub.calls.attach.at(-1)?.tabId === TASK_TAB, JSON.stringify(stub.calls.attach.at(-1)));
  const detachesBefore = stub.calls.detach.length;
  await stub.chrome.storage.local.set({ enabled: false });
  await waitFor('the socket to close', () => !relay.ext.isConnected());
  ok('the kill switch closes the socket rather than holding one open', !relay.ext.isConnected());
  ok('the kill switch detaches the debugger', stub.calls.detach.length > detachesBefore,
     `${detachesBefore} -> ${stub.calls.detach.length}`);
  await sleep(1500);
  ok('it stays disconnected while disabled', !relay.ext.isConnected());
  ok('status reads disabled', stub.readStorage('status')?.state === 'disabled', JSON.stringify(stub.readStorage('status')));

  await stub.chrome.storage.local.set({ enabled: true });
  await waitFor('reconnect', () => relay.ext.isConnected(), 10_000);
  ok('re-enabling dials back out', relay.ext.isConnected());
  await waitFor('hello after reconnect', () => relay.ext.tabs.length === 1, 10_000);
  ok('the task tab is re-announced after reconnect', relay.ext.tabs[0].id === TASK_TAB);

  // === the owner closes the tab we are driving ===============================
  // Closing it is a perfectly good way to say "stop", so it ends the task
  // rather than leaving a task pointing at a tab that no longer exists.
  stub.fireTabRemoved(TASK_TAB);
  await waitFor('the empty state push', () => relay.ext.tabs.length === 0);
  ok('closing the task tab clears it everywhere',
     relay.ext.tabs.length === 0 && stub.readStorage('taskTabId') === null,
     String(stub.readStorage('taskTabId')));
  ok('closing the task tab is recorded as a stopped task',
     stub.readStorage('taskState') === 'stopped', String(stub.readStorage('taskState')));

  const gone = await expectRejection(relay.ext.request({ method: '_br.snapshot', params: {}, tabId: null }));
  ok('commands are refused once the task tab is gone',
     gone.rejected && /no active task tab/.test(gone.message), gone.message);

  // === a superseded socket must not speak for the live one ===================
  // connect() stamps each socket with a generation and every handler goes inert
  // the moment it no longer matches. Without that guard a socket retired by
  // panel.saveSettings, the `reconnect` message or the kill switch would --
  // asynchronously, AFTER its replacement was already open -- write
  // 'disconnected' over 'connected', bump the backoff and arm a second
  // reconnect. That is not cosmetic: the side panel locks its composer unless
  // the state is exactly 'connected', so the owner pastes his relay URL, presses
  // 保存并重连, and is left staring at 已断开 with a dead input over a socket
  // that is in fact live.
  //
  // close() is asynchronous, and on loopback the old close and the new open race
  // either way round; LateCloseWS pins the order the guard exists for by
  // delivering close events late, so the superseded socket always lands on top
  // of an already-open replacement. Without it this section passes by luck.
  const LATE_CLOSE_MS = 200;
  let extConnects = 0;
  relay.ext.on('connected', () => { extConnects += 1; });

  const PlainWS = globalThis.WebSocket;
  globalThis.WebSocket = class LateCloseWS extends PlainWS {
    set onclose(fn) {
      super.onclose = typeof fn === 'function'
        ? (event) => { setTimeout(() => { fn(event); }, LATE_CLOSE_MS); }
        : fn;
    }
    get onclose() { return super.onclose; }
  };

  // Warm-up: the socket that is live right now was built by the plain class, so
  // retire it in favour of one whose close lands late. No assertions here.
  // Every wait below counts a NEW connection rather than just looking at the
  // state, which the socket being replaced already satisfies.
  const settled = () => relay.ext.isConnected() && stub.readStorage('status')?.state === 'connected';
  await stub.sendRuntimeMessage({ type: 'reconnect' });
  await waitFor('the late-close socket to take over', () => extConnects === 1 && relay.ext.isConnected());
  await sleep(LATE_CLOSE_MS + 300);

  const supersedingPaths = [
    ['the reconnect message', () => stub.sendRuntimeMessage({ type: 'reconnect' })],
    ['panel.saveSettings', () => stub.sendRuntimeMessage({
      type: 'panel.saveSettings', relayUrl: `ws://127.0.0.1:${EXT_PORT}/ext`, token: TOKEN })],
  ];
  for (const [label, trigger] of supersedingPaths) {
    extConnects = 0;
    const answer = await trigger();
    ok(`${label} answers the panel ok`, answer?.ok === true, JSON.stringify(answer));
    await waitFor(`${label} to redial`, () => extConnects === 1 && relay.ext.isConnected());
    // Reported as an assertion, never as a timeout: a status that never reaches
    // 'connected' is the very fault under test, not a broken harness.
    const reached = await waitFor(`${label} to report connected`, settled, 3000).catch(() => false);
    ok(`${label} reaches connected`, reached === true, JSON.stringify(stub.readStorage('status')));
    // The superseded socket's close event is delivered inside this window.
    await sleep(LATE_CLOSE_MS + 300);
    ok(`the socket ${label} retired does not overwrite the live connection's status`,
       stub.readStorage('status')?.state === 'connected', JSON.stringify(stub.readStorage('status')));
    ok(`${label} leaves exactly one connected socket`,
       relay.ext.isConnected() && extConnects === 1, `connects=${extConnects}`);
  }

  // Longer than the first backoff step a stray onclose would have armed.
  await sleep(1600);
  ok('a deliberate reconnect is not followed by a redundant one',
     extConnects === 1 && relay.ext.isConnected() && stub.readStorage('status')?.state === 'connected',
     `connects=${extConnects} status=${JSON.stringify(stub.readStorage('status'))}`);
  globalThis.WebSocket = PlainWS;

  // === two concurrent status patches, and neither may be lost ================
  // setStatus is a read-modify-write across an await. Flipping the kill switch
  // fires two of them at once -- detachAll('kill switch') writing lastDetach,
  // and the storage listener writing state:'disabled' -- and before they were
  // serialised the later writer's stale snapshot silently dropped the earlier
  // one's field, which is how the switch could leave the status reading
  // 'connected'. Assert BOTH fields survive: a correct final `state` alone does
  // not prove the other write was not the one that got clobbered.
  stub.setTab({ id: TASK_TAB, url: 'https://example.com/docs', title: 'Docs', active: true, status: 'complete' });
  await stub.chrome.storage.local.set({ taskTabId: TASK_TAB, taskGroupId: null, taskState: 'working' });
  await waitFor('the task tab to be announced again', () => relay.ext.tabs.length === 1);
  await relay.ext.request({ method: '_br.snapshot', params: {}, tabId: TASK_TAB });
  ok('the debugger is attached again, so the kill switch has something to detach',
     stub.calls.attach.at(-1)?.tabId === TASK_TAB, JSON.stringify(stub.calls.attach.at(-1)));

  // Clear the earlier run's lastDetach, or a dropped write would be masked by a
  // stale value that happens to read the same.
  await stub.chrome.storage.local.set({ status: { state: 'connected' } });
  await sleep(50);
  await stub.chrome.storage.local.set({ enabled: false });
  await waitFor('the socket to close under the kill switch', () => !relay.ext.isConnected());
  await sleep(400);           // both patches are long since enqueued and drained
  const raced = stub.readStorage('status') || {};
  ok('the kill switch\'s own write survives the concurrent detach write',
     raced.state === 'disabled', JSON.stringify(raced));
  ok('the detach write survives the concurrent kill-switch write',
     raced.lastDetach === 'kill switch', JSON.stringify(raced));

  // ---------------------------------------------------------------- teardown
  relay.close();
  await sleep(100);

  console.log(failures.length
    ? `\ntest-extension: ${pass} passed, ${failures.length} FAILED\n  - ${failures.join('\n  - ')}`
    : `\ntest-extension: ${pass} assertions passed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('test-extension: crashed', err);
  process.exit(1);
});
