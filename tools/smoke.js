'use strict';
/*
 * End-to-end smoke test: a fake extension on the ext lane, a stock-shaped CDP
 * client on the agent lane, and the real relay in between. No Chrome, no
 * network beyond loopback.
 *
 * Run: node tools/smoke.js
 */

const WebSocket = require('ws');
const { start } = require('../relay/server');
const { SUBPROTOCOL } = require('../relay/ext-lane');
const { LocalRelayProvider } = require('../relay/providers/local-relay-provider');

const TOKEN = 'smoke-token-not-a-secret';
const EXT_PORT = 3902;            // deliberately NOT 3802/3803: never collide with a live relay
const AGENT_PORT = 3903;
const BASE = `http://127.0.0.1:${AGENT_PORT}`;

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

// --- fake extension --------------------------------------------------------

const TABS = [{ id: 42, url: 'https://example.com/docs', title: 'Docs' }];

function fakeExtension({ token = TOKEN } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${EXT_PORT}/ext`, [SUBPROTOCOL, `token.${token}`]);
  const seen = { attach: 0, detach: 0, leaseLost: 0, pings: 0, methods: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', capabilities: ['_br.snapshot'], tabs: TABS })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') { seen.pings++; return ws.send(JSON.stringify({ type: 'pong' })); }
    if (msg.type === 'lease-lost') { seen.leaseLost++; return; }
    if (msg.type === 'attach') { seen.attach++; return ws.send(JSON.stringify({ id: msg.id, type: 'resp', result: { attached: msg.tabId } })); }
    if (msg.type === 'detach') { seen.detach++; return ws.send(JSON.stringify({ id: msg.id, type: 'resp', result: {} })); }
    if (msg.type === 'req') {
      seen.methods.push(msg.method);
      // Echo enough to prove the frame arrived intact and post-chokepoint.
      return ws.send(JSON.stringify({ id: msg.id, type: 'resp', result: { echoed: msg.method, params: msg.params, tabId: msg.tabId } }));
    }
  });
  return { ws, seen };
}

// --- fake CDP client -------------------------------------------------------

function cdpClient(url) {
  const ws = new WebSocket(url);
  const waiters = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  // Cases below connect on purpose expecting a rejected handshake; mark the
  // promise handled so a deliberate failure is not an unhandled rejection.
  ready.catch(() => {});
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
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
    closed: new Promise((resolve) => ws.once('close', (code) => resolve(code))),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- run -------------------------------------------------------------------

(async () => {
  const relay = await start({ token: TOKEN, extPort: EXT_PORT, agentPort: AGENT_PORT });

  // 1. bad token is rejected at the upgrade
  await new Promise((resolve) => {
    const bad = new WebSocket(`ws://127.0.0.1:${EXT_PORT}/ext`, [SUBPROTOCOL, 'token.wrong']);
    bad.on('open', () => { ok('bad token rejected', false, 'connection opened'); bad.close(); resolve(); });
    bad.on('error', (err) => { ok('bad token rejected', /401/.test(err.message), err.message); resolve(); });
  });

  // 2. wrong path on the public lane is refused (it is the ONE public surface)
  await new Promise((resolve) => {
    const wrong = new WebSocket(`ws://127.0.0.1:${EXT_PORT}/devtools/page/x`, [SUBPROTOCOL, `token.${TOKEN}`]);
    wrong.on('open', () => { ok('non-/ext path refused on public lane', false, 'opened'); wrong.close(); resolve(); });
    wrong.on('error', (err) => { ok('non-/ext path refused on public lane', /404/.test(err.message), err.message); resolve(); });
  });

  // 3. no extension yet -> no targets, lease refused
  const emptyTargets = await (await fetch(`${BASE}/json/list`)).json();
  ok('no targets without an extension', Array.isArray(emptyTargets) && emptyTargets.length === 0);
  const noExt = await fetch(`${BASE}/lease`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok('lease refused without an extension', noExt.status === 503);

  // 4. extension connects
  const ext = fakeExtension();
  await new Promise((resolve) => ext.ws.once('open', resolve));
  await sleep(50);
  const status = await (await fetch(`${BASE}/status`)).json();
  ok('status reports extension connected', status.extension.connected === true, JSON.stringify(status.extension));

  // 5. provider hands back a lease
  const provider = new LocalRelayProvider({ baseUrl: BASE });
  const lease = await provider.acquire({ ttl: 60_000 });
  ok('lease has an id and a cdpUrl', Boolean(lease.leaseId) && /^ws:\/\/127\.0\.0\.1:/.test(lease.cdpUrl), lease.cdpUrl);
  ok('lease targets the reported tab', lease.tabId === 42, String(lease.tabId));

  // 6. second acquire is refused while one is live (one real browser, one driver)
  let doubleRefused = false;
  try { await provider.acquire({}); } catch (err) { doubleRefused = /already active/.test(err.message); }
  ok('second lease refused while one is active', doubleRefused);

  // 7. a stock-shaped CDP client attaches and drives
  const client = cdpClient(lease.cdpUrl);
  await client.ready;
  await sleep(50);
  ok('extension was told to attach', ext.seen.attach === 1, String(ext.seen.attach));

  const nav = await client.send('Page.navigate', { url: 'https://example.com/docs/intro' });
  ok('Page.navigate reaches the extension', nav.result && nav.result.echoed === 'Page.navigate', JSON.stringify(nav));

  const snap = await client.send('_br.snapshot', {});
  ok('_br.snapshot reaches the extension', snap.result && snap.result.echoed === '_br.snapshot');

  // 8. the chokepoint holds on the live path, not just in unit tests
  const evil = await client.send('Runtime.evaluate', { expression: '1+1' });
  ok('Runtime.evaluate refused on the wire', Boolean(evil.error) && /banned/.test(evil.error.message), JSON.stringify(evil));

  const pay = await client.send('Page.navigate', { url: 'https://shop.example.com/checkout' });
  ok('blocklisted URL refused on the wire', Boolean(pay.error) && /blocklisted/.test(pay.error.message), JSON.stringify(pay));

  const unknown = await client.send('Emulation.setDeviceMetricsOverride', {});
  ok('unknown method refused on the wire', Boolean(unknown.error) && unknown.error.code === -32601);

  ok('refused frames never reached the extension',
     ext.seen.methods.every((m) => m === 'Page.navigate' || m === '_br.snapshot'),
     ext.seen.methods.join(','));

  // 9. idempotency: a retry replays instead of re-navigating
  const key = 'smoke-key-1';
  const first = await client.send('_br.navigate', { url: 'https://example.com/a', __idempotencyKey: key });
  const retry = await client.send('_br.navigate', { url: 'https://example.com/a', __idempotencyKey: key });
  ok('idempotent retry is replayed', retry.result && retry.result.replayed === true, JSON.stringify(retry));
  ok('idempotent retry did not re-reach the extension',
     ext.seen.methods.filter((m) => m === '_br.navigate').length === 1,
     ext.seen.methods.join(','));
  ok('first call was not marked replayed', first.result && first.result.replayed === undefined);

  // 10. revoking the lease tears down both sides
  const revoked = await lease.revoke();
  const closeCode = await client.closed;
  await sleep(50);
  ok('revoke reported ok', revoked === true);
  ok('agent socket closed on revoke', closeCode === 4003, String(closeCode));
  ok('extension told the lease is gone', ext.seen.leaseLost === 1, String(ext.seen.leaseLost));
  ok('extension told to detach', ext.seen.detach === 1, String(ext.seen.detach));

  // 11. attaching to a dead lease is refused
  const gone = cdpClient(lease.cdpUrl);
  await new Promise((resolve) => {
    gone.ws.on('open', () => { ok('dead lease rejected', false, 'opened'); resolve(); });
    gone.ws.on('error', (err) => { ok('dead lease rejected', /410/.test(err.message), err.message); resolve(); });
  });

  // 12. /json/list mints a lease for a stock client that knows nothing else
  const targets = await (await fetch(`${BASE}/json/list`)).json();
  ok('/json/list auto-mints a target', targets.length === 1 && /devtools\/page\//.test(targets[0].webSocketDebuggerUrl));
  ok('/json/list reports the real tab url', targets[0].url === 'https://example.com/docs', targets[0].url);
  const version = await (await fetch(`${BASE}/json/version`)).json();
  ok('/json/version is Chrome-shaped', version['Protocol-Version'] === '1.3');

  // 13. lease expiry closes the socket without anyone asking
  const shortRaw = await (await fetch(`${BASE}/lease/${targets[0].id}`, { method: 'DELETE' })).json();
  ok('auto-minted lease revocable', shortRaw.ok === true);
  // Long enough to attach while it is alive; the sweeper (5s) then closes it
  // without anyone asking, which is the property under test.
  const short = await provider.acquire({ ttl: 1200 });
  const shortClient = cdpClient(short.cdpUrl);
  await shortClient.ready;
  const shortClosed = await Promise.race([shortClient.closed, sleep(12_000).then(() => 'timeout')]);
  ok('expired lease closes the agent socket unprompted', shortClosed === 4003, String(shortClosed));

  relay.close();
  ext.ws.close();
  await sleep(50);

  console.log(failures.length
    ? `\nsmoke: ${pass} passed, ${failures.length} FAILED`
    : `\nsmoke: ${pass} assertions passed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('smoke: crashed', err);
  process.exit(1);
});
