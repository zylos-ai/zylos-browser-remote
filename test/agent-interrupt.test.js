"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { interruptAgent } = require("../src/lib/agent-interrupt");
const { start } = require("../src/index");
const WebSocket = require("ws");
const { once } = require("node:events");
const { digest, keyIdOf } = require("../src/lib/keys");

test("interrupt uses a bounded out-of-band Escape and waits for delivery, without retrying", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-interrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "control.cjs");
  const calls = path.join(dir, "calls.jsonl");
  const status = path.join(dir, "status");
  fs.writeFileSync(
    script,
    `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');
    if (process.argv[2] === 'enqueue') console.log('OK: enqueued control 42');
    else console.log('status='+fs.readFileSync(${JSON.stringify(status)},'utf8'));
  `,
  );
  const event = { endpointId: "browser", taskId: "task" };
  fs.writeFileSync(status, "pending");
  const timer = setTimeout(() => fs.writeFileSync(status, "done"), 200);
  t.after(() => clearTimeout(timer));
  assert.deepEqual(
    await interruptAgent(event, () => {}, { script, pollMs: 10 }),
    { ok: true },
  );
  let recorded = fs
    .readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(recorded[0], [
    "enqueue",
    "--content",
    "[KEYSTROKE]Escape",
    "--priority",
    "0",
    "--bypass-state",
    "--no-ack-suffix",
    "--ack-deadline",
    "5",
  ]);
  assert.ok(
    recorded.slice(1).every((args) => args.join(" ") === "get --id 42"),
  );
  for (const terminal of ["failed", "timeout", "superseded"]) {
    fs.writeFileSync(status, terminal);
    assert.equal((await interruptAgent(event, () => {}, { script })).ok, false);
  }
  fs.writeFileSync(calls, "");
  fs.writeFileSync(
    script,
    `require('fs').appendFileSync(${JSON.stringify(calls)}, 'enqueue\\n'); console.log('unexpected receipt');`,
  );
  assert.equal(
    (await interruptAgent(event, () => {}, { script, deadlineSeconds: 1 })).ok,
    false,
  );
  assert.equal(fs.readFileSync(calls, "utf8"), "enqueue\n");
});

test("only an explicit current-turn stop interrupts; duplicate/stale ends and disconnects do not", async (t) => {
  const calls = [];
  let finish;
  const relay = await start({
    extPort: 0,
    agentPort: 0,
    onRequest: async () => ({ ok: true }),
    onStop: (event) => {
      calls.push(event);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  t.after(() => relay.close());
  const key = "ab".repeat(32);
  relay.ext.loadKeys = () => ({ [keyIdOf(key)]: { sha256: digest(key) } });
  const ws = new WebSocket(
    `ws://127.0.0.1:${relay.ext.server.address().port}/ext`,
    ["zylos-browser-remote.v3", `key.${key}`],
  );
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw)));
  const send = (frame) => ws.send(JSON.stringify(frame));
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      const value = predicate();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("Missing transport event");
  };
  await once(ws, "open");
  send({
    type: "hello",
    browserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    capabilities: ["agent-loop-v1", "browser-instance-v1", "agent-message-v2"],
  });
  const ready = await wait(() => frames.find((f) => f.type === "ready"));
  assert.ok(ready.capabilities.includes("agent-interrupt-v1"));
  const request = (id) =>
    send({
      type: "agent-request",
      version: 2,
      id,
      taskId: id,
      round: 1,
      message: { id, role: "user", content: [{ type: "text", text: "hello" }] },
      context: { pages: [] },
      execution: {},
    });
  const end = (taskId, status, interrupt = true) =>
    send({ type: "agent-turn-end", taskId, status, interrupt });
  for (const status of ["done", "blocked", "interrupted"]) {
    request(status);
    await wait(() =>
      frames.find((f) => f.type === "agent-status" && f.requestId === status),
    );
    end(status, status);
  }
  request("active");
  await wait(() => frames.find((f) => f.requestId === "active"));
  end("stale", "stopped");
  end("active", "stopped");
  end("active", "stopped");
  await wait(() => calls.length);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, "active");
  request("too-early");
  assert.equal(
    (await wait(() => frames.find((f) => f.requestId === "too-early"))).code,
    "AGENT_STOPPING",
  );
  finish({ ok: true });
  assert.equal(
    (await wait(() => frames.find((f) => f.type === "agent-stop-result"))).ok,
    true,
  );
  request("new");
  assert.equal(
    (await wait(() => frames.find((f) => f.requestId === "new"))).state,
    "queued",
  );
  end("new", "stopped", false);
  request("disconnect");
  await wait(() => frames.find((f) => f.requestId === "disconnect"));
  ws.close();
  await once(ws, "close");
  assert.equal(calls.length, 1);
});
