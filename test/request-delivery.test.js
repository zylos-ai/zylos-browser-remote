"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const WebSocket = require("ws");
const { start, deliverRequestToC4 } = require("../src/index");

test("C4 queue receipts distinguish accepted, unavailable, failed and uncertain delivery", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "br-delivery-"));
  const previous = process.env.ZYLOS_C4_RECEIVE;
  const script = path.join(tmp, "c4.js");
  process.env.ZYLOS_C4_RECEIVE = script;
  t.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_C4_RECEIVE;
    else process.env.ZYLOS_C4_RECEIVE = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const deliver = (timeoutMs = 2000) =>
    deliverRequestToC4(
      {
        endpointId: "a".repeat(12),
        text: "hello",
        chatId: "chat-1",
        request: { id: "r1", round: 1, payload: { text: "hello" } },
      },
      () => {},
      { timeoutMs },
    );
  for (const action of ["queued", "delivered", "suppressed"]) {
    fs.writeFileSync(
      script,
      `if (!process.argv.includes('--json')) process.exit(2); console.log(JSON.stringify({ok:true,action:${JSON.stringify(action)},id:7}));`,
    );
    assert.deepEqual(
      await deliver(),
      action === "queued"
        ? { ok: true }
        : { ok: false, code: "AGENT_UNAVAILABLE" },
    );
  }
  fs.writeFileSync(script, "process.exit(1);");
  assert.deepEqual(await deliver(), { ok: false, code: "C4_DELIVERY_FAILED" });
  fs.writeFileSync(script, 'console.log("unexpected output");');
  assert.deepEqual(await deliver(), {
    ok: false,
    code: "C4_DELIVERY_UNCONFIRMED",
  });
  fs.writeFileSync(script, "setInterval(() => {}, 1000);");
  assert.deepEqual(await deliver(100), {
    ok: false,
    code: "C4_DELIVERY_TIMEOUT",
  });
  fs.unlinkSync(script);
  assert.deepEqual(await deliver(), { ok: false, code: "C4_DELIVERY_FAILED" });
});
