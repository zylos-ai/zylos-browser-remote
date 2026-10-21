import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { AgentLane } from "../src/lib/agent-lane.js";
import { AgentExchange } from "../src/lib/agent-exchange.js";
import { createClient } from "../scripts/relay-client.js";
import { digest, keyIdOf } from "../src/lib/keys.js";
import { controlLossReceipt } from "../src/lib/control-loss.js";

const receipt = { reason: "CONTROL_LOST", results: [{ method: "fill", outcome: "completed" },
  { method: "click", outcome: "uncertain" }], observation: "unavailable", resume: "new-user-message-required" };

async function setup(t, interruption, capabilities = [], terminalStatus = "interrupted") {
  const key = "ab".repeat(32);
  const browser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const endpoint = `${keyIdOf(key)}.${browser}`;
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }) });
  const exchange = new AgentExchange(ext);
  const agent = new AgentLane({ extLane: ext, exchange, port: 0 });
  await ext.listen(0, "127.0.0.1");
  await agent.listen();
  t.after(() => { exchange.close(); agent.close(); ext.close(); });
  const ws = new WebSocket(`ws://127.0.0.1:${ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
  await once(ws, "open");
  let forwarded = 0;
  let signature;
  let executions = 0;
  ws.on("message", raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== "req") return;
    forwarded++;
    const current = JSON.stringify([frame.params.decision, frame.params.inputId]);
    if (signature !== undefined && signature !== current) {
      ws.send(JSON.stringify({ type: "error", id: frame.id, code: "DECISION_CONFLICT", message: "conflicting contents" }));
      return;
    }
    ws.send(JSON.stringify({ type: "resp", id: frame.id, result: { accepted: true } }));
    if (signature !== undefined) return;
    signature = current;
    executions++;
    ws.send(JSON.stringify({ type: "agent-turn-end", taskId: "task", status: terminalStatus, interruption }));
  });
  const connected = once(ext, "connected");
  ws.send(JSON.stringify({ type: "hello", browserId: browser, capabilities: ["agent-loop-v1", "browser-instance-v1", ...capabilities] }));
  await connected;
  ext.conns.get(endpoint).agentTurn = "task";
  exchange.ingest({ endpointId: endpoint, chatId: "task", request: { id: "r1", taskId: "task", round: 1 } });
  const client = createClient({ base: `http://127.0.0.1:${agent.server.address().port}` });
  return { client, endpoint, forwarded: () => forwarded, executions: () => executions };
}

test("control-loss evidence reaches actual /decision; terminal retries preserve extension conflict checks without action replay", async t => {
  const { client, endpoint, forwarded, executions } = await setup(t, receipt);
  const body = { endpoint, id: "r1", decision: { kind: "actions", actions: [{ method: "fill" }] } };
  const first = (await client.decision(body)).body;
  assert.equal(first.finished, true);
  assert.equal(first.status, "interrupted");
  assert.deepEqual(first.interruption, receipt);
  assert.equal(first.next, undefined);
  assert.equal(forwarded(), 1);
  const retry = (await client.decision(body)).body;
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.interruption, receipt);
  assert.equal(forwarded(), 2);
  assert.equal((await client.decision({ ...body, decision: { kind: "done", text: "different" } })).body.code, "DECISION_CONFLICT");
  assert.equal((await client.decision({ ...body, inputId: "new-input" })).body.code, "DECISION_CONFLICT");
  assert.equal(executions(), 1);
  assert.equal((await client.decision({ ...body, id: "other" })).body.code, "STALE_DECISION");
});

test("malformed evidence is refused without blocking terminal stop; old clients remain valid", async t => {
  for (const value of [undefined, { ...receipt, params: "SECRET" }, { ...receipt, results: [{ method: "fill", outcome: "completed", result: "SECRET" }] }]) {
    await t.test(String(value === undefined), async t => {
      const { client, endpoint } = await setup(t, value);
      const result = (await client.decision({ endpoint, id: "r1", decision: { kind: "actions" } })).body;
      assert.equal(result.finished, true);
      assert.equal(result.status, "interrupted");
      assert.equal(result.interruption, undefined);
      assert.ok(!JSON.stringify(result).includes("SECRET"));
    });
  }
});

test("control-loss receipt schema bounds counts and syntax, without a browser method inventory", () => {
  for (const value of [{ ...receipt, results: Array(11).fill(receipt.results[0]) },
    { ...receipt, results: [{ method: "https://private.example/", outcome: "completed" }] },
    { ...receipt, results: [{ method: "fill", outcome: "SECRET" }] },
    { ...receipt, resume: "auto-reattach" }, { ...receipt, reason: "SECRET" }]) {
    assert.equal(controlLossReceipt(value), undefined);
  }
  assert.equal(controlLossReceipt({ ...receipt, results: [{ method: "future-browser-method", outcome: "completed" }] }).results[0].method, "future-browser-method");
});

test("selected removal uncertainty survives terminal transport only for negotiated peers", async t => {
  const expected = { ...receipt, recoveryOutcome: "failed", recoveryRemoval: { requested: 2, outcome: "unknown" } };
  assert.deepEqual(controlLossReceipt(expected), expected);
  for (const negotiated of [false, true]) {
    await t.test(String(negotiated), async t => {
      const { client, endpoint } = await setup(t, expected, negotiated ? ["recovery-frame-selection-v1"] : []);
      const result = (await client.decision({ endpoint, id: "r1", decision: { kind: "actions" } })).body;
      assert.equal(result.finished, true);
      assert.equal(result.status, "interrupted");
      assert.deepEqual(result.interruption, negotiated ? expected : undefined);
    });
  }
  await t.test("explicit Stop retains uncertain removal", async t => {
    const stopped = { ...expected, recoveryOutcome: "revoked" };
    const { client, endpoint } = await setup(t, stopped, ["recovery-frame-selection-v1"], "stopped");
    const result = (await client.decision({ endpoint, id: "r1", decision: { kind: "actions" } })).body;
    assert.equal(result.finished, true);
    assert.equal(result.status, "stopped");
    assert.deepEqual(result.interruption, stopped);
  });
  for (const recoveryRemoval of [null, [], { requested: 0, outcome: "unknown" },
    { requested: 17, outcome: "unknown" }, { requested: 1.5, outcome: "unknown" },
    { requested: 1, outcome: "completed" }, { requested: 1, outcome: "unknown", src: "SECRET" }]) {
    assert.equal(controlLossReceipt({ ...receipt, recoveryRemoval }), undefined);
  }
});

test("recovery terminal outcomes survive actual transport and unknown metadata never leaks", async t => {
  assert.deepEqual(controlLossReceipt(receipt), receipt);
  for (const recoveryOutcome of ["expired", "failed", "revoked"]) {
    await t.test(recoveryOutcome, async t => {
      const expected = { ...receipt, recoveryOutcome };
      const { client, endpoint } = await setup(t, expected);
      const result = (await client.decision({ endpoint, id: "r1", decision: { kind: "actions" } })).body;
      assert.equal(result.finished, true);
      assert.equal(result.status, "interrupted");
      assert.deepEqual(result.interruption, expected);
    });
  }
  for (const value of [{ ...receipt, recoveryOutcome: "SECRET" },
    { ...receipt, recoveryOutcome: { raw: "SECRET" } },
    { ...receipt, recoveryOutcome: "expired", extra: "SECRET" }]) {
    assert.equal(controlLossReceipt(value), undefined);
  }
});
