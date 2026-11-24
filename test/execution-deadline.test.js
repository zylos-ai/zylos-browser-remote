import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AgentExchange, executionDeadlineMs } from "../src/lib/agent-exchange.js";

const EP = "aaaaaaaaaaaa";
const message = (id, round = 1) => ({
  endpointId: EP,
  chatId: "task",
  request: { version: 2, id, taskId: "task", round, message: { id: "task" }, context: { pages: [] }, execution: { state: id } },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ext = new EventEmitter();
  const sent = [];
  ext.request = async (_e, req) => { sent.push([req.method, req.params.reason]); return { accepted: true }; };
  const logs = [];
  const exchange = new AgentExchange(ext, { log: (m) => logs.push(m), ...opts });
  t.after(() => exchange.close());
  exchange.ingest(message("r1"));
  return { ext, exchange, sent, logs };
}

test("deadline mirrors the extension round watchdog plus a 60s margin; only untimed rounds get 15 min", () => {
  assert.equal(executionDeadlineMs({ kind: "actions" }), 180_000); // no actions: 120s + 60s
  assert.equal(executionDeadlineMs({ actions: [{ method: "click" }] }), 255_000); // 120+60+15+60
  assert.equal(executionDeadlineMs({ actions: [{ method: "read-page", timeoutMs: 30_000 }] }), 225_000);
  assert.equal(executionDeadlineMs({ actions: [{ method: "wait-for-page", params: { timeoutMs: 8_000 } }] }), 255_000);
  assert.equal(executionDeadlineMs({ actions: [{ method: "open", timeoutMs: 1_000 }, { method: "click", timeoutMs: 300_000 }] }), 511_000);
  assert.equal(executionDeadlineMs({ actions: Array(5).fill({ method: "x", timeoutMs: 300_000 }) }), 1_755_000); // no cap: stays above the watchdog
  assert.equal(executionDeadlineMs({ actions: [{ method: "wait-for-page", timeoutMs: 1_000, params: { timeoutMs: 60_000 } }] }), 255_000);
  for (const method of ["recover-control", "inspect-recovery-frames", "use-current-tab"])
    assert.equal(executionDeadlineMs({ actions: [{ method }] }), 900_000);
  assert.equal(executionDeadlineMs({ timeoutMs: 1e9, actions: "x" }), 180_000); // no decision-level budget
});

test("an extension that never reports: the waiter expires with EXECUTION_TIMEOUT and agent-cancel is sent", async (t) => {
  const { exchange, sent, logs } = setup(t);
  const pending = exchange.respond(EP, "r1", { kind: "actions" });
  await tick();
  assert.equal((await exchange.respond(EP, "r1", { kind: "actions" })).code, "DECISION_BUSY");
  t.mock.timers.tick(179_999);
  await tick();
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "EXECUTION_TIMEOUT");
  assert.deepEqual(sent.at(-1), ["agent-cancel", "execution-timeout"]);
  assert.match(logs.join("\n"), /r1 exceeded execution deadline 180000ms/);
  // The loop is no longer blocked: a late next request reaches a retry.
  exchange.ingest(message("r2", 2));
  const retry = await exchange.respond(EP, "r1", { kind: "actions" });
  assert.equal(retry.next.id, "r2");
});

test("a normal report clears the deadline; nothing fires later", async (t) => {
  const { exchange, sent } = setup(t);
  const pending = exchange.respond(EP, "r1", { kind: "actions" });
  await tick();
  exchange.ingest(message("r2", 2));
  assert.equal((await pending).next.id, "r2");
  t.mock.timers.tick(1_000_000);
  await tick();
  assert.deepEqual(sent.map(([m]) => m), ["agent-decision"]);
});

test("a custom deadline function is honoured", async (t) => {
  const { exchange } = setup(t, { deadlineMs: () => 5_000 });
  const pending = exchange.respond(EP, "r1", { kind: "actions" });
  await tick();
  t.mock.timers.tick(5_000);
  assert.equal((await pending).code, "EXECUTION_TIMEOUT");
});

test("a deadline above 2^31-1 ms is clamped instead of firing at once", async (t) => {
  const { exchange } = setup(t, { deadlineMs: () => 3e9 });
  let settled = false;
  exchange.respond(EP, "r1", { kind: "actions" }).then(() => { settled = true; });
  await tick();
  t.mock.timers.tick(10_000);
  await tick();
  assert.equal(settled, false);
});
