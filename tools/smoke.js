'use strict';
/*
 * Loopback round trip against a FAKE extension: proves the relay is a pipe.
 *
 *   bad key         -> 401
 *   good key        -> connected, hello recorded in /status
 *   POST /rpc       -> extension sees {type:'req', method, params, requestId}, answer comes back
 *   ext error frame -> 200 {ok:false, code}
 *   timeout         -> 504 EXT_TIMEOUT
 *   offline         -> 503 EXT_OFFLINE, unknown keyId -> 404
 *   two extensions  -> omitted endpoint -> 400 AMBIGUOUS_ENDPOINT; explicit works
 *   ext chat        -> c4-receive stub called with --channel browser-remote --endpoint <keyId>
 *   POST /chat      -> extension receives {type:'chat', role:'assistant'}
 *   reconnect       -> old socket closed 4001, in-flight request fails EXT_OFFLINE
 *
 * Run: node tools/smoke.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const WebSocket = require('ws');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-smoke-'));
const keysPath = path.join(tmp, 'keys.json');
const c4Log = path.join(tmp, 'c4.jsonl');
const c4Stub = path.join(tmp, 'c4-receive-stub.js');
fs.writeFileSync(c4Stub, `
  require('fs').appendFileSync(${JSON.stringify(c4Log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
  console.log(JSON.stringify({ ok: true, action: 'queued', id: 1 }));
`);
process.env.BROWSER_REMOTE_KEYS_FILE = keysPath;
process.env.ZYLOS_C4_RECEIVE = c4Stub;
delete process.env.BROWSER_REMOTE_KEY;

const { start } = require('../relay/server');
const { SUBPROTOCOL } = require('../relay/ext-lane');
const { newKey, keyIdOf } = require('../relay/keys');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed++;
  console.log('  ok', msg);
}

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    }).on('error', reject);
  });
}

/** Minimal extension: answers `req` via a handler, records everything. */
function fakeExt(port, key, { version = '9.9.9', handler } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, [SUBPROTOCOL, `key.${key}`]);
  const ext = { ws, frames: [], closeCode: null, open: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }) };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', version, capabilities: ['navigate', 'snapshot', 'chat-ack-v1'] })));
  ws.on('close', (code) => { ext.closeCode = code; });
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw.toString());
    ext.frames.push(m);
    if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: m.ts }));
    if (m.type === 'chat' && m.id) ws.send(JSON.stringify({ type: 'chat-ack', id: m.id }));
    if (m.type === 'req' && handler) {
      const out = await handler(m);
      if (out) ws.send(JSON.stringify({ id: m.id, ...out }));
    }
  });
  ext.waitFor = (pred, ms = 2000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ext.frames.find(pred);
      if (hit) return res(hit);
      if (Date.now() - t0 > ms) return rej(new Error('frame not seen'));
      setTimeout(tick, 10);
    };
    tick();
  });
  return ext;
}

function expectUpgradeStatus(port, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, protocols);
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => {});
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const relay = await start({ extPort: 0, agentPort: 0 });
  const extPort = relay.ext.server.address().port;
  const agentPort = relay.agent.server.address().port;

  const a = newKey({ label: 'alpha' });
  const b = newKey({ label: 'beta' });
  ok(a.keyId === keyIdOf(a.key) && a.keyId.length === 12, 'keyId is 12-hex sha256 prefix');
  ok(!fs.readFileSync(keysPath, 'utf8').includes(a.key), 'keys.json stores digests, never the key');

  console.log('-- auth');
  ok((await expectUpgradeStatus(extPort, [SUBPROTOCOL, 'key.deadbeefdeadbeefdeadbeef'])) === 401, 'bad key -> 401');
  ok((await expectUpgradeStatus(extPort, [SUBPROTOCOL])) === 401, 'no key -> 401');
  ok((await expectUpgradeStatus(extPort, ['zylos-browser-remote.v1', `key.${a.key}`])) === 401, 'old subprotocol -> 401');

  console.log('-- rpc');
  const seen = [];
  const extA = fakeExt(extPort, a.key, {
    handler: async (m) => {
      seen.push(m);
      if (m.method === 'navigate') return { type: 'resp', result: { url: m.params.url, settled: true } };
      if (m.method === 'click') return { type: 'error', code: 'BLOCKED_URL', message: 'payment host', details: { host: 'pay.example' } };
      if (m.method === 'hang') return null;
      return { type: 'resp', result: { echo: m.method } };
    },
  });
  await extA.open;
  await sleep(50);
  const st = await get(agentPort, '/status');
  ok(st.body.extensions[a.keyId] && st.body.extensions[a.keyId].version === '9.9.9', '/status shows connected extension with hello version');
  ok(st.body.extensions[a.keyId].label === 'alpha', '/status carries key label');

  let r = await post(agentPort, '/rpc', { method: 'navigate', params: { url: 'https://example.com' }, requestId: 'req-1' });
  ok(r.status === 200 && r.body.ok === true && r.body.result.settled === true, '/rpc forwards and returns result');
  ok(r.body.endpoint === a.keyId, '/rpc echoes resolved endpoint');
  const fwd = seen.find((m) => m.method === 'navigate');
  ok(fwd.type === 'req' && fwd.requestId === 'req-1' && typeof fwd.deadline === 'number', 'extension saw req with requestId + deadline');
  ok(fwd.params.url === 'https://example.com', 'params forwarded verbatim');

  r = await post(agentPort, '/rpc', { method: 'click', params: { selector: 'a' } });
  ok(r.status === 200 && r.body.ok === false && r.body.code === 'BLOCKED_URL' && r.body.details.host === 'pay.example', 'extension error -> 200 ok:false with code/details');

  r = await post(agentPort, '/rpc', { method: 'Runtime.evaluate', params: {} });
  ok(r.status === 200 && r.body.ok === true && r.body.result.echo === 'Runtime.evaluate', 'relay has no allowlist: unknown methods pass through (policy is the extension\'s)');

  r = await post(agentPort, '/rpc', { method: 'hang', timeoutMs: 1000 });
  ok(r.status === 504 && r.body.code === 'EXT_TIMEOUT', 'unanswered request -> 504 EXT_TIMEOUT');

  r = await post(agentPort, '/rpc', { method: 'bad method!' });
  ok(r.status === 400 && r.body.code === 'BAD_REQUEST', 'malformed method -> 400');
  r = await post(agentPort, '/rpc', { method: 'x', params: [1] });
  ok(r.status === 400, 'array params -> 400');
  r = await post(agentPort, '/rpc', { method: 'x', endpoint: 'ZZZ' });
  ok(r.status === 400 && r.body.code === 'BAD_ENDPOINT', 'malformed endpoint -> 400');
  r = await post(agentPort, '/rpc', { method: 'x', endpoint: '000000000000' });
  ok(r.status === 404 && r.body.code === 'UNKNOWN_ENDPOINT', 'unknown keyId -> 404');
  r = await post(agentPort, '/rpc', { method: 'x', endpoint: b.keyId });
  ok(r.status === 503 && r.body.code === 'EXT_OFFLINE', 'known but disconnected keyId -> 503');

  console.log('-- two extensions');
  const extB = fakeExt(extPort, b.key, { handler: async () => ({ type: 'resp', result: { who: 'beta' } }) });
  await extB.open;
  await sleep(50);
  r = await post(agentPort, '/rpc', { method: 'info' });
  ok(r.status === 400 && r.body.code === 'AMBIGUOUS_ENDPOINT', 'two connected + no endpoint -> 400 AMBIGUOUS_ENDPOINT');
  r = await post(agentPort, '/rpc', { method: 'info', endpoint: b.keyId });
  ok(r.body.ok && r.body.result.who === 'beta', 'explicit endpoint routes to the right extension');
  r = await post(agentPort, '/chat', { endpoint: b.keyId, text: '你好 beta' });
  ok(r.status === 202 && r.body.queued && !r.body.delivered, 'POST /chat persisted pending browser acknowledgement');
  const chatB = await extB.waitFor((m) => m.type === 'chat');
  ok(chatB.role === 'assistant' && chatB.text === '你好 beta', 'extension B received the chat frame');
  ok(chatB.final === true, 'ordinary replies are final by default');
  ok(!extA.frames.some((m) => m.type === 'chat'), 'extension A did not');
  r = await post(agentPort, '/chat', { endpoint: b.keyId, text: '查询中', final: false });
  const progress = await extB.waitFor((m) => m.type === 'chat' && m.text === '查询中');
  ok(r.body.ok && progress.final === false, 'explicit progress stays non-final');
  r = await post(agentPort, '/chat', { endpoint: b.keyId, text: 'Invalid final', final: 'false' });
  ok(r.status === 400 && r.body.code === 'BAD_REQUEST', 'invalid final flag rejected');
  extB.ws.close();
  await sleep(50);

  console.log('-- chat ingress -> C4');
  extA.ws.send(JSON.stringify({ type: 'chat', text: '帮我搜蜘蛛侠 "quoted" $(rm -rf) ; done', ts: Date.now() }));
  await sleep(400);
  const calls = fs.readFileSync(c4Log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(calls.length === 1, 'c4-receive stub spawned once');
  const argv = calls[0];
  ok(argv[argv.indexOf('--channel') + 1] === 'browser-remote', '--channel browser-remote');
  ok(argv[argv.indexOf('--endpoint') + 1] === a.keyId, '--endpoint is the keyId');
  ok(argv[argv.indexOf('--content') + 1] === '[Browser] 帮我搜蜘蛛侠 "quoted" $(rm -rf) ; done', 'content prefixed, otherwise verbatim (single argv, no shell)');

  extA.ws.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(8001), ts: Date.now() }));
  const refused = await extA.waitFor((m) => m.type === 'chat-status' && m.state === 'failed');
  ok(/too long/.test(refused.error), 'over-cap chat refused loudly, not truncated');
  extA.ws.send(JSON.stringify({ type: 'chat', text: '', ts: Date.now() }));
  await sleep(100);
  ok(fs.readFileSync(c4Log, 'utf8').trim().split('\n').length === 1, 'refused chats never reach C4');

  console.log('-- reconnect supersedes');
  const hangP = post(agentPort, '/rpc', { method: 'hang', timeoutMs: 5000 });
  await extA.waitFor((m) => m.method === 'hang' && m.type === 'req' && m.id > 3);
  const extA2 = fakeExt(extPort, a.key, { handler: async () => ({ type: 'resp', result: { gen: 2 } }) });
  await extA2.open;
  const hung = await hangP;
  ok(hung.status === 503 && hung.body.code === 'EXT_OFFLINE', 'in-flight request fails fast when the extension reconnects');
  await sleep(50);
  ok(extA.closeCode === 4001, 'old socket closed with 4001');
  r = await post(agentPort, '/rpc', { method: 'info' });
  ok(r.body.ok && r.body.result.gen === 2, 'new socket serves requests');

  console.log('-- offline');
  extA2.ws.close();
  await sleep(50);
  r = await post(agentPort, '/rpc', { method: 'info' });
  ok(r.status === 503 && r.body.code === 'EXT_OFFLINE', 'no extension -> 503 EXT_OFFLINE');
  r = await post(agentPort, '/chat', { text: 'hi' });
  ok(r.status === 503, '/chat with no extension -> 503');

  console.log('-- public lane exposes only /ext');
  const probe = await new Promise((res) => http.get({ host: '127.0.0.1', port: extPort, path: '/rpc' }, (resp) => res(resp.statusCode)));
  ok(probe === 426, 'plain HTTP on :3802 -> 426');
  ok((await expectUpgradeStatus(extPort, [SUBPROTOCOL, `key.${a.key}`])) === 101, 'good key still accepted after all that');

  relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsmoke: ${passed} assertions passed`);
  process.exit(0);
})().catch((err) => {
  console.error('\nsmoke FAILED:', err);
  process.exit(1);
});
