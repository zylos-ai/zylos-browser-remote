import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { AgentLane } from "../src/lib/agent-lane.js";
import { digest, keyIdOf } from "../src/lib/keys.js";
import { createClient } from "../scripts/relay-client.js";
import { parseTaskStart, startTask } from "../scripts/task-start.js";
import {
  taskStartParams, taskStartResult, TASK_START_CAPABILITY, TASK_START_CURRENT_TAB_CAPABILITY, TASK_START_TIMEOUT_MS,
} from "../src/lib/task-start.js";

const key = "ab".repeat(32);
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const endpoint = `${keyIdOf(key)}.${requestId}`;
const body = { endpoint, requestId, prompt: "Inspect this page", url: "https://example.com/path" };
const result = { requestId, taskId, status: "started" };

async function setup(t, handler, caps = [TASK_START_CAPABILITY], laneOptions = {}) {
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }) });
  await ext.listen(0, "127.0.0.1");
  const agent = new AgentLane({ extLane: ext, port: 0, ...laneOptions });
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
  for (const expected of ["TASK_START_DISABLED", "TASK_START_CONFLICT", "TASK_START_REVOKED", "TASK_START_PAGE_TIMEOUT", "PAGE_UNAVAILABLE", "BAD_PARAMS", "TASK_START_ERROR"]) {
    code = expected === "TASK_START_ERROR" ? "private sentinel" : expected;
    const response = await client.taskStart(body);
    assert.equal(response.body.code, expected);
    assert.doesNotMatch(JSON.stringify(response), /private sentinel/);
    if (["TASK_START_PAGE_TIMEOUT", "PAGE_UNAVAILABLE"].includes(expected)) assert.match(response.body.message, /did not start/);
    else assert.doesNotMatch(JSON.stringify(response.body), /did not start/);
  }
  assert.equal(frames.length, 7);
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

test("task start timeout defaults to 20s", () => {
  assert.equal(TASK_START_TIMEOUT_MS, 20000);
  assert.equal(new AgentLane({ extLane: null, port: 0 }).taskStartTimeoutMs, 20000);
});

test("a slow page (extension answers after 5s) still starts under the default timeout", async t => {
  const { client } = await setup(t, (frame, ws) => {
    setTimeout(() => ws.send(JSON.stringify({ type: "resp", id: frame.id, result })), 6000);
  });
  assert.deepEqual(await startTask(body, client), { ok: true, endpointId: endpoint, ...result });
});

test("timeout has unknown outcome and never retries", async t => {
  const { client, frames } = await setup(t, () => undefined, undefined, { taskStartTimeoutMs: 1000 });
  const sentAt = Date.now();
  assert.equal((await client.taskStart(body)).body.code, "EXT_TIMEOUT");
  const waited = Date.now() - sentAt;
  assert.ok(waited >= 900 && waited < 3000, `relay must use the configured timeout, waited ${waited}ms`);
  assert.equal(frames.length, 1);
});

test("the starting Core session is recorded for the task and not forwarded to the extension", async t => {
  const { TaskSessions } = await import("../src/lib/task-sessions.js");
  const taskSessions = new TaskSessions();
  const { client, frames } = await setup(t, () => result, [TASK_START_CAPABILITY], { taskSessions });
  assert.deepEqual(await startTask({ ...body, sessionGroup: "lark:group-x" }, client), { ok: true, endpointId: endpoint, ...result });
  assert.deepEqual(frames[0].params, taskStartParams(body));
  assert.deepEqual(taskSessions.get(endpoint, taskId).group, "lark:group-x");
  assert.equal(taskSessions.get(endpoint, taskId).origin, "agent");
  assert.equal((await client.taskStart({ ...body, sessionGroup: "not valid" })).body.code, "BAD_REQUEST");
});

test("a browser thread starting a task on its own browser is not recorded as a foreign owner (no SELF_TARGET handoff)", async t => {
  const { TaskSessions } = await import("../src/lib/task-sessions.js");
  const { sessionGroupFromEndpoint } = await import("../src/lib/session-group.js");
  const taskSessions = new TaskSessions();
  const { client } = await setup(t, () => result, [TASK_START_CAPABILITY], { taskSessions });
  const own = `browser-remote:${sessionGroupFromEndpoint(endpoint)}`;
  assert.equal((await startTask({ ...body, sessionGroup: own }, client)).ok, true);
  assert.equal(taskSessions.get(endpoint, taskId), undefined);
});

const currentTab = { endpoint, requestId, prompt: "Finish the form I already filled in", target: "current-tab" };

test("current-tab target is strict: exactly one of url or target, and only the current-tab value", () => {
  assert.deepEqual(taskStartParams(currentTab), { requestId, prompt: currentTab.prompt, target: "current-tab" });
  for (const change of [{ target: "tab" }, { target: "" }, { target: 3 }, { target: null },
    { url: body.url }, { tabId: 7 }]) {
    assert.throws(() => taskStartParams({ ...currentTab, ...change }));
  }
  assert.throws(() => taskStartParams({ endpoint, requestId, prompt: "x" }), "a target is required");
  assert.deepEqual(parseTaskStart([endpoint, requestId], JSON.stringify({ prompt: currentTab.prompt, target: "current-tab" })), currentTab);
  assert.throws(() => parseTaskStart([endpoint, requestId], JSON.stringify({ prompt: "x", target: "current-tab", url: body.url })));
  assert.throws(() => parseTaskStart([endpoint, requestId], JSON.stringify({ prompt: "x", tabId: 3 })));
});

test("url start is unchanged when the extension also supports current-tab", async t => {
  const { client, frames } = await setup(t, () => result, [TASK_START_CAPABILITY, TASK_START_CURRENT_TAB_CAPABILITY]);
  assert.deepEqual(await startTask(body, client), { ok: true, endpointId: endpoint, ...result });
  assert.deepEqual(frames[0].params, { requestId, prompt: body.prompt, url: body.url });
});

test("current-tab start is forwarded once when the extension advertises it", async t => {
  const { client, frames } = await setup(t, () => result, [TASK_START_CAPABILITY, TASK_START_CURRENT_TAB_CAPABILITY]);
  assert.deepEqual(await startTask(currentTab, client), { ok: true, endpointId: endpoint, ...result });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, "task.start");
  assert.deepEqual(frames[0].params, { requestId, prompt: currentTab.prompt, target: "current-tab" });
});

test("current-tab start is refused without the capability and never reaches the extension", async t => {
  const { client, frames } = await setup(t, () => result);
  const response = await client.taskStart(currentTab);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "TASK_START_CURRENT_TAB_UNSUPPORTED");
  assert.match(response.body.message, /current tab/);
  assert.equal(frames.length, 0);
  // A URL start on the same browser still works.
  assert.equal((await startTask(body, client)).ok, true);
  assert.equal(frames.length, 1);
});

test("current-tab refusals say the task did not start and why", async t => {
  let code;
  const { client, frames } = await setup(t, (frame, ws) => {
    ws.send(JSON.stringify({ type: "error", id: frame.id, code, message: "private sentinel" }));
  }, [TASK_START_CAPABILITY, TASK_START_CURRENT_TAB_CAPABILITY]);
  const reasons = {
    TASK_START_NO_TAB: /no focused normal window/,
    TASK_START_PAGE_RESTRICTED: /cannot operate/,
    TASK_START_SITE_DENIED: /site access rules/,
    TASK_START_PAGE_NOT_READY: /still loading/,
    TASK_START_TAB_CLOSED: /was closed/,
    TASK_START_PAGE_CHANGED: /navigated, reloaded or moved/,
  };
  for (const [expected, reason] of Object.entries(reasons)) {
    code = expected;
    const response = await client.taskStart(currentTab);
    assert.equal(response.body.code, expected);
    assert.match(response.body.message, /^Task did not start: /);
    assert.match(response.body.message, reason);
    assert.doesNotMatch(JSON.stringify(response), /private sentinel/);
  }
  assert.equal(frames.length, Object.keys(reasons).length);
});
