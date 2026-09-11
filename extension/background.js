/*
 * Zylos Browser Remote -- MV3 background service worker.
 *
 * Dials OUT to the relay (the agent's container has no public IP and cannot
 * initiate a connection to this machine), then executes post-chokepoint
 * commands against the ONE tab the owner explicitly armed.
 *
 * Three MV3 constraints shape this file:
 *  1. A service worker is torn down after ~30s idle. Chrome 116+ resets that
 *     idle timer on WebSocket activity, so the relay's 17s heartbeat is what
 *     keeps us alive; chrome.alarms (30s floor) is the backstop that wakes us
 *     to reconnect after a teardown.
 *  2. A service worker cannot set custom headers on a WebSocket, so the auth
 *     token rides in the subprotocol list instead of an Authorization header.
 *  3. Module scope is NOT durable -- `attachedTabId` below is a cache, not a
 *     source of truth. Anything that must survive a recycle lives in
 *     chrome.storage.local, and every command re-reads the tab it drives.
 *
 * This side is its own trust domain. The relay already ran the allowlist and
 * the guard, and this file runs BOTH AGAIN against the tab's actual current
 * URL -- see policy.js for why that duplication is deliberate.
 */

import { screen } from './guard.js';
import { methodAllowed, isBrMethod, tabAttachAllowed } from './policy.js';
import { VERSION, CAPABILITIES, execBr, execCdp } from './actions.js';

const SUBPROTOCOL = 'zylos-browser-remote.v1';
const ALARM_NAME = 'zylos-browser-remote-keepalive';
const ALARM_PERIOD_MIN = 0.5;           // 30s = the MV3 floor; shorter values are clamped
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const DEBUGGER_PROTOCOL_VERSION = '1.3';

// Cap on CDP *event* frames only. Events are unsolicited and can firehose
// (Network.* bodies, Page.screencastFrame); a 5MB one would stall the edge
// socket for a message nobody asked for. Command RESPONSES are deliberately
// uncapped -- _br.screenshot legitimately returns megabytes and the agent is
// waiting on it.
const MAX_EVENT_FRAME_BYTES = 64 * 1024;

let ws = null;
let connecting = false;
let backoffAttempt = 0;
let attachedTabId = null;

// ------------------------------------------------------------------ settings

async function getConfig() {
  const cfg = await chrome.storage.local.get(['relayUrl', 'token', 'armedTabId', 'enabled']);
  return {
    relayUrl: cfg.relayUrl,
    token: cfg.token,
    armedTabId: cfg.armedTabId,
    // Absent means enabled: a fresh install with no flag set should work once
    // the owner arms a tab. Only an explicit `false` is a kill.
    enabled: cfg.enabled !== false,
  };
}

async function setStatus(patch) {
  const prev = (await chrome.storage.local.get('status')).status || {};
  await chrome.storage.local.set({ status: { ...prev, ...patch, at: Date.now() } });
}

// ------------------------------------------------------------------ tab reporting

/**
 * The `tabs` array in hello/state frames.
 *
 * ONLY the armed tab, never the full list. The relay uses tabs[0] as the
 * default lease target and tabUrl() as the URL it screens against, so putting
 * anything else first would hand a lease to a tab the owner never armed. The
 * full list is a separate, explicit request: _br.listTabs.
 */
async function armedTabs() {
  const { armedTabId } = await getConfig();
  if (armedTabId == null) return [];
  try {
    const t = await chrome.tabs.get(armedTabId);
    return [{ id: t.id, title: t.title, url: t.url, active: t.active, armed: true }];
  } catch {
    // Armed tab was closed while we were asleep.
    await chrome.storage.local.remove('armedTabId');
    return [];
  }
}

async function pushState() {
  if (!isOpen()) return;
  send({ type: 'state', tabs: await armedTabs() });
}

// ------------------------------------------------------------------ transport

function isOpen() {
  return Boolean(ws) && ws.readyState === WebSocket.OPEN;
}

function send(frame) {
  if (!isOpen()) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function backoffDelay() {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** backoffAttempt, BACKOFF_MAX_MS);
  // Jitter so a relay restart doesn't produce a synchronized reconnect
  // stampede (harmless with one client, but this is the shape you want).
  return exp / 2 + Math.random() * (exp / 2);
}

async function connect() {
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  const { relayUrl, token, enabled } = await getConfig();
  if (!enabled) {
    // The socket IS the attack surface: while the kill switch is off we do not
    // hold one open at all, rather than connect and refuse each command.
    await setStatus({ state: 'disabled' });
    return;
  }
  if (!relayUrl || !token) {
    await setStatus({ state: 'unconfigured' });
    return;
  }
  connecting = true;
  await setStatus({ state: 'connecting' });

  let sock;
  try {
    // The relay compares the token constant-time over SHA-256 digests and
    // echoes back only the non-secret protocol name.
    sock = new WebSocket(relayUrl, [SUBPROTOCOL, `token.${token}`]);
  } catch (err) {
    connecting = false;
    backoffAttempt += 1;
    await setStatus({ state: 'error', error: String(err.message || err) });
    scheduleReconnect();
    return;
  }

  sock.onopen = async () => {
    connecting = false;
    backoffAttempt = 0;
    ws = sock;
    send({ type: 'hello', version: VERSION, capabilities: CAPABILITIES, tabs: await armedTabs() });
    await setStatus({ state: 'connected', error: null, code: null });
  };

  sock.onmessage = (event) => { void handleFrame(sock, event.data); };

  sock.onclose = async (event) => {
    connecting = false;
    if (ws === sock) ws = null;
    // The kill switch closes the socket itself, so this handler runs LAST and
    // would otherwise overwrite 'disabled' with 'disconnected' -- reporting a
    // fault for what the owner deliberately did, and leaving a reconnect timer
    // ticking against a connect() that will only ever bail.
    const { enabled } = await getConfig();
    if (!enabled) {
      await setStatus({ state: 'disabled', code: event.code });
      return;
    }
    // 4001 = the relay handed the lane to a newer connection of ours. Not an
    // error, but we still back off rather than race the replacement.
    await setStatus({ state: 'disconnected', code: event.code });
    backoffAttempt += 1;
    scheduleReconnect();
  };

  sock.onerror = async () => {
    // onclose always follows; record the signal and let it drive the reconnect.
    await setStatus({ state: 'error', error: 'socket error' });
  };
}

function scheduleReconnect() {
  // setTimeout does not survive service-worker teardown, so the alarm is the
  // real guarantee. This just reconnects promptly while we happen to be alive.
  setTimeout(() => { void connect(); }, backoffDelay());
}

// ------------------------------------------------------------------ attach

/**
 * Resolve the tab a command will drive, re-read fresh from Chrome.
 *
 * P0 is single-owner/single-tab, so the target must BE the armed tab. The
 * relay only ever leases the tab we reported, but this is the enforcement
 * point: "nothing is driven until you arm it" has to be true even if the
 * relay is compromised or runs ahead of this extension.
 */
async function resolveTarget(tabId) {
  const { armedTabId } = await getConfig();
  if (armedTabId == null) {
    throw new Error('no tab armed: open the extension options and arm a tab first');
  }
  if (tabId != null && String(tabId) !== String(armedTabId)) {
    throw new Error(
      `refused by extension: tab ${tabId} is not the armed tab (${armedTabId}); ` +
      'only the armed tab may be driven'
    );
  }
  try {
    return await chrome.tabs.get(armedTabId);
  } catch {
    await chrome.storage.local.remove('armedTabId');
    throw new Error(`armed tab ${armedTabId} no longer exists; re-arm a tab`);
  }
}

async function ensureAttached(tab) {
  const refusal = tabAttachAllowed(tab.url);
  if (refusal) throw new Error(refusal);
  if (attachedTabId === tab.id) return;
  if (attachedTabId !== null) {
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch { /* already gone */ }
    attachedTabId = null;
  }
  await chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_PROTOCOL_VERSION);
  attachedTabId = tab.id;
}

async function detachAll(reason) {
  if (attachedTabId === null) return;
  const was = attachedTabId;
  attachedTabId = null;
  try { await chrome.debugger.detach({ tabId: was }); } catch { /* already gone */ }
  await setStatus({ lastDetach: reason || 'requested' });
}

// ------------------------------------------------------------------ execution

// _br.* methods that answer from extension/Chrome state and touch no page, so
// they need neither an armed-tab lease nor a debugger attachment.
const TABLESS_METHODS = new Set(['_br.info', '_br.listTabs']);

async function execute({ method, params, tabId }) {
  const { enabled, armedTabId } = await getConfig();
  // Re-checked here and not only in connect(): the owner may flip the switch
  // while a socket is open and a command is already in flight.
  if (!enabled) throw new Error('refused by extension: remote control is disabled (kill switch)');

  // Layer 1: does this extension implement this method at all? Default-deny.
  const notAllowed = methodAllowed(method);
  if (notAllowed) throw new Error(notAllowed);

  if (TABLESS_METHODS.has(method)) {
    return execBr({ method, params, tabId: null, state: { armedTabId, attachedTabId } });
  }

  const tab = await resolveTarget(tabId);

  // Layer 2: the URL guard, run against the tab's ACTUAL current URL. The
  // relay screened the URL the tab had when it last reported state; by now the
  // page may have navigated itself somewhere the relay never saw. For a click
  // or a keystroke, the live URL is the only one that matters.
  const refusal = screen({ method, params, tabUrl: tab.url });
  if (refusal) throw new Error(refusal);

  await ensureAttached(tab);

  return isBrMethod(method)
    ? execBr({ method, params, tabId: tab.id, state: { armedTabId, attachedTabId } })
    : execCdp({ method, params, tabId: tab.id });
}

// ------------------------------------------------------------------ frames

async function handleFrame(sock, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'ping':
      // Replying is also what keeps this service worker off the idle timer.
      try { sock.send(JSON.stringify({ type: 'pong', ts: msg.ts })); } catch { /* closing */ }
      return;

    case 'lease-lost':
      // The agent's lease expired or was revoked. Drop the debugger so the
      // yellow banner disappears and nothing is attached without a driver.
      await detachAll(`lease-lost: ${msg.reason || 'unspecified'}`);
      return;

    case 'attach':
      await reply(sock, msg, async () => {
        const tab = await resolveTarget(msg.tabId);
        await ensureAttached(tab);
        return { attached: tab.id, url: tab.url, title: tab.title };
      });
      return;

    case 'detach':
      await reply(sock, msg, async () => {
        await detachAll('relay requested detach');
        return {};
      });
      return;

    case 'req':
      await reply(sock, msg, () => execute(msg));
      return;

    default:
      return;
  }
}

/** Run `work` and answer the frame with resp/error. Never throws. */
async function reply(sock, msg, work) {
  try {
    const result = await work();
    sock.send(JSON.stringify({ id: msg.id, type: 'resp', result: result ?? {} }));
  } catch (err) {
    try {
      sock.send(JSON.stringify({ id: msg.id, type: 'error', error: String(err?.message || err) }));
    } catch { /* socket went away mid-command; the relay's 30s timeout covers it */ }
  }
}

// ------------------------------------------------------------------ lifecycle

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  const frame = JSON.stringify({ type: 'event', method, params, tabId: source.tabId });
  if (frame.length > MAX_EVENT_FRAME_BYTES) {
    // Dropped rather than truncated: half a CDP event is not a CDP event, and
    // the agent is better off never seeing it than parsing a lie.
    void setStatus({ lastDroppedEvent: method });
    return;
  }
  if (!isOpen()) return;
  try { ws.send(frame); } catch { /* closing */ }
});

chrome.debugger.onDetach.addListener((source) => {
  // Fires when the tab closes, the owner clicks "cancel" on the debugging
  // banner, or another client takes the debugger. Clear the cache so the next
  // command re-attaches instead of erroring forever.
  if (source.tabId === attachedTabId) attachedTabId = null;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const { armedTabId } = await getConfig();
  if (tabId !== armedTabId) return;
  // The relay caches the armed tab's URL and screens against it. A page that
  // navigates itself must invalidate that cache immediately, or the relay
  // keeps screening a URL the tab has already left.
  if (changeInfo.url || changeInfo.status || changeInfo.title) await pushState();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === attachedTabId) attachedTabId = null;
  const { armedTabId } = await getConfig();
  if (tabId === armedTabId) {
    await chrome.storage.local.remove('armedTabId');
    await pushState();          // now empty: the relay must stop handing out leases
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.armedTabId) void pushState();
  if (changes.enabled) {
    if (changes.enabled.newValue === false) {
      void detachAll('kill switch');
      try { ws?.close(1000, 'disabled by owner'); } catch { /* noop */ }
      ws = null;
      void setStatus({ state: 'disabled' });
    } else {
      backoffAttempt = 0;
      void connect();
    }
  }
});

function ensureAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void connect();
});

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); void connect(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); void connect(); });

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// The options page asks us to redial after the owner saves settings or arms a tab.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    backoffAttempt = 0;
    try { ws?.close(1000, 'reconnect requested'); } catch { /* noop */ }
    ws = null;
    void connect();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'status') {
    void (async () => sendResponse({
      open: isOpen(),
      attachedTabId,
      version: VERSION,
      tabs: await armedTabs(),
    }))();
    return true;                // async sendResponse
  }
  return false;
});

// Cold start of the worker for any reason (alarm, event, install): make sure
// the backstop exists and dial. Module scope ran, so nothing is attached.
attachedTabId = null;
chrome.alarms.get(ALARM_NAME).then((a) => { if (!a) ensureAlarm(); });
void connect();
