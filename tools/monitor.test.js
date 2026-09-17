'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const http = require('node:http');
const WebSocket = require('ws');
const { Monitor, MAX_RUNS, MAX_STEPS } = require('../relay/monitor');
const { start } = require('../relay/server');

test('monitor follows intake, running tools, failures and final acknowledgement without equating them', () => {
  let now = 1000;
  const monitor = new Monitor({ now: () => now });
  const ticket = monitor.received({ keyId: 'a', label: 'Browser', text: 'Search something', chatId: 'question-1' });
  assert.equal(ticket.run.status, 'queuing');
  now += 5; monitor.intake(ticket, { ok: true });
  assert.equal(ticket.run.status, 'waiting');
  const call = monitor.rpcStarted('a', { method: 'click', params: { ref: '@sample' }, requestId: 'request-1' });
  assert.equal(call.run, ticket.run);
  assert.equal(ticket.run.status, 'running');
  now += 25; monitor.rpcEnded(call, null, { code: 'STALE_ELEMENT', message: 'changed' });
  assert.equal(call.step.durationMs, 25);
  assert.equal(call.step.status, 'error');
  assert.equal(ticket.run.status, 'waiting');
  monitor.progress('a', 'Retrying');
  monitor.queuedReply({ keyId: 'a', messageId: 'reply-1', text: 'Could not finish' });
  assert.equal(ticket.run.status, 'reply_pending');
  monitor.acknowledged({ keyId: 'b', messageId: 'reply-1' });
  assert.equal(ticket.run.status, 'reply_pending');
  monitor.acknowledged({ keyId: 'a', messageId: 'reply-1' });
  assert.equal(ticket.run.status, 'delivered');
  const next = monitor.received({ keyId: 'a', text: 'Next question' });
  assert.notEqual(next.run.id, ticket.run.id);
  monitor.close();
});

test('monitor merges overlapping prompts and bounds/redacts diagnostic payloads', () => {
  const monitor = new Monitor();
  const first = monitor.received({ keyId: 'a', text: 'One' });
  const followup = monitor.received({ keyId: 'a', text: 'Two' });
  assert.equal(first.run, followup.run);
  assert.equal(first.run.messages, 2);
  const call = monitor.rpcStarted('a', { method: 'fill', params: { text: 'private-input', token: 'secret-token', url: 'https://user:pass@example.com/?token=secret#part' } });
  monitor.rpcEnded(call, { screenshot: { data: 'large-image-base64', mimeType: 'image/png' }, matches: Array.from({ length: 100 }, () => ({ text: 'x'.repeat(10000) })) });
  const serialized = JSON.stringify(monitor.runs);
  for (const value of ['private-input', 'secret-token', 'large-image-base64', 'user:pass', '?token=']) assert(!serialized.includes(value));
  assert(call.step.result.length <= 3520);
  for (let i = 0; i < MAX_STEPS + 5; i++) monitor.progress('a', 'progress');
  assert.equal(first.run.steps.length, MAX_STEPS);
  assert(first.run.omittedSteps > 0);
  for (let i = 0; i < MAX_RUNS + 5; i++) monitor.received({ keyId: `browser-${i}`, text: 'bounded' });
  assert.equal(monitor.runs.length, MAX_RUNS);
  assert(monitor.active.size <= MAX_RUNS);
  monitor.close();
});

test('composite diagnostics preserve partial progress and redact nested input without counting child RPCs', () => {
  const monitor = new Monitor();
  const call = monitor.rpcStarted('a', { method: 'step', params: {
    action: { op: 'fill', ref: '@input', text: 'private-nested-input' },
    wait: { condition: 'text', text: 'private-expected-text' },
    read: { op: 'find', selector: '#result' },
  } });
  const steps = [
    { method: 'fill', status: 'success', durationMs: 12, result: { done: true } },
    { method: 'wait', status: 'error', durationMs: 200, error: { code: 'WAIT_TIMEOUT', message: 'not ready' } },
    { method: 'find', status: 'skipped' },
  ];
  monitor.rpcEnded(call, undefined, { code: 'STEP_INCOMPLETE', message: 'Partial result', details: { completed: false, steps } });
  assert.equal(call.step.status, 'error');
  assert.deepEqual(call.step.parts, [
    { method: 'fill', status: 'success', durationMs: 12 },
    { method: 'wait', status: 'error', durationMs: 200, error: 'WAIT_TIMEOUT' },
    { method: 'find', status: 'skipped' },
  ]);
  const saved = JSON.stringify(monitor.runs);
  assert(!saved.includes('private-nested-input'));
  assert(!saved.includes('private-expected-text'));
  assert(call.step.result.includes('completed'));
  assert.deepEqual(call.run.toolCounts.browser, [{ name: 'step', count: 1 }]);
  const success = monitor.rpcStarted('a', { method: 'step' });
  monitor.rpcEnded(success, { completed: true, steps: [{ method: 'snapshot', status: 'success', durationMs: 4 }] });
  assert.equal(success.step.parts[0].method, 'snapshot');
  monitor.close();
});

test('monitor persists history, marks interrupted commands and accepts delayed final receipts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-monitor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'monitor.json');
  const first = new Monitor({ file });
  first.received({ keyId: 'a', text: 'Pending action' });
  first.rpcStarted('a', { method: 'wait' });
  first.received({ keyId: 'b', text: 'Pending reply' });
  first.queuedReply({ keyId: 'b', messageId: 'reply', text: 'Done' });
  first.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const restored = new Monitor({ file });
  assert.equal(restored.runs[0].status, 'interrupted');
  assert.equal(restored.runs[0].steps.at(-1).status, 'unknown');
  assert.equal(restored.runs[1].status, 'reply_pending');
  restored.acknowledged({ keyId: 'b', messageId: 'reply' });
  assert.equal(restored.runs[1].status, 'delivered');
  restored.close();
  fs.writeFileSync(file, 'broken-json');
  const broken = new Monitor({ file });
  broken.received({ keyId: 'a', text: 'Still records in memory' });
  broken.close();
  assert(broken.storageError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken-json');
});

async function until(work) {
  for (let i = 0; i < 150; i++) { const result = await work(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Expected monitor event was not observed');
}

test('local monitor exposes real chat/RPC/reply events, never appears on the public port and is read-only', async t => {
  const originalKey = process.env.BROWSER_REMOTE_KEY;
  process.env.BROWSER_REMOTE_KEY = 'a'.repeat(64);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-monitor-live-'));
  const logFile = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(logFile, '');
  const relay = await start({ extPort: 0, agentPort: 0, monitor: true, agentMonitorDir: dir,
    agentTraceOptions: { discover: async () => [{ id: 'test-session', rollout_path: logFile }] },
    outboxFile: path.join(dir, 'outbox.json'), onChat: async () => ({ ok: true }) });
  const base = `http://127.0.0.1:${relay.agent.server.address().port}`;
  const extBase = `http://127.0.0.1:${relay.ext.server.address().port}`;
  const ws = new WebSocket(extBase.replace('http:', 'ws:') + '/ext', ['zylos-browser-remote.v2', `key.${process.env.BROWSER_REMOTE_KEY}`]);
  const requests = [];
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'req' || m.type === 'chat') requests.push(m); });
  t.after(() => { ws.terminate(); relay.close(); fs.rmSync(dir, { recursive: true, force: true }); if (originalKey === undefined) delete process.env.BROWSER_REMOTE_KEY; else process.env.BROWSER_REMOTE_KEY = originalKey; });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', capabilities: ['chat-ack-v1'] }));
  ws.send(JSON.stringify({ type: 'chat', id: 'q1', text: '<img src=x onerror=alert(1)> Find an example' }));
  const get = async () => (await fetch(base + '/monitor/api')).json();
  const snapshot = await until(async () => { const s = await get(); return s.runs[0]?.status === 'waiting' && s; });
  assert(snapshot.runs[0].question.includes('<img'));
  const unchanged = await (await fetch(base + '/monitor/api?revision=' + snapshot.revision)).json();
  assert.equal(unchanged.unchanged, true); assert.equal(unchanged.runs, undefined);
  const stamp = new Date().toISOString();
  fs.appendFileSync(logFile, [
    { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text:
      `[Browser] Find an example ---- reply via: node /runtime/c4-send.js "browser-remote" "${snapshot.runs[0].keyId}"` }] } },
    { timestamp: stamp, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'agent-1', arguments: '{"cmd":"node browser.js observe"}' } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  await until(async () => (await get()).runs[0].steps.some(s => s.kind === 'agent' && s.status === 'running'));
  const pending = fetch(base + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'observe', requestId: 'tool-1' }) });
  const request = await until(() => requests.find(m => m.type === 'req'));
  assert.equal((await get()).runs[0].steps.at(-1).status, 'running');
  ws.send(JSON.stringify({ type: 'resp', id: request.id, result: { text: 'Example', screenshot: { data: 'base64-should-not-be-stored' } } }));
  assert.equal((await (await pending).json()).ok, true);
  assert.equal((await get()).runs[0].steps.at(-1).status, 'success');
  assert(!JSON.stringify(await get()).includes('base64-should-not-be-stored'));
  const reply = await (await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Found it' }) })).json();
  assert.equal((await get()).runs[0].status, 'reply_pending');
  await until(() => requests.find(m => m.type === 'chat' && m.id === reply.messageId));
  ws.send(JSON.stringify({ type: 'chat-ack', id: reply.messageId }));
  await until(async () => (await get()).runs[0].status === 'delivered');
  fs.appendFileSync(logFile, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'agent-1', output: 'Process exited with code 0\nOutput: private-agent-output',
  } }) + '\n');
  const completed = await until(async () => { const s = await get(); return s.runs[0].steps.find(item => item.kind === 'agent')?.status === 'success' && s; });
  assert.equal(completed.agentSource.status, 'connected');
  const invoked = completed.runs[0].steps.find(item => item.kind === 'agent');
  assert.deepEqual(JSON.parse(invoked.invocation.json), { cmd: 'node browser.js observe' });
  assert(completed.runs[0].steps.find(item => item.kind === 'agent-input').invocation.json.includes('[Browser] Find an example'));
  assert.equal(completed.runs[0].status, 'delivered');
  assert.deepEqual(completed.runs[0].toolCounts, { browser: [{ name: 'observe', count: 1 }], agent: [{ name: 'exec_command', count: 1 }] });
  assert(!JSON.stringify(completed).includes('private-agent-output'));
  const html = await fetch(base + '/monitor/');
  assert.equal(html.status, 200); assert(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const markup = await html.text();
  for (const label of ['执行时间线', '工具调用分布', '浏览器工具', 'Agent 工具']) assert(markup.includes(label));
  assert.equal((await fetch(base + '/monitor/app.js')).status, 200);
  assert.equal((await fetch(base + '/monitor/styles.css')).status, 200);
  assert.equal((await fetch(base + '/monitor/api', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/monitor/api', { headers: { Origin: 'https://example.com' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/monitor/api', { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(extBase + '/monitor/')).status, 426);
});

test('monitor defaults off and starts no collector even with diagnostic paths configured', async t => {
  const previous = process.env.BROWSER_REMOTE_MONITOR;
  delete process.env.BROWSER_REMOTE_MONITOR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-monitor-off-'));
  let discoveries = 0;
  const monitorFile = path.join(dir, 'monitor.json');
  const relay = await start({ extPort: 0, agentPort: 0, monitorFile, agentMonitorDir: dir,
    agentTraceOptions: { discover: async () => { discoveries++; return []; } }, outboxFile: path.join(dir, 'outbox.json') });
  t.after(() => { relay.close(); fs.rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.BROWSER_REMOTE_MONITOR; else process.env.BROWSER_REMOTE_MONITOR = previous; });
  const base = `http://127.0.0.1:${relay.agent.server.address().port}`;
  assert.equal((await fetch(base + '/monitor/api')).status, 404);
  assert.equal((await fetch(base + '/monitor/')).status, 404);
  assert.equal((await fetch(base + '/status')).status, 200);
  assert.equal(relay.monitor, null); assert.equal(discoveries, 0); assert.equal(fs.existsSync(monitorFile), false);
  assert.equal(require('../ecosystem.config.cjs').apps[0].env.BROWSER_REMOTE_MONITOR, '0');
});
