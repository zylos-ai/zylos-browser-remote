import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { AgentLane } from "../src/lib/agent-lane.js";
import { digest, keyIdOf } from "../src/lib/keys.js";
import { createClient } from "../scripts/relay-client.js";
import { diagnosticResult } from "../src/lib/diagnostics.js";

const key = "ab".repeat(32);
const sample = () => ({ enabled: true, version: "0.17.0", events: [], nextCursor: 0, dropped: 0,
  schemaVersion: 2, epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", highWater: 0,
  oldestCursor: 0, hasMore: false, truncated: false, storageHealthy: true, restartCount: 0, partialCapture: false });
async function setup(t) {
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }) });
  await ext.listen(0, "127.0.0.1");
  const agent = new AgentLane({ extLane: ext, port: 0 });
  await agent.listen();
  t.after(() => { agent.close(); ext.close(); });
  const client = createClient({ base: `http://127.0.0.1:${agent.server.address().port}` });
  async function browser(id, caps = ["diagnostics-v2"], handler = () => sample()) {
    const ws = new WebSocket(`ws://127.0.0.1:${ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
    await once(ws, "open");
    const received = [];
    ws.on("message", raw => {
      const frame = JSON.parse(raw);
      if (frame.type !== "req") return;
      received.push(frame);
      const result = handler(frame, ws);
      if (result !== undefined) ws.send(JSON.stringify({ type: "resp", id: frame.id, result }));
    });
    const connected = once(ext, "connected");
    ws.send(JSON.stringify({ type: "hello", browserId: id, capabilities: ["agent-loop-v1", "browser-instance-v1", ...caps] }));
    await connected;
    return { endpoint: `${keyIdOf(key)}.${id}`, ws, received };
  }
  return { ext, agent, client, browser };
}
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("lifecycle diagnostics preserve bounded metadata and reject unsafe fields", () => {
  const event = { seq: 1, at: 1, event: "transport-timer", source: "background", level: "info",
    generation: 3, scheduledAt: 100, firedAt: 500, delayMs: 400, inboundAgeMs: 10,
    outboundAgeMs: 20, workerUptimeMs: 30, timer: "freshness", phase: "failed",
    visibility: "hidden", resumeCategory: "state_missing" };
  const response = { ...sample(), events: [event], nextCursor: 1, highWater: 1 };
  assert.deepEqual(diagnosticResult(response, 1).events, [event]);
  for (const [field, bad] of [["delayMs", -1], ["generation", Number.MAX_SAFE_INTEGER + 1],
    ["firedAt", "private"], ["resumeCategory", "PRIVATE"], ["visibility", "PRIVATE"], ["timer", "PRIVATE"], ["phase", "PRIVATE"]]) {
    assert.throws(() => diagnosticResult({ ...response, events: [{ ...event, [field]: bad }] }, 1));
  }
  assert.deepEqual(diagnosticResult({ ...response, events: [{ ...event, page: "PRIVATE" }] }, 1).events, [event]);
});

test("diagnostics uses exact authenticated browser without control or active task", async t => {
  const { client, browser, agent } = await setup(t);
  assert.equal(agent.server.address().address, "127.0.0.1");
  const a = await browser(A, ["diagnostics-v2"], () => ({ ...sample(), nextCursor: 8, highWater: 8 }));
  const b = await browser(B);
  const response = await client.diagnostics({ endpoint: a.endpoint, after: 8, limit: 20 });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.endpointId, a.endpoint);
  assert.equal(a.received[0].method, "diagnostics.get");
  assert.deepEqual(a.received[0].params, { after: 8, limit: 20 });
  assert.equal(b.received.length, 0);
  assert.equal((await client.diagnostics({})).body.code, "BAD_ENDPOINT");
});

test("unsupported, disabled, offline and disconnected are distinct", async t => {
  const { client, browser } = await setup(t);
  const a = await browser(A, ["diagnostics-v1"]);
  assert.equal((await client.diagnostics({ endpoint: a.endpoint })).body.code, "DIAGNOSTICS_UNSUPPORTED");
  assert.equal(a.received.length, 0);
  const b = await browser(B, ["diagnostics-v2"], () => ({ ...sample(), enabled: false }));
  assert.equal((await client.diagnostics({ endpoint: b.endpoint })).body.enabled, false);
  b.ws.close();
  await once(b.ws, "close");
  assert.equal((await client.diagnostics({ endpoint: b.endpoint })).body.code, "EXT_OFFLINE");
});

test("pending diagnostic fails on disconnect and timeout is bounded", async t => {
  const { client, browser } = await setup(t);
  const a = await browser(A, ["diagnostics-v2"], (_, ws) => { ws.close(); });
  assert.equal((await client.diagnostics({ endpoint: a.endpoint })).body.code, "EXT_OFFLINE");
  const b = await browser(B, ["diagnostics-v2"], () => undefined);
  const started = Date.now();
  assert.equal((await client.diagnostics({ endpoint: b.endpoint })).body.code, "EXT_TIMEOUT");
  assert.ok(Date.now() - started < 8000);
});

test("diagnostic limits and response fields are bounded", async t => {
  const { client, browser } = await setup(t);
  const a = await browser(A);
  for (const body of [{ limit: 201 }, { after: -1 }, { limit: 1.5 }, { text: "private" }]) {
    assert.equal((await client.diagnostics({ endpoint: a.endpoint, ...body })).status, 400);
  }
  assert.equal(a.received.length, 0);
  assert.throws(() => diagnosticResult({ ...sample(), extra: "x".repeat(262144) }, 100));
  assert.throws(() => diagnosticResult({ ...sample(), events: Array(201).fill({}) }, 200));
  assert.deepEqual(diagnosticResult({ ...sample(), url: "private" }, 100), sample());
  assert.throws(() => diagnosticResult({ ...sample(), events: [{ seq: 1, at: 10, event: "private text" }] }, 100));
  assert.deepEqual(diagnosticResult({ ...sample(), nextCursor: 1, highWater: 1, events: [{ seq: 1, at: 10, event: "socket-close", source: "background", level: "warn", reason: "remote_disconnect", url: "private" }] }, 100).events,
    [{ seq: 1, at: 10, event: "socket-close", source: "background", level: "warn", reason: "remote_disconnect" }]);
  await assert.rejects(createClient({ base: "http://example.com:3803" }).diagnostics({ endpoint: a.endpoint }), /non-loopback/);
});
