'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-loop-'));
process.env.BROWSER_REMOTE_OBS_DIR = path.join(tmp, 'images');
process.env.BROWSER_REMOTE_KEY = 'ef'.repeat(32);
process.env.ZYLOS_C4_RECEIVE = path.join(tmp, 'c4.js');
const output = path.join(tmp, 'requests.jsonl');
fs.writeFileSync(process.env.ZYLOS_C4_RECEIVE, `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(output)},JSON.stringify(a)+'\\n');console.log(JSON.stringify({ok:true,action:'queued',id:1}));`);
const { start } = require('../relay/server');
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Expected transport event did not arrive');
};

test('opaque decision contract travels through C4, attachments stay on Agent host, and responses use a correlated CLI', async t => {
  const relay = await start({ extPort: 0, agentPort: 0, monitor: true, outboxFile: path.join(tmp, 'outbox.json') });
  const ws = new WebSocket(`ws://127.0.0.1:${relay.ext.server.address().port}/ext`, ['zylos-browser-remote.v2', `key.${process.env.BROWSER_REMOTE_KEY}`]);
  const frames = [], calls = [];
  ws.on('message', raw => {
    const frame = JSON.parse(raw); frames.push(frame);
    if (frame.type === 'req') {
      calls.push(frame);
      ws.send(JSON.stringify({ type: 'resp', id: frame.id, result: { accepted: true } }));
      ws.send(JSON.stringify({type:'agent-request',id:'request-2',taskId:'turn-1',round:2,text:'Read my page $(literal)',context:'{}',payload:{state:'actual next observation'}}));
    }
  });
  t.after(() => { ws.terminate(); relay.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', version: 'fixture', capabilities: ['agent-loop-v1'] }));
  assert.ok((await waitFor(() => frames.find(frame => frame.type === 'ready'))).capabilities.includes('agent-loop-v1'));
  const image = Buffer.from('89504e470d0a1a0a' + '00'.repeat(64), 'hex');
  const request = { type: 'agent-request', id: 'request-1', taskId: 'turn-1', round: 1, text: 'Read my page $(literal)', context: '{}', payload: {
    instructions: 'Fixture contract only', unknownFutureTool: { nested: { mimeType: 'image/png', data: image.toString('base64') } },
  } };
  ws.send(JSON.stringify(request));
  assert.equal((await waitFor(() => frames.find(frame => frame.requestId === request.id))).state, 'queued');
  const args = JSON.parse(fs.readFileSync(output, 'utf8').trim());
  const content = args[args.indexOf('--content') + 1];
  assert.ok(content.startsWith(`[Browser] [Extension decision request ${relay.ext.connectedIds()[0]}/request-1`));
  assert.ok(content.includes('scripts/decision.js'));
  assert.ok(args.includes('--no-reply'), 'C4 must not append the old final-chat reply route');
  assert.ok(content.includes('$(literal)'));
  assert.ok(!content.includes(image.toString('base64')));
  const payload = JSON.parse(content.split('Extension contract and observations:\n')[1]);
  const attachment = payload.unknownFutureTool.nested;
  assert.equal(attachment.imageReadRequired, true);
  assert.equal(attachment.data, undefined);
  assert.deepEqual(fs.readFileSync(attachment.path), image);
  assert.equal(path.dirname(attachment.path), process.env.BROWSER_REMOTE_OBS_DIR);
  ws.send(JSON.stringify(request));
  const endpoint = relay.ext.connectedIds()[0];
  const base = `http://127.0.0.1:${relay.agent.server.address().port}`;
  const oldReply = await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, text: 'old route' }) });
  assert.equal((await oldReply.json()).code, 'DECISION_REQUIRED');
  const decision = { kind: 'a-future-extension-format', payload: { anything: [1, 2] } };
  const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/decision.js'), endpoint, request.id], {
    env: { ...process.env, BROWSER_REMOTE_AGENT_URL: base }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; child.stdout.on('data', chunk => stdout += chunk);
  child.stdin.end(JSON.stringify(decision));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stdout);
  assert.equal(JSON.parse(stdout).accepted, true);
  assert.equal(JSON.parse(stdout).next.id, 'request-2');
  assert.equal(JSON.parse(stdout).next.payload.state, 'actual next observation');
  assert.equal(calls[0].method, 'agent-decision');
  assert.deepEqual(calls[0].params, { id: request.id, decision });
  assert.equal(fs.readFileSync(output, 'utf8').trim().split('\n').length, 1, 'duplicate request must not enqueue again');
  ws.send(JSON.stringify({ type: 'agent-turn-end', taskId: 'turn-1', status: 'done', text: 'Saved final reply' }));
  await waitFor(() => relay.monitor.runs[0].status === 'delivered');
  assert.equal(relay.monitor.runs[0].steps.filter(step => step.kind === 'command').length, 0);
});
