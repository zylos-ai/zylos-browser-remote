
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { start, deliverRequestToC4 } from "../src/index.js";

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
  const deliver = (timeoutMs = 2000, activityId) =>
    deliverRequestToC4(
      {
        endpointId: "a".repeat(12),
        activityId,
        text: "hello",
        chatId: "chat-1",
        request: {
          version: 2,
          id: "r1",
          taskId: "chat-1",
          round: 1,
          message: {
            id: "chat-1",
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
          context: { pages: [] },
          execution: {},
        },
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
  const activityId = "12345678-1234-4567-89ab-123456789abc";
  fs.writeFileSync(
    script,
    `
    const content = process.argv[process.argv.indexOf('--content') + 1];
    const expected = '[Browser] [Activity ${activityId}]';
    if (!content.slice(0, 100).includes(expected)) process.exit(3);
    if (!content.includes('[Extension decision request aaaaaaaaaaaa/r1]')) process.exit(4);
    console.log(JSON.stringify({ok:true,action:'queued',id:7}));
  `,
  );
  assert.deepEqual(await deliver(2000, activityId), { ok: true });
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
