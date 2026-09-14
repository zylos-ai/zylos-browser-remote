'use strict';
/*
 * The agent's view: a REAL relay process, the real scripts (key.js, browser.js,
 * send.js) invoked exactly as SKILL.md tells the agent to, and a fake extension
 * on the far end. Proves the CLI contract end to end, including screenshot
 * stashing and the exit-code rules.
 *
 * Run: node tools/test-cli.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cli-'));
const EXT_PORT = 38020 + Math.floor(Math.random() * 500);
const AGENT_PORT = EXT_PORT + 1;
const env = {
  ...process.env,
  BROWSER_REMOTE_KEYS_FILE: path.join(tmp, 'keys.json'),
  BROWSER_REMOTE_OBS_DIR: path.join(tmp, 'obs'),
  BROWSER_REMOTE_EXT_PORT: String(EXT_PORT),
  BROWSER_REMOTE_AGENT_PORT: String(AGENT_PORT),
  ZYLOS_C4_RECEIVE: path.join(tmp, 'c4-stub.js'),
};
delete env.BROWSER_REMOTE_KEY;
fs.writeFileSync(env.ZYLOS_C4_RECEIVE, `require('fs').appendFileSync(${JSON.stringify(path.join(tmp, 'c4.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`);

let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok', m); };
// Async on purpose: the fake extension lives in THIS process, so a blocking
// spawnSync would stop it from ever answering the relay.
const run = (script, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { env });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => {
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    resolve({ code, out, err, json });
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('-- key.js');
  const minted = await run('key.js', ['new', '--label', 'cli-test']);
  const key = /key:\s+([a-f0-9]{64})/.exec(minted.out)[1];
  const keyId = /keyId:\s+([a-f0-9]{12})/.exec(minted.out)[1];
  ok(minted.code === 0 && key && keyId, 'key.js new prints key + keyId once');
  ok(/cli-test/.test((await run('key.js', ['list'])).out), 'key.js list shows the label');

  console.log('-- relay down');
  let r = await run('browser.js', ['status']);
  ok(r.code === 1 && r.json.code === 'RELAY_DOWN', 'browser.js reports RELAY_DOWN with exit 1');

  const relay = spawn(process.execPath, [path.join(ROOT, 'relay', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let relayLog = '';
  relay.stdout.on('data', (d) => (relayLog += d));
  relay.stderr.on('data', (d) => (relayLog += d));
  for (let i = 0; i < 50 && !/agent lane/.test(relayLog); i++) await sleep(100);
  ok(/keys: 1 loaded/.test(relayLog), 'relay loaded the minted key');

  console.log('-- no extension');
  r = await run('browser.js', ['status']);
  ok(r.code === 0 && r.json.ok && Object.keys(r.json.extensions).length === 0, 'status ok with zero extensions');
  r = await run('browser.js', ['open', 'url=https://example.com']);
  ok(r.code === 1 && r.json.code === 'EXT_OFFLINE', 'open with no extension -> EXT_OFFLINE exit 1');
  r = await run('send.js', [keyId, 'hello']);
  ok(r.code === 3, 'send.js exits 3 when the browser is offline');

  console.log('-- fake extension joins');
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${EXT_PORT}/ext`, ['zylos-browser-remote.v2', `key.${key}`]);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    seen.push(m);
    if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: m.ts }));
    if (m.type !== 'req') return;
    if (m.method === 'screenshot') return ws.send(JSON.stringify({ id: m.id, type: 'resp', result: { format: 'png', data: png.toString('base64').repeat(20) } }));
    if (m.method === 'click') return ws.send(JSON.stringify({ id: m.id, type: 'error', code: 'STALE_ELEMENT', message: 'page changed' }));
    ws.send(JSON.stringify({ id: m.id, type: 'resp', result: { method: m.method, params: m.params, requestId: m.requestId } }));
  });
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ type: 'hello', version: '1.0.0', capabilities: ['open', 'click'] }));
  await sleep(100);

  r = await run('browser.js', ['status']);
  ok(r.json.extensions[keyId] && r.json.extensions[keyId].label === 'cli-test', 'status lists the extension under its keyId');

  console.log('-- browser.js params + requestId');
  r = await run('browser.js', ['open', 'url=https://example.com', 'timeoutMs=1500']);
  ok(r.code === 0 && r.json.ok && r.json.endpoint === keyId, 'k=v params, ok exit 0, endpoint echoed');
  ok(r.json.result.params.url === 'https://example.com' && r.json.result.params.timeoutMs === 1500, 'string stays string, number parsed');
  ok(/^[0-9a-f-]{36}$/.test(r.json.result.requestId), 'a uuid requestId rides along');
  r = await run('browser.js', ['--endpoint', keyId, 'scroll', '{"direction":"down","pixels":300}']);
  ok(r.code === 0 && r.json.result.params.pixels === 300, 'JSON params + explicit --endpoint');
  r = await run('browser.js', ['click', 'ref=e1']);
  ok(r.code === 1 && r.json.ok === false && r.json.code === 'STALE_ELEMENT', 'extension error -> exit 1 with code');
  r = await run('browser.js', ['click', 'garbage']);
  ok(r.code === 2, 'bad k=v -> usage exit 2');

  console.log('-- screenshot stashing');
  r = await run('browser.js', ['screenshot']);
  ok(r.code === 0 && r.json.result.path && !r.json.result.data && r.json.result.imageReadRequired === true, 'base64 replaced by a file path');
  ok(fs.existsSync(r.json.result.path) && fs.readFileSync(r.json.result.path).subarray(0, 8).equals(png.subarray(0, 8)), 'file is the decoded PNG');
  ok(r.json.result.path.startsWith(env.BROWSER_REMOTE_OBS_DIR), 'stored under the observations dir');

  console.log('-- chat both ways');
  r = await run('send.js', [keyId, '找到了', '第一条']);
  ok(r.code === 0, 'send.js exit 0 on delivery');
  await sleep(50);
  const bubble = seen.find((m) => m.type === 'chat');
  ok(bubble && bubble.role === 'assistant' && bubble.text === '找到了 第一条', 'panel received the assistant bubble');
  r = await run('browser.js', ['chat', '直接', 'chat', '子命令']);
  ok(r.code === 0 && seen.filter((m) => m.type === 'chat').length === 2, 'browser.js chat works too');
  r = await run('send.js', ['not-a-keyid', 'x']);
  ok(r.code === 2, 'send.js rejects a malformed endpoint with exit 2');

  ws.send(JSON.stringify({ type: 'chat', text: '帮我看看这个', ts: Date.now() }));
  await sleep(300);
  const c4 = JSON.parse(fs.readFileSync(path.join(tmp, 'c4.log'), 'utf8').trim());
  ok(c4[c4.indexOf('--channel') + 1] === 'browser-remote' && c4[c4.indexOf('--endpoint') + 1] === keyId, 'owner chat reached c4-receive with channel + keyId');
  ok(c4[c4.indexOf('--content') + 1] === '[Browser] 帮我看看这个', 'content carries the [Browser] prefix');

  console.log('-- revoke');
  ok(/revoked/.test((await run('key.js', ['revoke', keyId])).out), 'key.js revoke');
  const ws2 = new WebSocket(`ws://127.0.0.1:${EXT_PORT}/ext`, ['zylos-browser-remote.v2', `key.${key}`]);
  const status = await new Promise((res) => { ws2.on('unexpected-response', (_q, resp) => res(resp.statusCode)); ws2.on('open', () => res(101)); ws2.on('error', () => {}); });
  ok(status === 401, 'revoked key is refused on the next handshake without a relay restart');

  ws.close();
  relay.kill('SIGTERM');
  await sleep(100);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ntest-cli: ${passed} assertions passed`);
  process.exit(0);
})().catch((err) => {
  console.error('\ntest-cli FAILED:', err);
  process.exit(1);
});
