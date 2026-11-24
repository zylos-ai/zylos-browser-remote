import { test } from "node:test";
import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL, END_REASONS } from "../src/lib/ext-lane.js";
import { AgentExchange } from "../src/lib/agent-exchange.js";
import { digest, keyIdOf } from "../src/lib/keys.js";
import { endedNotice } from "../src/index.js";

async function lane(t) {
  const key = "cd".repeat(32);
  const browser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const endpoint = `${keyIdOf(key)}.${browser}`;
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }) });
  await ext.listen(0, "127.0.0.1");
  const ws = new WebSocket(`ws://127.0.0.1:${ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
  t.after(() => { ws.close(); ext.close(); });
  await once(ws, "open");
  const connected = once(ext, "connected");
  ws.send(JSON.stringify({ type: "hello", browserId: browser, capabilities: ["agent-loop-v1", "browser-instance-v1"] }));
  await connected;
  return { ext, ws, endpoint };
}

for (const [sent, expected] of [["tab_moved", "tab_moved"], ["transport_lost", "transport_lost"], ["something_new", "other"], [7, "other"], [undefined, undefined]])
  test(`agent-turn-end reason ${String(sent)} -> ${String(expected)}`, async (t) => {
    const { ext, ws, endpoint } = await lane(t);
    ext.conns.get(endpoint).agentTurn = "task";
    const ended = once(ext, "agent-turn-end");
    ws.send(JSON.stringify({ type: "agent-turn-end", taskId: "task", status: "stopped", ...(sent !== undefined ? { reason: sent } : {}) }));
    const [event] = await ended;
    assert.equal(event.reason, expected);
  });

test("the exchange carries the reason into the end notice event", () => {
  const ext = new EventEmitter();
  const pushed = [];
  const exchange = new AgentExchange(ext, { push: (e) => pushed.push(e) });
  exchange.ingest({ endpointId: "aaaaaaaaaaaa", chatId: "task", request: { id: "r1", taskId: "task", round: 1 } });
  ext.emit("agent-turn-end", { endpointId: "aaaaaaaaaaaa", taskId: "task", status: "interrupted", reason: "recovery_expired" });
  assert.equal(pushed[0].reason, "recovery_expired");
  exchange.close();
});

test("the end notice states every known reason in plain words", () => {
  for (const reason of END_REASONS) {
    const notice = endedNotice({ endpointId: "e", taskId: "t", status: "stopped", reason });
    assert.match(notice, new RegExp(`cause: .+ \\(${reason}\\)`));
  }
  assert.match(endedNotice({ endpointId: "e", taskId: "t", status: "interrupted", reason: "tab_closed" }), /cause: the task's tab was closed/);
  assert.doesNotMatch(endedNotice({ endpointId: "e", taskId: "t", status: "stopped" }), /cause:/);
});
