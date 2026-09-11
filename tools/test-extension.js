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
const ARMED_TAB = 42;

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
  const alarms = new Map();
  const calls = { attach: [], detach: [], sendCommand: [], executeScript: [], openOptions: 0 };
  const debuggerEventListeners = [];
  const debuggerDetachListeners = [];
  const tabUpdatedListeners = [];
  const tabRemovedListeners = [];

  // Canned answers. Tests overwrite entries to drive a specific branch.
  const cdpResults = {
    'Page.navigate': { frameId: 'FRAME-1' },
    'Page.reload': {},
    'Page.enable': {},
    'Page.captureScreenshot': { data: 'ZmFrZS1zY3JlZW5zaG90' },
    'Input.dispatchMouseEvent': {},
    'Input.insertText': {},
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
      async query() {
        return [...tabs.values()].map((t) => ({ ...t }));
      },
      onUpdated: { addListener: (fn) => tabUpdatedListeners.push(fn) },
      onRemoved: { addListener: (fn) => tabRemovedListeners.push(fn) },
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
      onMessage: { addListener: () => {} },
      openOptionsPage() { calls.openOptions++; },
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
    setTab(tab) { tabs.set(tab.id, tab); },
    patchTab(id, patch) { tabs.set(id, { ...tabs.get(id), ...patch }); },
    dropTab(id) { tabs.delete(id); },
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
  stub.setTab({ id: ARMED_TAB, url: 'https://example.com/docs', title: 'Docs', active: true, status: 'complete' });
  stub.setTab({ id: 7, url: 'chrome://settings', title: 'Settings', active: false, status: 'complete' });
  stub.setTab({ id: 9, url: 'https://other.example.com/', title: 'Other', active: false, status: 'complete' });
  stub.seedStorage({
    relayUrl: `ws://127.0.0.1:${EXT_PORT}/ext`,
    token: TOKEN,
    armedTabId: ARMED_TAB,
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
  ok('hello reports ONLY the armed tab', relay.ext.tabs.length === 1 && relay.ext.tabs[0].id === ARMED_TAB,
     JSON.stringify(relay.ext.tabs));
  ok('hello marks that tab armed', relay.ext.tabs[0].armed === true);
  ok('hello carries the capability list', (relay.ext.status().capabilities || []).includes('_br.snapshot'));
  await waitFor('status', () => stub.readStorage('status')?.state === 'connected');
  ok('status in storage.local reads connected', stub.readStorage('status').state === 'connected');

  // === a real CDP client drives it through the relay ==========================
  const leaseRes = await (await fetch(`${BASE}/lease`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 120_000 }),
  })).json();
  ok('lease targets the armed tab', leaseRes.ok === true && leaseRes.tabId === ARMED_TAB, JSON.stringify(leaseRes));

  const client = cdpClient(WS, leaseRes.cdpUrl);
  await client.ready;
  await waitFor('chrome.debugger.attach', () => stub.calls.attach.length === 1);
  ok('agent attach reached chrome.debugger.attach on the armed tab',
     stub.calls.attach[0].tabId === ARMED_TAB && stub.calls.attach[0].version === '1.3',
     JSON.stringify(stub.calls.attach));

  const nav = await client.send('Page.navigate', { url: 'https://example.com/docs/intro' });
  const navCall = stub.calls.sendCommand.find((c) => c.method === 'Page.navigate');
  ok('Page.navigate travelled agent -> relay -> extension -> chrome.debugger',
     Boolean(navCall) && navCall.params.url === 'https://example.com/docs/intro' && navCall.tabId === ARMED_TAB,
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

  const shot = await client.send('_br.screenshot', { format: 'jpeg' });
  ok('_br.screenshot came back as base64 with a byte count',
     shot.result && shot.result.format === 'jpeg' && shot.result.bytes === shot.result.data.length,
     JSON.stringify(shot.result && { ...shot.result, data: '<omitted>' }));

  const list = await client.send('_br.listTabs', {});
  const armedFlags = (list.result?.tabs || []).filter((t) => t.armed).map((t) => t.id);
  ok('_br.listTabs lists every tab but marks only the armed one',
     list.result?.tabs?.length === 3 && armedFlags.length === 1 && armedFlags[0] === ARMED_TAB,
     JSON.stringify(armedFlags));

  // === compromised relay: what the browser refuses on its own =================
  // These bypass the chokepoint entirely by calling ExtLane.request() directly --
  // exactly what a compromised or newer relay could do. The extension is the last
  // line, and the assertions below are the reason policy.js/guard.js are duplicated
  // on this side at all.
  const sendCommandsBefore = stub.calls.sendCommand.length;

  const evil = await expectRejection(relay.ext.request({ method: 'Runtime.evaluate', params: { expression: '1+1' }, tabId: ARMED_TAB }));
  ok('extension refuses Runtime.evaluate even when the relay forwards it',
     evil.rejected && /banned/.test(evil.message), evil.message);

  const rawInput = await expectRejection(relay.ext.request({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1 }, tabId: ARMED_TAB }));
  ok('extension refuses raw Input.* from the relay',
     rawInput.rejected && /banned/.test(rawInput.message), rawInput.message);

  const foreignTab = await expectRejection(relay.ext.request({ method: 'Page.navigate', params: { url: 'https://other.example.com/' }, tabId: 9 }));
  ok('extension refuses a tab the owner never armed',
     foreignTab.rejected && /not the armed tab/.test(foreignTab.message), foreignTab.message);

  const blocked = await expectRejection(relay.ext.request({ method: '_br.navigate', params: { url: 'https://shop.example.com/checkout' }, tabId: ARMED_TAB }));
  ok('extension refuses a blocklisted destination on its own',
     blocked.rejected && /blocklist/.test(blocked.message), blocked.message);

  // The armed tab navigates itself somewhere dangerous and the relay's cached URL
  // has not caught up. The relay would allow; the extension re-reads the live URL.
  stub.patchTab(ARMED_TAB, { url: 'https://shop.example.com/checkout' });
  ok('the relay would have allowed this frame against its stale cached URL',
     relayChokepoint.check({ method: '_br.click', params: { selector: '#buy' }, tabUrl: 'https://example.com/docs' }) === null);
  const stale = await expectRejection(relay.ext.request({ method: '_br.click', params: { selector: '#buy' }, tabId: ARMED_TAB }));
  ok('extension re-screens against the tab\'s ACTUAL current URL and refuses',
     stale.rejected && /blocklist/.test(stale.message), stale.message);
  stub.patchTab(ARMED_TAB, { url: 'https://example.com/docs' });

  ok('no refused frame reached chrome.debugger', stub.calls.sendCommand.length === sendCommandsBefore,
     JSON.stringify(stub.calls.sendCommand.slice(sendCommandsBefore)));

  client.close();

  // === events ================================================================
  events.length = 0;
  stub.fireDebuggerEvent({ tabId: ARMED_TAB }, 'Page.loadEventFired', { timestamp: 1 });
  await waitFor('the event to reach the relay', () => events.length === 1);
  ok('a debugger event from the attached tab reaches the relay', events[0].method === 'Page.loadEventFired');

  stub.fireDebuggerEvent({ tabId: 9 }, 'Page.loadEventFired', { timestamp: 2 });
  await sleep(100);
  ok('an event from a tab we are not driving is dropped', events.length === 1, JSON.stringify(events.map((e) => e.method)));

  stub.fireDebuggerEvent({ tabId: ARMED_TAB }, 'Network.responseReceived', { body: 'x'.repeat(70_000) });
  await sleep(150);
  ok('an oversized event frame is dropped, not truncated', events.length === 1, String(events.length));
  ok('the drop is recorded in status', stub.readStorage('status')?.lastDroppedEvent === 'Network.responseReceived',
     JSON.stringify(stub.readStorage('status')));

  // === tabless methods survive an unarmed browser ============================
  await stub.chrome.storage.local.remove('armedTabId');
  await waitFor('the relay to be told there is no armed tab', () => relay.ext.tabs.length === 0);
  ok('unarming pushes an empty tab list, so the relay stops leasing', relay.ext.tabs.length === 0);

  const info = await relay.ext.request({ method: '_br.info', tabId: null });
  ok('_br.info answers with no tab armed and nothing attached',
     info.armedTabId === null && Array.isArray(info.capabilities), JSON.stringify(info));

  const unarmed = await expectRejection(relay.ext.request({ method: 'Page.navigate', params: { url: 'https://example.com/' }, tabId: null }));
  ok('a page-touching method is refused with no tab armed',
     unarmed.rejected && /no tab armed/.test(unarmed.message), unarmed.message);

  await stub.chrome.storage.local.set({ armedTabId: ARMED_TAB });
  await waitFor('re-arm', () => relay.ext.tabs.length === 1);
  ok('re-arming pushes the tab back to the relay', relay.ext.tabs[0].id === ARMED_TAB);

  // === tab lifecycle =========================================================
  stub.patchTab(ARMED_TAB, { url: 'https://example.com/docs/other', title: 'Other page' });
  stub.fireTabUpdated(ARMED_TAB, { url: 'https://example.com/docs/other' });
  await waitFor('the state push', () => relay.ext.tabUrl(ARMED_TAB) === 'https://example.com/docs/other');
  ok('a self-navigating page refreshes the relay\'s cached URL',
     relay.ext.tabUrl(ARMED_TAB) === 'https://example.com/docs/other');

  // === attaching to a forbidden tab ==========================================
  await stub.chrome.storage.local.set({ armedTabId: 7 });     // chrome://settings
  await sleep(100);
  const forbidden = await expectRejection(relay.ext.request({ type: 'attach', tabId: 7 }));
  ok('extension refuses to attach the debugger to a chrome:// tab',
     forbidden.rejected && /cannot attach/.test(forbidden.message), forbidden.message);
  await stub.chrome.storage.local.set({ armedTabId: ARMED_TAB });
  await sleep(100);

  // === kill switch ===========================================================
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
  ok('the armed tab is re-announced after reconnect', relay.ext.tabs[0].id === ARMED_TAB);

  // === closing the armed tab =================================================
  stub.fireTabRemoved(ARMED_TAB);
  await waitFor('the empty state push', () => relay.ext.tabs.length === 0);
  ok('closing the armed tab clears it everywhere',
     relay.ext.tabs.length === 0 && stub.readStorage('armedTabId') === undefined,
     String(stub.readStorage('armedTabId')));

  const gone = await expectRejection(relay.ext.request({ method: '_br.snapshot', params: {}, tabId: null }));
  ok('commands are refused once the armed tab is gone',
     gone.rejected && /no tab armed/.test(gone.message), gone.message);

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
