'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const { start } = require('../relay/server');
const { newKey } = require('../relay/keys');
const { ChatOutbox, MAX_PENDING } = require('../relay/chat-outbox');

async function waitFor(predicate) {
  for (let n = 0; n < 200; n++) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected delivery state not observed');
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-outbox-'));
  const previous = { keys: process.env.BROWSER_REMOTE_KEYS_FILE, key: process.env.BROWSER_REMOTE_KEY };
  process.env.BROWSER_REMOTE_KEYS_FILE = path.join(dir, 'keys.json');
  delete process.env.BROWSER_REMOTE_KEY;
  const owner = newKey({ label: 'owner' });
  const other = newKey({ label: 'other' });
  const file = path.join(dir, 'outbox.json');
  let relay;
  const sockets = [];
  const launch = async () => { relay = await start({ extPort: 0, agentPort: 0, outboxFile: file, onChat: async () => ({ ok: true }) }); };
  const close = async () => {
    sockets.forEach((ws) => ws.terminate());
    const closed = [once(relay.ext.server, 'close'), once(relay.agent.server, 'close')];
    relay.close();
    await Promise.all(closed);
  };
  await launch();
  t.after(async () => {
    await close();
    if (previous.keys === undefined) delete process.env.BROWSER_REMOTE_KEYS_FILE;
    else process.env.BROWSER_REMOTE_KEYS_FILE = previous.keys;
    if (previous.key === undefined) delete process.env.BROWSER_REMOTE_KEY;
    else process.env.BROWSER_REMOTE_KEY = previous.key;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${relay.agent.server.address().port}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const connect = async (identity, ack = true) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.ext.server.address().port}/ext`, ['zylos-browser-remote.v2', `key.${identity.key}`]);
    sockets.push(ws);
    ws.frames = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      ws.frames.push(m);
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (m.type === 'chat' && ack) ws.send(JSON.stringify({ type: 'chat-ack', id: m.id }));
      if (m.type === 'req') ws.send(JSON.stringify({ type: 'resp', id: m.id, result: { received: m.method } }));
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', capabilities: ['chat-ack-v1'] }));
    return ws;
  };
  return { owner, other, file, post, connect, relay: () => relay, restart: async () => { await close(); await launch(); } };
}

test('offline final replies survive restart, replay after a lost ack, and stay isolated by key', async (t) => {
  const s = await fixture(t);
  let result = await s.post('/chat', { endpoint: s.owner.keyId, text: 'Video could not start' });
  assert.equal(result.status, 202);
  assert.equal(result.body.delivered, false);
  const id = result.body.messageId;
  assert.equal(JSON.parse(fs.readFileSync(s.file)).messages[0].id, id);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  result = await s.post('/rpc', { endpoint: s.owner.keyId, method: 'click' });
  assert.equal(result.body.code, 'EXT_OFFLINE');
  await s.restart();
  const other = await s.connect(s.other, false);
  const first = await s.connect(s.owner, false);
  await waitFor(() => first.frames.find((m) => m.id === id));
  assert.equal(other.frames.some((m) => m.type === 'chat'), false);
  other.send(JSON.stringify({ type: 'chat-ack', id }));
  result = await s.post('/rpc', { endpoint: s.owner.keyId, method: 'open' });
  assert.equal(result.body.code, 'CHAT_PENDING');
  assert.equal(s.relay().ext.outbox.first(s.owner.keyId).id, id);
  first.terminate();
  await waitFor(() => !s.relay().ext.isConnected(s.owner.keyId));
  const next = await s.connect(s.owner);
  const replay = await waitFor(() => next.frames.find((m) => m.type === 'chat'));
  assert.equal(replay.id, id);
  assert.equal(replay.text, 'Video could not start');
  await waitFor(() => !s.relay().ext.outbox.first(s.owner.keyId));
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file)).messages, []);
  result = await s.post('/rpc', { endpoint: s.owner.keyId, method: 'open' });
  assert.equal(result.body.result.received, 'open');
  assert.equal(next.frames.filter((m) => m.type === 'req').length, 1, 'only the new command is executed');
});

test('progress requires a live socket; invalid keys and failed storage never report queued success', async (t) => {
  const s = await fixture(t);
  assert.equal((await s.post('/chat', { endpoint: s.owner.keyId, text: 'Searching', final: false })).body.code, 'EXT_OFFLINE');
  assert.equal((await s.post('/chat', { endpoint: '0'.repeat(12), text: 'Result' })).body.code, 'UNKNOWN_ENDPOINT');
  fs.mkdirSync(s.file);
  const failed = await s.post('/chat', { endpoint: s.owner.keyId, text: 'Result' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'OUTBOX_WRITE_FAILED');
  assert.deepEqual(s.relay().ext.outbox.counts(), {});
});

test('outbox limits and revoked keys preserve accepted messages without silent overwrites', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-outbox-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'outbox.json');
  const box = new ChatOutbox(file);
  const key = 'a'.repeat(12), revoked = 'b'.repeat(12);
  const initial = box.enqueue(key, 'Keep this');
  for (let n = 1; n < MAX_PENDING; n++) box.enqueue(revoked, 'Offline');
  assert.throws(() => box.enqueue(key, 'Overflow'), (e) => e.code === 'OUTBOX_FULL');
  const reloaded = new ChatOutbox(file);
  assert.equal(reloaded.first(key).id, initial.id);
  reloaded.discardRevoked({ [key]: {} });
  assert.deepEqual(reloaded.counts(), { [key]: 1 });
  fs.writeFileSync(file, 'broken');
  assert.throws(() => new ChatOutbox(file));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});
