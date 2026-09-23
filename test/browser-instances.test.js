"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const WebSocket = require("ws");
const { start } = require("../src/index");
const { digest, keyIdOf } = require("../src/lib/keys");
const { SUBPROTOCOL, LEGACY_SUBPROTOCOL } = require("../src/lib/ext-lane");
const { INSTANCE_CAPABILITY } = require("../src/lib/endpoint");
const KEY = "ab".repeat(32),
  OTHER_KEY = "cd".repeat(32);
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const caps = ["agent-loop-v1", INSTANCE_CAPABILITY];
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitFor(predicate) {
  for (let n = 0; n < 400; n++) {
    const result = predicate();
    if (result) return result;
    await pause();
  }
  throw new Error("Expected browser transport event did not arrive");
}
async function setup(t) {
  const requests = [];
  const relay = await start({
    extPort: 0,
    agentPort: 0,
    monitor: true,
    onRequest: async (message) => {
      requests.push(message);
      return { ok: true };
    },
  });
  relay.ext.loadKeys = () =>
    Object.fromEntries(
      [KEY, OTHER_KEY].map((key) => [
        keyIdOf(key),
        { sha256: digest(key), label: "shared-key" },
      ]),
    );
  t.after(() => relay.close());
  async function dial(
    browserId,
    { key = KEY, protocol = SUBPROTOCOL, hello = true } = {},
  ) {
    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.ext.server.address().port}/ext`,
      [protocol, `key.${key}`],
    );
    const frames = [];
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw);
      frames.push(frame);
      if (frame.type === "req")
        ws.send(
          JSON.stringify({
            type: "resp",
            id: frame.id,
            result: { accepted: true },
          }),
        );
    });
    await once(ws, "open");
    const client = {
      ws,
      frames,
      send: (frame) => ws.send(JSON.stringify(frame)),
      endpoint:
        protocol === SUBPROTOCOL
          ? `${keyIdOf(key)}.${browserId}`
          : keyIdOf(key),
    };
    if (hello) {
      client.send({
        type: "hello",
        version: "fixture",
        browserId,
        capabilities: caps,
      });
      const ready = await waitFor(() => frames.find((f) => f.type === "ready"));
      assert.equal(ready.endpointId, client.endpoint);
    }
    return client;
  }
  const post = async (
    endpoint,
    id,
    decision = { kind: "actions", actions: [] },
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${relay.agent.server.address().port}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, id, decision }),
      },
    );
    return response.json();
  };
  async function request(client, id = "first", taskId = "task", round = 1) {
    client.send({
      type: "agent-request",
      id,
      taskId,
      round,
      text: "Owner message",
      context: "{}",
      payload: {},
    });
    await waitFor(() =>
      client.frames.find(
        (f) => f.type === "agent-status" && f.requestId === id,
      ),
    );
  }
  const end = (client, taskId = "task", status = "done") =>
    client.send({ type: "agent-turn-end", taskId, status });
  return { relay, requests, dial, post, request, end };
}

test("one key supports independent decisions, continuations, stop and monitor runs even with identical task/request IDs", async (t) => {
  const { relay, requests, dial, post, request, end } = await setup(t);
  const a = await dial(A),
    b = await dial(B);
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  await request(a);
  await request(b);
  assert.deepEqual(
    requests.map((m) => m.endpointId),
    [a.endpoint, b.endpoint],
  );
  assert.equal(requests[0].keyId, requests[1].keyId);
  assert.notEqual(requests[0].browserId, requests[1].browserId);
  const pa = post(a.endpoint, "first"),
    pb = post(b.endpoint, "first");
  await waitFor(
    () =>
      a.frames.some((f) => f.type === "req") &&
      b.frames.some((f) => f.type === "req"),
  );
  a.send({
    type: "agent-event",
    taskId: "task",
    id: "step",
    phase: "start",
    method: "read-page",
    endpointId: b.endpoint,
    keyId: "spoof",
  });
  a.send({
    type: "agent-event",
    taskId: "task",
    id: "step",
    phase: "end",
    method: "read-page",
    result: "A only",
    endpointId: b.endpoint,
  });
  await request(a, "a-next", "task", 2);
  const nextA = await pa;
  assert.equal(nextA.next.id, "a-next");
  assert.ok(nextA.next.replyCommands.actions.includes(a.endpoint));
  assert.ok(nextA.next.replyCommands.done.includes(a.endpoint));
  assert.ok(!nextA.next.replyCommands.done.includes(b.endpoint));
  assert.ok(relay.agent.exchange.states.get(b.endpoint).waiter);
  end(b, "task", "stopped");
  assert.equal((await pb).status, "stopped");
  assert.equal(relay.agent.exchange.states.get(a.endpoint).next.id, "a-next");
  const wrong = await post(b.endpoint, "a-next");
  assert.equal(wrong.code, "STALE_DECISION");
  assert.equal(b.frames.filter((f) => f.type === "req").length, 1);
  const finalA = post(a.endpoint, "a-next", { kind: "done", text: "Only A" });
  await waitFor(() => a.frames.filter((f) => f.type === "req").length === 2);
  end(a);
  assert.equal((await finalA).status, "done");
  const runs = relay.monitor.runs;
  assert.equal(runs.length, 2);
  const arun = runs.find((r) => r.endpointId === a.endpoint),
    brun = runs.find((r) => r.endpointId === b.endpoint);
  assert.ok(arun.steps.some((s) => s.title === "read-page"));
  assert.ok(!brun.steps.some((s) => s.title === "read-page"));
  assert.equal(arun.status, "delivered");
  assert.equal(brun.status, "interrupted");
});

test("replacing instance A interrupts only A, ignores old socket events, and rejects stale decisions", async (t) => {
  const { relay, dial, post, request, end } = await setup(t);
  const a = await dial(A),
    b = await dial(B);
  await request(a, "a-old");
  await request(b, "b-current");
  const pa = post(a.endpoint, "a-old"),
    pb = post(b.endpoint, "b-current");
  await waitFor(
    () =>
      a.frames.some((f) => f.type === "req") &&
      b.frames.some((f) => f.type === "req"),
  );
  const closed = once(a.ws, "close");
  const newer = await dial(A);
  assert.equal((await closed)[0], 4001);
  assert.equal((await pa).code, "EXT_OFFLINE");
  assert.equal(relay.ext.connectedIds().length, 2);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  assert.ok(relay.agent.exchange.states.get(b.endpoint).waiter);
  assert.equal((await post(a.endpoint, "a-old")).code, "STALE_DECISION");
  await request(newer, "a-new", "new-task");
  assert.equal((await post(a.endpoint, "a-old")).code, "STALE_DECISION");
  assert.equal(newer.frames.filter((f) => f.type === "req").length, 0);
  end(b);
  assert.equal((await pb).status, "done");
  newer.ws.close();
  await waitFor(() => !relay.ext.isConnected(newer.endpoint));
  assert.equal((await post(newer.endpoint, "a-new")).code, "EXT_OFFLINE");
  assert.equal(b.ws.readyState, WebSocket.OPEN);
});

test("identity is validated before registration, cannot be changed, and cannot cross key namespaces", async (t) => {
  const { relay, dial, post } = await setup(t);
  const a = await dial(A),
    b = await dial(B);
  for (const hello of [
    { type: "hello", capabilities: caps },
    { type: "hello", capabilities: caps, browserId: "../../other" },
    { type: "hello", capabilities: ["agent-loop-v1"], browserId: A },
    { type: "agent-request", endpointId: a.endpoint },
  ]) {
    const bad = await dial(A, { hello: false });
    const closed = once(bad.ws, "close");
    bad.send(hello);
    assert.equal((await closed)[0], 4002);
    assert.equal(a.ws.readyState, WebSocket.OPEN);
  }
  const sameIdOtherKey = await dial(A, { key: OTHER_KEY });
  assert.notEqual(sameIdOtherKey.endpoint, a.endpoint);
  assert.equal(relay.ext.connectedIds().length, 3);
  assert.equal((await post(undefined, "id")).code, "BAD_ENDPOINT");
  assert.equal((await post(keyIdOf(KEY), "id")).code, "EXT_OFFLINE");
  const closed = once(a.ws, "close");
  a.send({ type: "hello", capabilities: caps, browserId: B });
  assert.equal((await closed)[0], 4002);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  assert.equal(relay.ext.isConnected(b.endpoint), true);
});

test("older clients occupy their own route and cannot replace instance-aware clients", async (t) => {
  const { relay, dial } = await setup(t);
  const a = await dial(A),
    b = await dial(B);
  const legacy = await dial(null, { protocol: LEGACY_SUBPROTOCOL });
  const closed = once(legacy.ws, "close");
  const legacy2 = await dial(null, { protocol: LEGACY_SUBPROTOCOL });
  assert.equal((await closed)[0], 4001);
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  assert.equal(legacy2.endpoint, keyIdOf(KEY));
  assert.equal(relay.ext.connectedIds().length, 3);
});

test("a superseded socket that throws on close does not take the relay down", async (t) => {
  const { relay, dial, request } = await setup(t);
  const a = await dial(A),
    b = await dial(B);
  // A half-dead socket can throw from close(). This one runs inside the NEW
  // socket's message handler, so an escaping error would kill the process.
  relay.ext.conns.get(a.endpoint).ws.close = () => {
    throw new Error("socket already torn down");
  };
  const newer = await dial(A);
  assert.equal(newer.endpoint, a.endpoint);
  assert.equal(relay.ext.connectedIds().length, 2);
  assert.ok(relay.ext.isConnected(a.endpoint));
  // The relay still accepts traffic from the replacement instance, and B was
  // never touched.
  await request(newer, "a-new", "new-task");
  assert.equal(b.ws.readyState, WebSocket.OPEN);
});
