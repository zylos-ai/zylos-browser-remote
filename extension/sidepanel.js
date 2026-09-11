/*
 * Side panel -- the owner's chat surface.
 *
 * This file never opens a socket. The service worker owns the relay
 * connection; the panel is a view that talks to it over chrome.runtime
 * messages and reads chrome.storage.local for anything that must survive the
 * worker being torn down (MV3 recycles it after ~30s idle, so a panel opened
 * cold would otherwise show nothing until the next broadcast).
 *
 * Two rules hold everywhere below:
 *  1. Message text is attacker-controlled -- it comes from a page the agent
 *     read. It is only ever written with textContent. No innerHTML, anywhere.
 *  2. Every sendMessage is wrapped: with the worker asleep or mid-restart the
 *     promise rejects with "receiving end does not exist", which must degrade
 *     into a calm status line rather than an unhandled rejection.
 */

const CHAT_LOG_KEY = 'chatLog';
const CHAT_LOG_MAX = 200;

const CONN_LABELS = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '已断开',
  error: '连接异常',
  disabled: '已停用',
  unconfigured: '未配置',
  unknown: '状态未知',
};

// Why the composer is locked, in the owner's language. Keyed by connection state.
const BLOCK_REASONS = {
  connecting: '正在连接中继，稍等一下再发。',
  disconnected: '和中继断开了，正在自动重连。',
  error: '连接出错，正在自动重连。',
  disabled: '远程控制已关闭 —— 在下方「设置」里打开才能对话。',
  unconfigured: '还没配置中继地址和令牌 —— 在下方「设置」里填好并保存。',
  unknown: '正在获取后台状态…',
};

const TASK_LABELS = {
  working: '工作中',
  waiting: '等你回话',
  stopped: '已停止',
  idle: '空闲',
};

const $ = (id) => document.getElementById(id);

let chatLog = [];               // in-memory source of truth; storage is a mirror
let connState = 'unknown';
let toastTimer = null;
// Held as a node, not looked up by id: rendering a message detaches it from
// the document, after which getElementById would no longer find it.
let emptyHintNode = null;

// --------------------------------------------------------------- messaging

/**
 * chrome.runtime.sendMessage that never throws.
 *
 * A rejection here is the normal MV3 case (worker asleep, or restarting after
 * a crash), not an error the owner should see as a stack trace.
 */
async function call(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    // A listener that returns false without responding resolves as undefined.
    if (!res) return { ok: false, error: 'no-response' };
    return res;
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function isWorkerAsleep(error) {
  return typeof error === 'string'
    && (error.includes('Receiving end does not exist')
      || error.includes('Could not establish connection')
      || error === 'no-response');
}

// ------------------------------------------------------------------ storage

async function loadChatLog() {
  const stored = (await chrome.storage.local.get(CHAT_LOG_KEY))[CHAT_LOG_KEY];
  chatLog = Array.isArray(stored) ? stored.filter(isRenderable).slice(-CHAT_LOG_MAX) : [];
}

function isRenderable(m) {
  return m && typeof m.text === 'string' && typeof m.role === 'string';
}

function persistChatLog() {
  // Fire-and-forget: the in-memory array is authoritative, so a lost write
  // costs history, never correctness. Failures are swallowed on purpose --
  // the panel closing mid-write is routine.
  void chrome.storage.local.set({ [CHAT_LOG_KEY]: chatLog }).catch(() => {});
}

// ---------------------------------------------------------------- rendering

function formatTime(ts) {
  const d = new Date(typeof ts === 'number' ? ts : Date.now());
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function messageNode(msg) {
  const role = msg.role === 'user' || msg.role === 'system' ? msg.role : 'assistant';
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = msg.text;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = formatTime(msg.ts);

  wrap.append(bubble, meta);
  return wrap;
}

function atBottom() {
  const el = $('transcript');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom() {
  const el = $('transcript');
  el.scrollTop = el.scrollHeight;
}

function renderTranscript() {
  const el = $('transcript');
  el.replaceChildren();
  if (chatLog.length === 0) {
    if (emptyHintNode) el.append(emptyHintNode);
    return;
  }
  for (const msg of chatLog) el.append(messageNode(msg));
  scrollToBottom();
}

function appendMessage(msg, { persist = true } = {}) {
  const stick = atBottom();
  const wasEmpty = chatLog.length === 0;
  chatLog.push(msg);
  const trimmed = chatLog.length > CHAT_LOG_MAX;
  if (trimmed) chatLog = chatLog.slice(-CHAT_LOG_MAX);

  // Append only while the DOM still mirrors the array one-for-one; the empty
  // hint and a trim both break that, and then a rebuild is the honest fix.
  const el = $('transcript');
  if (wasEmpty || trimmed || el.childElementCount !== chatLog.length - 1) renderTranscript();
  else el.append(messageNode(msg));

  if (stick) scrollToBottom();
  if (persist) persistChatLog();
}

function systemLine(text) {
  appendMessage({ role: 'system', text, ts: Date.now() });
}

// ------------------------------------------------------------------- header

function renderConn(status) {
  const state = CONN_LABELS[status?.state] ? status.state : 'unknown';
  connState = state;
  const detail = status?.error || null;

  const pill = $('connPill');
  pill.className = `pill ${state}`;
  pill.textContent = CONN_LABELS[state];
  pill.title = detail ? `${CONN_LABELS[state]} — ${detail}` : '中继连接状态';

  renderComposerLock();
  if (!$('settings').hidden) void renderSettingsStatus();
}

function renderTask(state) {
  const known = TASK_LABELS[state] ? state : 'idle';
  const dot = $('taskDot');
  dot.className = `task-dot ${known}`;
  dot.title = TASK_LABELS[known];
}

// ----------------------------------------------------------------- composer

function renderComposerLock() {
  const ok = connState === 'connected';
  $('input').disabled = !ok;
  $('send').disabled = !ok;

  const notice = $('composerNotice');
  if (ok) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  notice.hidden = false;
  notice.className = connState === 'disabled' || connState === 'unconfigured' ? 'notice warn' : 'notice';
  notice.textContent = BLOCK_REASONS[connState] || BLOCK_REASONS.unknown;
}

function autoGrow() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
}

async function send() {
  const ta = $('input');
  const text = ta.value.trim();
  if (!text || ta.disabled) return;

  // Optimistic: the owner's own words belong on screen immediately, and the
  // transcript is local state -- a failed delivery is reported beneath them
  // rather than by making the bubble disappear.
  appendMessage({ role: 'user', text, ts: Date.now() });
  ta.value = '';
  autoGrow();

  const res = await call({ type: 'panel.send', text });
  if (!res.ok) {
    systemLine(isWorkerAsleep(res.error)
      ? '后台刚才在休眠，这条消息没能发出去，请再发一次。'
      : `发送失败：${res.error}`);
  }
}

// ------------------------------------------------------------------ footer

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function renderSettingsStatus() {
  const { status, relayUrl, token, enabled } = await chrome.storage.local.get([
    'status', 'relayUrl', 'token', 'enabled',
  ]);
  const s = status || {};
  const age = s.at ? `${Math.round((Date.now() - s.at) / 1000)}s 前` : '从未';
  $('settingsStatus').textContent = [
    `状态：   ${CONN_LABELS[s.state] || s.state || '未知'}（${age}）`,
    s.error ? `错误：   ${s.error}` : null,
    s.code !== undefined && s.code !== null ? `关闭码： ${s.code}` : null,
    `开关：   ${enabled !== false ? '已开启' : '已关闭'}`,
    `中继：   ${relayUrl || '(未设置)'}`,
    `令牌：   ${token ? '已配置' : '(未设置)'}`,
  ].filter(Boolean).join('\n');
}

function renderKill(on) {
  $('enabled').checked = on;
  $('killRow').className = on ? 'kill' : 'kill off';
  $('killHint').textContent = on
    ? '关掉它会立刻断开中继连接，所有指令都会被拒绝。'
    : '已关闭 —— 中继连接已断开，任何指令都不会执行。';
}

async function saveSettings() {
  const relayUrl = $('relayUrl').value.trim();
  const token = $('token').value.trim();
  if (!/^wss?:\/\//.test(relayUrl)) {
    toast('中继地址要以 wss:// 开头（内网 tailnet 可用 ws://）。');
    return;
  }

  const res = await call({ type: 'panel.saveSettings', relayUrl, token });
  if (!res.ok) {
    // The worker may simply have been asleep; settings live in storage, which
    // background.js watches via onChanged, so writing them directly still
    // takes effect -- same path the options page has always used.
    await chrome.storage.local.set({ relayUrl, token });
    await call({ type: 'reconnect' });
    toast(isWorkerAsleep(res.error) ? '已保存，正在唤醒后台重连…' : `已保存，但重连请求失败：${res.error}`);
  } else {
    toast('已保存，正在重连…');
  }
  setTimeout(() => { void refreshState(); }, 800);
}

async function setEnabled(on) {
  renderKill(on);
  const res = await call({ type: 'panel.setEnabled', enabled: on });
  if (!res.ok) await chrome.storage.local.set({ enabled: on });
  setTimeout(() => { void refreshState(); }, 500);
}

async function clearFinished() {
  const res = await call({ type: 'panel.clearFinished' });
  toast(res.ok
    ? '已清理：停止的分组已解散，标签页都还在。'
    : (isWorkerAsleep(res.error) ? '后台在休眠，请再点一次。' : `清理失败：${res.error}`));
}

// --------------------------------------------------------------------- wiring

async function refreshState() {
  // Storage first: it is written by the worker and outlives it, so the pill is
  // right even when the panel opens before any broadcast arrives.
  const { status, enabled, relayUrl, token } = await chrome.storage.local.get([
    'status', 'enabled', 'relayUrl', 'token',
  ]);
  if (relayUrl && document.activeElement !== $('relayUrl')) $('relayUrl').value = relayUrl;
  if (token && document.activeElement !== $('token')) $('token').value = token;
  renderKill(enabled !== false);
  renderConn(status);

  const res = await call({ type: 'panel.getState' });
  if (res.ok) {
    // A reply missing these fields must not overwrite what storage just told
    // us -- the worker's own status write is the more reliable of the two.
    if (res.status?.state) renderConn(res.status);
    if (res.task?.state) renderTask(res.task.state);
  } else if (!status) {
    renderConn({ state: isWorkerAsleep(res.error) ? 'disconnected' : 'unknown', error: res.error });
  }
}

function onRuntimeMessage(msg) {
  if (msg?.type === 'chat.message' && typeof msg.text === 'string') {
    appendMessage({ role: msg.role === 'user' ? 'user' : 'assistant', text: msg.text, ts: msg.ts });
  } else if (msg?.type === 'chat.status') {
    renderTask(msg.state);
  } else if (msg?.type === 'conn.status') {
    renderConn(msg.status);
  }
  // No response is ever sent: these are broadcasts, and holding the channel
  // open would make the worker's sendMessage wait on us.
}

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (changes.status) renderConn(changes.status.newValue);
  if (changes.enabled) renderKill(changes.enabled.newValue !== false);
  if (changes.relayUrl && document.activeElement !== $('relayUrl')) {
    $('relayUrl').value = changes.relayUrl.newValue || '';
  }
  if (changes[CHAT_LOG_KEY]) {
    // Another context (a second panel window, or the worker) appended. Adopt
    // it only when it actually differs, so our own writes don't re-render.
    const next = changes[CHAT_LOG_KEY].newValue;
    const incoming = Array.isArray(next) ? next.filter(isRenderable) : [];
    const same = incoming.length === chatLog.length
      && incoming[incoming.length - 1]?.ts === chatLog[chatLog.length - 1]?.ts
      && incoming[incoming.length - 1]?.text === chatLog[chatLog.length - 1]?.text;
    if (!same) {
      chatLog = incoming.slice(-CHAT_LOG_MAX);
      renderTranscript();
    }
  }
}

function main() {
  emptyHintNode = $('emptyHint');

  $('composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void send();
  });

  $('input').addEventListener('keydown', (ev) => {
    // Enter sends; Shift+Enter is a newline. IME composition must never send --
    // Chinese input confirms a candidate with Enter and would otherwise post
    // a half-typed line.
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void send();
    }
  });
  $('input').addEventListener('input', autoGrow);

  $('clearFinished').addEventListener('click', () => { void clearFinished(); });

  $('settingsToggle').addEventListener('click', () => {
    const open = $('settings').hidden;
    $('settings').hidden = !open;
    $('settingsToggle').setAttribute('aria-expanded', String(open));
    if (open) void renderSettingsStatus();
  });

  $('save').addEventListener('click', () => { void saveSettings(); });
  $('enabled').addEventListener('change', (ev) => { void setEnabled(ev.target.checked); });

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  void (async () => {
    await loadChatLog();
    renderTranscript();
    await refreshState();
  })();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
