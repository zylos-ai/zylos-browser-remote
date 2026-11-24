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

test("deadline is derived from declared budgets with a floor, cap and default", () => {
  assert.equal(executionDeadlineMs({ kind: "actions" }), 180_000);
  assert.equal(executionDeadlineMs({ timeoutMs: 1000 }), 61_000);
  assert.equal(executionDeadlineMs({ timeoutMs: 200_000 }), 260_000);
  assert.equal(executionDeadlineMs({ actions: [{ timeoutMs: 30_000 }, { args: { ms: 50_000 } }] }), 140_000);
  assert.equal(executionDeadlineMs({ timeoutMs: 1e9 }), 900_000);
  assert.equal(executionDeadlineMs({ timeoutMs: -5, actions: "x" }), 180_000);
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
