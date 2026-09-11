'use strict';
/*
 * Regression test for the two relay defects that made a healthy extension look
 * completely dead during bobo's first live session (2026-09-11).
 *
 * BUG 1 -- agent-lane registered ws.on('message') only AFTER awaiting the
 *   extension `attach` handshake. Frames sent by a client in that window were
 *   dropped: no response, no error, no log line.
 * BUG 2 -- ext-lane._onConnected reassigned this.ws to the new socket before
 *   the old socket's close fired, so the close handler's `this.ws === ws` guard
 *   was false and _failAllPending never ran. An in-flight request on a
 *   superseded socket hung for its full 30s timeout. MV3 recycles the service
 *   worker routinely, so this fired in normal use.
 *
 * Together: extension reconnects -> attach orphaned for 30s -> agent-lane never
 * registers its handler -> every command vanishes silently.
 *
 * Both tests FAIL against the pre-fix relay, which is the point.
 *
 * Run: node tools/test-handshake-race.js
 */

const WebSocket = require('ws');
const { start } = require('../relay/server');
const { SUBPROTOCOL } = require('../relay/ext-lane');

const TOKEN = 'handshake-race-token-not-a-secret';
const EXT_PORT = 3912;            // never 3802/3803: must not collide with the live relay
const AGENT_PORT = 3913;
const BASE = `http://127.0.0.1:${AGENT_PORT}`;
const TABS = [{ id: 42, url: 'https://example.com/docs', title: 'Docs' }];

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  require('http').get(url, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

/**
 * Fake extension. `attachDelayMs` stalls the attach reply so a test can act
 * inside the handshake window; `stallAttach` never answers it at all.
 */
function fakeExtension({ attachDelayMs = 0, stallAttach = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${EXT_PORT}/ext`, [SUBPROTOCOL, `token.${TOKEN}`]);
  const seen = { attach: 0, methods: [] };
  ws.on('open', () => ws.send(JSON.stringify({
    type: 'hello', version: '0.1.0', capabilities: ['_br.snapshot'], tabs: TABS,
  })));
  ws.on('error', () => { /* superseded sockets error on close; not a test failure */ });
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type === 'attach') {
      seen.attach++;
      if (stallAttach) return undefined;               // deliberately never answer
      if (attachDelayMs) await sleep(attachDelayMs);
      return ws.send(JSON.stringify({ id: msg.id, type: 'resp', result: { attached: msg.tabId } }));
    }
    if (msg.type === 'detach') return ws.send(JSON.stringify({ id: msg.id, type: 'resp', result: {} }));
    if (msg.type === 'req') {
      seen.methods.push(msg.method);
      return ws.send(JSON.stringify({ id: msg.id, type: 'resp', result: { echoed: msg.method } }));
    }
    return undefined;
  });
  return { ws, seen };
}

/** Minimal CDP client that can fire a command the instant the socket opens. */
function cdpClient(url) {
  const ws = new WebSocket(url);
  const waiters = new Map();
  let id = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); w(m); }
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws,
    opened,
    /** Resolves with the reply, or {TIMEOUT:true} after ms. */
    call(method, params = {}, ms = 10_000) {
      const i = ++id;
      return new Promise((resolve) => {
        const t = setTimeout(() => { waiters.delete(i); resolve({ TIMEOUT: true }); }, ms);
        waiters.set(i, (m) => { clearTimeout(t); resolve(m); });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* gone */ } },
  };
}

async function main() {
  const relay = await start({ token: TOKEN, extPort: EXT_PORT, agentPort: AGENT_PORT, log: () => {} });

  // ---- BUG 1: a command sent inside the handshake window must be answered ----
  console.log('\nBUG 1 -- command sent before the attach handshake completes');
  {
    const ext = fakeExtension({ attachDelayMs: 1500 });   // hold the handshake open
    await sleep(300);
    const list = await getJson(`${BASE}/json/list`);
    const agent = cdpClient(list[0].webSocketDebuggerUrl);
    await agent.opened;

    // No settle wait on purpose: this is exactly what a stock client does.
    const reply = await agent.call('_br.snapshot', {}, 12_000);

    ok('command sent during the handshake is answered, not dropped',
      !reply.TIMEOUT, JSON.stringify(reply).slice(0, 120));
    ok('and it actually reached the extension',
      ext.seen.methods.includes('_br.snapshot'), `methods=${JSON.stringify(ext.seen.methods)}`);
    agent.close();
    ext.ws.close();
    await sleep(300);
  }

  // ---- BUG 2: superseding the ext socket must fail in-flight work at once ----
  console.log('\nBUG 2 -- extension reconnects while an attach is in flight');
  {
    const ext1 = fakeExtension({ stallAttach: true });    // never answers attach
    await sleep(300);
    const list = await getJson(`${BASE}/json/list`);
    const agent = cdpClient(list[0].webSocketDebuggerUrl);
    await agent.opened;
    const started = Date.now();
    const replyPromise = agent.call('_br.snapshot', {}, 20_000);

    // The extension service worker recycles and re-dials mid-handshake.
    await sleep(600);
    const ext2 = fakeExtension();
    await sleep(1500);

    const reply = await replyPromise;
    const elapsed = Date.now() - started;

    // The orphaned attach must be abandoned promptly rather than held for the
    // relay's full 30s command timeout.
    ok('in-flight request is failed fast on supersede, not left for 30s',
      elapsed < 10_000, `elapsed=${elapsed}ms`);
    ok('the client is told something rather than left hanging',
      !reply.TIMEOUT, JSON.stringify(reply).slice(0, 160));

    agent.close();
    ext1.ws.close();
    ext2.ws.close();
    await sleep(300);
  }

  // ---- the reconnected extension must still be usable afterwards ----
  console.log('\nrecovery -- the lane still works after a supersede');
  {
    const ext = fakeExtension();
    await sleep(400);
    const list = await getJson(`${BASE}/json/list`);
    const agent = cdpClient(list[0].webSocketDebuggerUrl);
    await agent.opened;
    await sleep(600);
    const reply = await agent.call('_br.snapshot', {}, 10_000);
    ok('a fresh agent command succeeds after all that',
      !reply.TIMEOUT && !!reply.result, JSON.stringify(reply).slice(0, 160));
    agent.close();
    ext.ws.close();
  }

  relay.close();
  console.log(`\nhandshake-race: ${pass} assertions passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(`FAILED: ${e.stack}`); process.exit(1); });
