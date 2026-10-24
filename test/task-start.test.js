import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { AgentLane } from "../src/lib/agent-lane.js";
import { digest, keyIdOf } from "../src/lib/keys.js";
import { createClient } from "../scripts/relay-client.js";
import { parseTaskStart, startTask } from "../scripts/task-start.js";
import { taskStartParams, taskStartResult, TASK_START_CAPABILITY } from "../src/lib/task-start.js";

const key = "ab".repeat(32);
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const endpoint = `${keyIdOf(key)}.${requestId}`;
const body = { endpoint, requestId, prompt: "Inspect this page", url: "https://example.com/path" };
const result = { requestId, taskId, status: "started" };

async function setup(t, handler, caps = [TASK_START_CAPABILITY]) {
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }) });
  await ext.listen(0, "127.0.0.1");
  const agent = new AgentLane({ extLane: ext, port: 0 });
  await agent.listen();
  t.after(() => { agent.close(); ext.close(); });
  const client = createClient({ base: `http://127.0.0.1:${agent.server.address().port}` });
  const ws = new WebSocket(`ws://127.0.0.1:${ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
  await once(ws, "open");
  const frames = [], ready = [];
  ws.on("message", raw => {
    const frame = JSON.parse(raw);
    if (frame.type === "ready") ready.push(frame);
    if (frame.type !== "req") return;
    frames.push(frame);
    const value = handler(frame, ws);
    if (value !== undefined) ws.send(JSON.stringify({ type: "resp", id: frame.id, result: value }));
  });
  const connected = once(ext, "connected");
  ws.send(JSON.stringify({ type: "hello", browserId: requestId, capabilities: ["agent-loop-v1", "browser-instance-v1", ...caps] }));
  await connected;
  return { client, frames, ready, ws, agent };
}

test("strict task start params reject ambiguous targets, malformed URL and extra authority", () => {
  assert.deepEqual(taskStartParams(body), { requestId, prompt: body.prompt, url: body.url });
  for (const change of [{ endpoint: keyIdOf(key) }, { endpoint: "all" }, { requestId: "x" },
    { prompt: " " }, { prompt: "x".repeat(8001) }, { url: undefined }, { url: "file:///tmp/a" },
    { url: "https://user:pass@example.com" }, { url: "https://example.com/\n" },
    { url: "https://" }, { url: "https://example.com/" + "x".repeat(4096) }, { permission: true }]) {
    assert.throws(() => taskStartParams({ ...body, ...change }));
  }
  assert.deepEqual(parseTaskStart([endpoint, requestId], JSON.stringify({ prompt: body.prompt, url: body.url })), body);
  assert.throws(() => parseTaskStart([endpoint, requestId], JSON.stringify(body)));
  for (const change of [{ requestId: taskId }, { taskId: "x" }, { status: "complete" }, { extra: true }]) {
    assert.throws(() => taskStartResult({ ...result, ...change }, requestId));
  }
});

test("real HTTP/WS start negotiates and forwards exact params once", async t => {
  const { client, frames, ready, agent } = await setup(t, () => result);
  assert.deepEqual(await startTask(body, client), { ok: true, endpointId: endpoint, ...result });
  assert.equal(agent.server.address().address, "127.0.0.1");
  assert.ok(ready[0].capabilities.includes(TASK_START_CAPABILITY));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, "task.start");
  assert.deepEqual(frames[0].params, taskStartParams(body));
});

test("invalid and unsupported requests never reach extension", async t => {
  const { client, frames } = await setup(t, () => result, []);
  assert.equal((await client.taskStart({ ...body, endpoint: keyIdOf(key) })).body.code, "BAD_REQUEST");
  assert.equal((await client.taskStart(body)).body.code, "TASK_START_UNSUPPORTED");
  assert.equal(frames.length, 0);
});

test("extension refusal is bounded and arbitrary errors stay private", async t => {
  let code = "TASK_START_DISABLED";
  const { client, frames } = await setup(t, (frame, ws) => {
    ws.send(JSON.stringify({ type: "error", id: frame.id, code, message: "private sentinel" }));
  });
  for (const expected of ["TASK_START_DISABLED", "TASK_START_CONFLICT", "TASK_START_REVOKED", "BAD_PARAMS", "TASK_START_ERROR"]) {
    code = expected === "TASK_START_ERROR" ? "private sentinel" : expected;
    const response = await client.taskStart(body);
    assert.equal(response.body.code, expected);
    assert.doesNotMatch(JSON.stringify(response), /private sentinel/);
  }
  assert.equal(frames.length, 5);
});

test("mismatched response and disconnected extension do not replay", async t => {
  let disconnect = false;
  const { client, frames } = await setup(t, (_, ws) => {
    if (disconnect) { ws.close(); return; }
    return { ...result, requestId: taskId };
  });
  assert.equal((await client.taskStart(body)).body.code, "BAD_TASK_START_RESPONSE");
  disconnect = true;
  assert.equal((await client.taskStart(body)).body.code, "EXT_OFFLINE");
  assert.equal(frames.length, 2);
});

test("timeout has unknown outcome and never retries", async t => {
  const { client, frames } = await setup(t, () => undefined);
  assert.equal((await client.taskStart(body)).body.code, "EXT_TIMEOUT");
  assert.equal(frames.length, 1);
});
