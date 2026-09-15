'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const { start, deliverChatToC4 } = require('../relay/server');

test('C4 queue receipts distinguish accepted, unavailable, failed and uncertain delivery', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-delivery-'));
  const previous = process.env.ZYLOS_C4_RECEIVE;
  const script = path.join(tmp, 'c4.js');
  process.env.ZYLOS_C4_RECEIVE = script;
  t.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_C4_RECEIVE;
    else process.env.ZYLOS_C4_RECEIVE = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const deliver = (timeoutMs = 2000) => deliverChatToC4(
    { keyId: 'a'.repeat(12), text: 'hello', chatId: 'chat-1' }, () => {}, { timeoutMs },
  );
  for (const action of ['queued', 'delivered', 'suppressed']) {
    fs.writeFileSync(script, `if (!process.argv.includes('--json')) process.exit(2); console.log(JSON.stringify({ok:true,action:${JSON.stringify(action)},id:7}));`);
    assert.deepEqual(await deliver(), action === 'queued' ? { ok: true } : { ok: false, code: 'AGENT_UNAVAILABLE' });
  }
  fs.writeFileSync(script, 'process.exit(1);');
  assert.deepEqual(await deliver(), { ok: false, code: 'C4_DELIVERY_FAILED' });
  fs.writeFileSync(script, 'console.log("unexpected output");');
  assert.deepEqual(await deliver(), { ok: false, code: 'C4_DELIVERY_UNCONFIRMED' });
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  assert.deepEqual(await deliver(100), { ok: false, code: 'C4_DELIVERY_TIMEOUT' });
  fs.unlinkSync(script);
  assert.deepEqual(await deliver(), { ok: false, code: 'C4_DELIVERY_FAILED' });
});

test('chat receipts are correlated, failures reach the browser, and a replaced socket gets no stale receipt', async (t) => {
  const previousKey = process.env.BROWSER_REMOTE_KEY;
  process.env.BROWSER_REMOTE_KEY = 'a'.repeat(64);
  const pending = new Map();
  const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-receipt-outbox-'));
  const relay = await start({ extPort: 0, agentPort: 0, outboxFile: path.join(outboxDir, 'outbox.json'), onChat: (message) => {
    if (message.text === 'fail') return { ok: false, code: 'C4_DELIVERY_FAILED' };
    if (message.text === 'throw') throw new Error('test failure');
    if (message.text === 'defer') return new Promise((resolve) => pending.set(message.chatId, resolve));
    return { ok: true };
  } });
  const sockets = [];
  t.after(() => {
    sockets.forEach((ws) => ws.terminate());
    relay.close();
    fs.rmSync(outboxDir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.BROWSER_REMOTE_KEY;
    else process.env.BROWSER_REMOTE_KEY = previousKey;
  });
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.ext.server.address().port}/ext`, ['zylos-browser-remote.v2', `key.${process.env.BROWSER_REMOTE_KEY}`]);
    sockets.push(ws);
    ws.frames = [];
    ws.on('message', (raw) => ws.frames.push(JSON.parse(raw)));
    await once(ws, 'open');
    return ws;
  };
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected receipt not observed');
  };
  const ws = await connect();
  for (const [id, text, state] of [['one', 'ok', 'queued'], ['two', 'fail', 'failed'], ['three', 'throw', 'unknown']]) {
    ws.send(JSON.stringify({ type: 'chat', id, text }));
    const receipt = await waitFor(() => ws.frames.find((frame) => frame.chatId === id));
    assert.equal(receipt.state, state);
    if (state !== 'queued') assert.ok(receipt.error);
  }
  ws.send(JSON.stringify({ type: 'chat', id: 'four', text: 'defer' }));
  await waitFor(() => pending.has('four'));
  const replacement = await connect();
  pending.get('four')({ ok: false, code: 'C4_DELIVERY_FAILED' });
  // A subsequent receipt proves the replacement socket has processed messages.
  replacement.send(JSON.stringify({ type: 'chat', id: 'five', text: 'ok' }));
  await waitFor(() => replacement.frames.some((frame) => frame.chatId === 'five'));
  assert.equal(replacement.frames.some((frame) => frame.chatId === 'four'), false);
});
