import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { AgentExchange } from "../src/lib/agent-exchange.js";
import { AgentLane } from "../src/lib/agent-lane.js";
import { digest, keyIdOf } from "../src/lib/keys.js";

const key = "ab".repeat(32);
const browserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeEpoch = "11111111-1111-4111-8111-111111111111";
const endpoint = `${keyIdOf(key)}.${browserId}`;
const caps = ["agent-loop-v1", "browser-instance-v1", "task-resume-v1", "agent-input-v1"];
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    const value = predicate();
    if (value) return value;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("transport event missing");
}
async function setup(t, recoveryMs = 5000) {
  const ext = new ExtLane({ recoveryMs, loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }) });
  const exchange = new AgentExchange(ext);
  const delivered = [];
  ext.on("agent-request", (msg, ack) => {
    if (!exchange.ingest(msg)) delivered.push(msg);
    ack({ state: "queued" });
  });
  await ext.listen(0, "127.0.0.1");
  t.after(() => { exchange.close(); ext.close(); });
  const dial = async (resume, epoch = runtimeEpoch, capabilities = caps) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
    const frames = [];
    ws.on("message", data => frames.push(JSON.parse(data)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", browserId, capabilities, runtimeEpoch: epoch, ...(resume ? { resume } : {}) }));
    const ready = await until(() => frames.find(f => f.type === "ready"));
    return { ws, frames, ready, send: frame => ws.send(JSON.stringify(frame)) };
  };
  return { ext, exchange, delivered, dial };
}
const request = (id = "first", round = 1) => ({ type: "agent-request", id, round,
  taskId: "task", deliveryId: `delivery-${id}`, runtimeEpoch, text: "Owner message", context: "{}", payload: {} });
const resume = { taskId: "task", requestId: "first", round: 1, phase: "waiting" };

test("same runtime reconnect retains pending decision and prevents duplicate first delivery", async t => {
  const { ext, exchange, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  const scope = exchange.states.get(endpoint).attachments;
  const response = exchange.respond(endpoint, "first", { kind: "actions", actions: [] });
  const rpc = await until(() => a.frames.find(f => f.type === "req"));
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  assert.equal(exchange.states.get(endpoint).attachments, scope);
  const b = await dial(resume);
  assert.equal(b.ready.resume.status, "resumed");
  b.send(request());
  await until(() => b.frames.find(f => f.type === "task-ack"));
  assert.equal(delivered.length, 1);
  const replay = await until(() => b.frames.find(f => f.type === "req"));
  assert.deepEqual(replay.params, rpc.params);
  b.send({ type: "resp", id: replay.id, result: { accepted: true, replayed: true } });
  b.send(request("next", 2));
  assert.equal((await response).next.id, "next");
});

test("same runtime replacement fences old frames and old close", async t => {
  const { ext, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  const old = ext.conns.get(endpoint);
  const b = await dial(resume);
  assert.equal(b.ready.resume.status, "resumed");
  ext._onMessage(old, Buffer.from(JSON.stringify({ type: "agent-turn-end", taskId: "task", status: "stopped" })));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ext.conns.get(endpoint).agentTurn, "task");
  assert.notEqual(ext.conns.get(endpoint), old);
});

test("expiry releases waiter and rejects later resume without redelivery", async t => {
  const { ext, exchange, delivered, dial } = await setup(t, 30);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  const response = exchange.respond(endpoint, "first", { kind: "actions", actions: [] });
  await until(() => a.frames.find(f => f.type === "req"));
  a.ws.terminate();
  assert.equal((await response).code, "EXT_OFFLINE");
  assert.equal(exchange.states.size, 0);
  const b = await dial(resume);
  assert.equal(b.ready.resume.status, "rejected");
  assert.equal(delivered.length, 1);
  assert.equal(ext.conns.size, 0);
});

test("new runtime cannot recover old task and revocation terminates offline state", async t => {
  const { ext, exchange, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  const b = await dial(resume, "22222222-2222-4222-8222-222222222222");
  assert.equal(b.ready.resume.status, "rejected");
  assert.equal(exchange.states.size, 0);
  const c = await dial();
  c.send(request());
  await until(() => delivered.length === 2);
  c.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  ext.loadKeys = () => ({});
  ext._beat();
  assert.equal(exchange.states.size, 0);
  assert.equal(ext.conns.size, 0);
});

test("terminal outbox replay acknowledges once and preserves finished waiter", async t => {
  const { ext, exchange, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  const response = exchange.respond(endpoint, "first", { kind: "final", text: "done" });
  const rpc = await until(() => a.frames.find(f => f.type === "req"));
  a.send({ type: "resp", id: rpc.id, result: { accepted: true } });
  const terminal = { type: "agent-turn-end", taskId: "task", status: "done", runtimeEpoch, deliveryId: "terminal" };
  a.send(terminal);
  assert.equal((await response).finished, true);
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  const b = await dial({ ...resume, phase: "terminal" });
  b.send(terminal);
  await until(() => b.frames.find(f => f.type === "task-ack" && f.deliveryId === "terminal"));
  assert.equal(b.ready.resume.status, "resumed");
});

test("legacy clients retain fail-closed disconnect behavior", async t => {
  const { ext, exchange, delivered, dial } = await setup(t);
  const a = await dial(undefined, runtimeEpoch, ["agent-loop-v1", "browser-instance-v1"]);
  a.send(request());
  await until(() => delivered.length);
  a.ws.terminate();
  await until(() => !ext.conns.has(endpoint));
  assert.equal(exchange.states.size, 0);
});

test("round and steering watermarks fence replay after delivery receipt eviction", async t => {
  const { ext, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  const inputs = [];
  ext.on("agent-input", (msg, ack) => { inputs.push(msg); ack({ state: "queued" }); });
  const input = sequence => ({ type: "agent-input", version: 2, taskId: "task",
    id: `input-${sequence}`, sequence, deliveryId: `input-${sequence}`, runtimeEpoch,
    message: { id: `input-${sequence}`, role: "user", content: [{ type: "text", text: "steer" }] }, context: { pages: [] } });
  for (let n = 1; n <= 270; n++) a.send(input(n));
  await until(() => inputs.length === 270);
  assert.equal(ext.conns.get(endpoint).deliveries.size, 256);
  a.send(input(1));
  a.send(request());
  await until(() => a.frames.find(f => f.code === "BAD_INPUT_SEQUENCE"));
  assert.equal(inputs.length, 270);
  assert.equal(delivered.length, 1);
  a.send({ type: "agent-turn-end", taskId: "task", status: "done", runtimeEpoch, deliveryId: "old-end" });
  await until(() => !ext.conns.get(endpoint).agentTurn);
  a.send({ ...request("new-first"), taskId: "new-task" });
  await until(() => delivered.length === 2);
  a.send({ type: "agent-turn-end", taskId: "task", status: "done", runtimeEpoch, deliveryId: "old-end-new-id" });
  a.send({ ...request(), deliveryId: "old-request-new-id" });
  await until(() => a.frames.find(f => f.type === "task-ack" && f.deliveryId === "old-request-new-id"));
  assert.equal(ext.conns.get(endpoint).agentTurn, "new-task");
  assert.equal(delivered.length, 2);
  a.send({ type: "agent-turn-end", taskId: "new-task", status: "done", runtimeEpoch, deliveryId: "new-end" });
  await until(() => !ext.conns.get(endpoint).agentTurn);
  a.send({ ...request(), deliveryId: "ancient-request-new-id" });
  await until(() => a.frames.find(f => f.type === "task-ack" && f.deliveryId === "ancient-request-new-id"));
  assert.equal(delivered.length, 2);
});

test("first request lost before server acceptance resumes only retained idle runtime", async t => {
  const { ext, delivered, dial } = await setup(t);
  const a = await dial();
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  const b = await dial(resume);
  assert.equal(b.ready.resume.status, "resumed");
  b.send(request());
  await until(() => delivered.length);
  assert.equal(delivered.length, 1);
});

test("mismatched current request fails closed but one pending next round reconciles", async t => {
  const { ext, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  const b = await dial({ ...resume, requestId: "next", round: 2 });
  assert.equal(b.ready.resume.status, "resumed");
  b.send(request("next", 2));
  await until(() => ext.conns.get(endpoint).agentRound === 2);
  b.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  const c = await dial({ ...resume, requestId: "wrong", round: 2 });
  assert.equal(c.ready.resume.status, "rejected");
});

test("offline decision waits for recovery and offline stop is terminal exactly once", async t => {
  const { ext, exchange, delivered, dial } = await setup(t);
  const agent = new AgentLane({ extLane: ext, exchange, port: 0 });
  await agent.listen();
  t.after(() => agent.close());
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  assert.deepEqual(ext.resolve(endpoint, { allowRecovery: true }), { endpointId: endpoint });
  const response = fetch(`http://127.0.0.1:${agent.server.address().port}/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint, id: "first", decision: { kind: "actions", actions: [] } }),
  }).then(result => result.json());
  await until(() => exchange.states.get(endpoint).waiter);
  const ended = [];
  ext.on("agent-turn-end", event => ended.push(event));
  const b = await dial({ taskId: "task", phase: "terminal" });
  const stopped = { type: "agent-turn-end", taskId: "task", status: "stopped", interrupt: true,
    deliveryId: "stopped", runtimeEpoch };
  b.send(stopped);
  b.send(stopped);
  assert.equal((await response).status, "stopped");
  await until(() => b.frames.filter(f => f.type === "task-ack" && f.deliveryId === "stopped").length === 2);
  assert.equal(ended.length, 1);
});

test("changed contents under a delivery ID close recovery instead of acknowledging", async t => {
  const { ext, exchange, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  a.send({ ...request(), text: "different owner message" });
  await until(() => !ext.conns.has(endpoint));
  assert.equal(delivered.length, 1);
  assert.equal(exchange.states.size, 0);
});

test("new task first frame lost after a completed task reconciles without reviving old task", async t => {
  const { ext, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  a.send({ type: "agent-turn-end", taskId: "task", status: "done", deliveryId: "end", runtimeEpoch });
  await until(() => !ext.conns.get(endpoint).agentTurn);
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  const b = await dial({ ...resume, taskId: "new-task", requestId: "new-first" });
  assert.equal(b.ready.resume.status, "resumed");
  b.send({ ...request("new-first"), taskId: "new-task" });
  await until(() => delivered.length === 2);
  assert.equal(ext.conns.get(endpoint).agentTurn, "new-task");
});

test("resume mismatch closes the previous live socket as well as rejecting replacement", async t => {
  const { ext, exchange, delivered, dial } = await setup(t);
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  const closed = once(a.ws, "close");
  const b = await dial({ ...resume, requestId: "different" });
  assert.equal(b.ready.resume.status, "rejected");
  assert.equal((await closed)[0], 4005);
  assert.equal(exchange.states.size, 0);
  assert.equal(ext.conns.size, 0);
});

test("late stop result releases stopping guard on recovered connection", async t => {
  const { ext, delivered, dial } = await setup(t);
  let reportStop;
  ext.on("agent-turn-end", (_event, report) => { reportStop = report; });
  const a = await dial();
  a.send(request());
  await until(() => delivered.length);
  a.send({ type: "agent-turn-end", taskId: "task", status: "stopped", interrupt: true,
    deliveryId: "stop", runtimeEpoch });
  await until(() => reportStop);
  a.ws.terminate();
  await until(() => ext.conns.get(endpoint)?.recoveryTimer);
  const b = await dial({ taskId: "task", phase: "terminal" });
  assert.equal(ext.conns.get(endpoint).agentStopping, true);
  reportStop({ ok: true });
  await until(() => b.frames.find(f => f.type === "agent-stop-result"));
  assert.equal(ext.conns.get(endpoint).agentStopping, false);
  b.send({ ...request("new-first"), taskId: "new-task" });
  await until(() => delivered.length === 2);
});
