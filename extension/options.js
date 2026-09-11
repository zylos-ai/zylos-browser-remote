/*
 * Options page -- the only place the owner grants or withdraws control.
 *
 * Everything here writes chrome.storage.local; background.js watches it via
 * chrome.storage.onChanged, so arming, disarming, and the kill switch take
 * effect without a reload and without this page needing to be open.
 */

const $ = (id) => document.getElementById(id);

async function load() {
  const { relayUrl, token, enabled } = await chrome.storage.local.get([
    'relayUrl', 'token', 'enabled',
  ]);
  if (relayUrl) $('relayUrl').value = relayUrl;
  if (token) $('token').value = token;
  // Absent means enabled -- matches background.js (only an explicit false kills).
  renderKill(enabled !== false);
  await renderStatus();
  await renderTabs();
}

function renderKill(on) {
  $('enabled').checked = on;
  $('killRow').className = on ? 'kill' : 'kill off';
  $('killHint').textContent = on
    ? 'The agent may drive the armed tab.'
    : 'OFF — the relay connection is closed and every command is refused.';
}

async function renderStatus() {
  const { status, relayUrl, token, armedTabId, enabled } = await chrome.storage.local.get([
    'status', 'relayUrl', 'token', 'armedTabId', 'enabled',
  ]);
  const s = status || {};
  const age = s.at ? `${Math.round((Date.now() - s.at) / 1000)}s ago` : 'never';
  $('status').textContent = [
    `state:     ${s.state || 'unknown'} (${age})`,
    s.error ? `error:     ${s.error}` : null,
    s.code !== undefined && s.code !== null ? `closeCode: ${s.code}` : null,
    `enabled:   ${enabled !== false}`,
    `relayUrl:  ${relayUrl || '(not set)'}`,
    `token:     ${token ? 'configured' : '(not set)'}`,
    `armedTab:  ${armedTabId ?? '(none)'}`,
    s.lastDetach ? `lastDetach: ${s.lastDetach}` : null,
  ].filter(Boolean).join('\n');
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({});
  const { armedTabId } = await chrome.storage.local.get('armedTabId');
  const body = $('tabs').querySelector('tbody');
  body.replaceChildren();

  for (const t of tabs) {
    // Arming this options page itself would be pointless (the extension
    // refuses to attach to chrome-extension:// anyway).
    if (t.url?.startsWith('chrome-extension://') && t.url.includes('options.html')) continue;

    const tr = document.createElement('tr');
    if (t.id === armedTabId) tr.className = 'armed';

    const info = document.createElement('td');
    const title = document.createElement('div');
    title.textContent = t.title || '(untitled)';
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = t.url || '';
    info.append(title, url);

    const action = document.createElement('td');
    action.style.width = '110px';
    const btn = document.createElement('button');
    btn.textContent = t.id === armedTabId ? 'Disarm' : 'Arm';
    btn.addEventListener('click', async () => {
      if (t.id === armedTabId) await chrome.storage.local.remove('armedTabId');
      else await chrome.storage.local.set({ armedTabId: t.id });
      await renderTabs();
      await renderStatus();
    });
    action.append(btn);

    tr.append(info, action);
    body.append(tr);
  }
}

$('enabled').addEventListener('change', async (ev) => {
  const on = ev.target.checked;
  renderKill(on);
  await chrome.storage.local.set({ enabled: on });
  setTimeout(renderStatus, 400);
});

$('save').addEventListener('click', async () => {
  const relayUrl = $('relayUrl').value.trim();
  const token = $('token').value.trim();
  if (!/^wss?:\/\//.test(relayUrl)) {
    $('status').textContent = 'relayUrl must start with wss:// (or ws:// over a tailnet)';
    return;
  }
  await chrome.storage.local.set({ relayUrl, token });
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(renderStatus, 600);
});

$('refresh').addEventListener('click', async () => {
  await renderStatus();
  await renderTabs();
});

load();
