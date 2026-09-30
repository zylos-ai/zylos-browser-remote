import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "br-input-"));
process.env.BROWSER_REMOTE_KEY = "ef".repeat(32);
process.env.BROWSER_REMOTE_OBS_DIR = path.join(tmp, "files");
process.env.ZYLOS_C4_RECEIVE = path.join(tmp, "receive.js");
const output = path.join(tmp, "c4.jsonl");
fs.writeFileSync(
  process.env.ZYLOS_C4_RECEIVE,
  `const fs=require('fs'); fs.appendFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({ok:true,action:'queued',id:1}));`,
);
import { start, deliverRequestToC4 } from "../src/index.js";
import { normalizeAgentInput } from "../src/lib/agent-message.js";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const input = (id = "u1", sequence = 1) => ({
  type: "agent-input",
  version: 2,
  taskId: "task-a",
  id,
  sequence,
  message: {
    id,
    role: "user",
    content: [{ type: "text", text: `Owner ${id} $(literal)` }],
  },
  context: { pages: [{ tabId: 9, text: "Other active tab is context only" }] },
});
async function waitFor(predicate) {
  for (let i = 0; i < 300; i++) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Expected input event");
}
test("direct input validation bounds content and strips untrusted routing/execution", () => {
  const valid = input();
  const clean = normalizeAgentInput({
    ...valid,
    endpointId: "other",
    execution: { tools: [] },
  });
  assert.equal(clean.endpointId, undefined);
  assert.equal(clean.execution, undefined);
  assert.equal(clean.message.id, "u1");
  for (const patch of [
    { sequence: 0 },
    { sequence: 1.5 },
    { version: 1 },
    { taskId: "u1" },
    { message: { ...valid.message, id: "wrong" } },
    { message: { ...valid.message, role: "system" } },
    { context: { pages: [{ text: "x".repeat(18001) }] } },
  ])
    assert.throws(() => normalizeAgentInput({ ...valid, ...patch }));
});

test("owner input reaches C4 before the current decision completes and never replaces the browser exchange", async (t) => {
  const relay = await start({
    extPort: 0,
    agentPort: 0,
    monitor: true,
    activityEnabled: false,
  });
  const sockets = [];
  t.after(() => {
    sockets.forEach((ws) => ws.terminate());
    relay.close();
  });
  async function connect(browserId) {
    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.ext.server.address().port}/ext`,
      ["zylos-browser-remote.v3", `key.${process.env.BROWSER_REMOTE_KEY}`],
    );
    sockets.push(ws);
    const frames = [];
    ws.on("message", (raw) => frames.push(JSON.parse(raw)));
    await once(ws, "open");
    const send = (frame) => ws.send(JSON.stringify(frame));
    send({
      type: "hello",
      version: "test",
      browserId,
      capabilities: ["agent-loop-v1", "browser-instance-v1", "agent-input-v1"],
    });
    const ready = await waitFor(() => frames.find((f) => f.type === "ready"));
    assert.ok(ready.capabilities.includes("agent-input-v1"));
    return { ws, send, frames, endpoint: ready.endpointId };
  }
  const a = await connect("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const b = await connect("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const request = {
    type: "agent-request",
    version: 2,
    id: "r1",
    taskId: "task-a",
    round: 1,
    message: {
      id: "task-a",
      role: "user",
      content: [{ type: "text", text: "Original goal" }],
    },
    context: { pages: [] },
    execution: {},
  };
  a.send(request);
  await waitFor(() =>
    a.frames.find((f) => f.type === "agent-status" && f.state === "queued"),
  );
  const base = `http://127.0.0.1:${relay.agent.server.address().port}`;
  let settled = false;
  const pending = fetch(base + "/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: a.endpoint,
      id: "r1",
      decision: { kind: "actions" },
    }),
  })
    .then((r) => r.json())
    .then((result) => {
      settled = true;
      return result;
    });
  const call = await waitFor(() => a.frames.find((f) => f.type === "req"));
  // Keep the actual RPC in flight. Input must not wait for its response.
  const update = input();
  update.message.content.push({
    type: "file",
    id: "f1",
    name: "note.txt",
    mimeType: "text/plain",
    bytes: 2,
    data: "aGk=",
  });
  a.send({ ...update, endpointId: b.endpoint });
  const ack = await waitFor(() =>
    a.frames.find((f) => f.type === "agent-input-status" && f.inputId === "u1"),
  );
  assert.equal(ack.state, "queued");
  assert.equal(settled, false);
  a.send(input("u2", 2));
  await waitFor(() =>
    a.frames.find((f) => f.type === "agent-input-status" && f.inputId === "u2"),
  );
  assert.equal(settled, false);
  const deliveries = fs
    .readFileSync(output, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(deliveries.length, 3);
  for (const args of deliveries) {
    assert.equal(args[args.indexOf("--endpoint") + 1], a.endpoint);
    assert.ok(args.includes("--no-reply"));
    assert.ok(!args.includes("--require-idle"));
  }
  const content = deliveries[1][deliveries[1].indexOf("--content") + 1];
  assert.match(content, /replyInputId: u1/);
  const owner = JSON.parse(content.split("Owner input:\n")[1]);
  assert.equal(owner.taskId, "task-a");
  assert.equal(owner.message.content[0].text, "Owner u1 $(literal)");
  const file = owner.message.content[1];
  assert.equal(file.data, undefined);
  assert.equal(fs.readFileSync(file.path, "utf8"), "hi");
  assert.equal(
    b.frames.some((f) => f.type === "req" || f.type === "agent-input-status"),
    false,
  );
  a.send(input("u2", 2));
  await waitFor(() => a.frames.find((f) => f.code === "BAD_INPUT_SEQUENCE"));
  b.send(input());
  await waitFor(() => b.frames.find((f) => f.code === "STALE_INPUT"));
  a.send({ type: "resp", id: call.id, result: { accepted: true } });
  a.send({
    ...request,
    id: "r2",
    round: 2,
    message: { id: "task-a" },
    execution: { observation: { tabId: 3 } },
  });
  const result = await pending;
  assert.equal(result.next.id, "r2");
  assert.equal(result.next.taskId, "task-a");
  assert.equal(result.next.updates, undefined);
  assert.equal(JSON.stringify(result).includes("Owner u1"), false);
  assert.equal(result.next.execution.observation.tabId, 3);
  assert.equal(fs.readFileSync(output, "utf8").trim().split("\n").length, 3);
  a.send({ type: "agent-turn-end", taskId: "task-a", status: "done" });
  await waitFor(() => !fs.existsSync(file.path));
});

test("a slow C4 receipt does not serialize later owner input", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const received = [];
  const relay = await start({
    extPort: 0,
    agentPort: 0,
    activityEnabled: false,
    onRequest: async (msg) => {
      received.push(msg);
      if (msg.request.id === "u1") await held;
      return { ok: true };
    },
  });
  const ws = new WebSocket(
    `ws://127.0.0.1:${relay.ext.server.address().port}/ext`,
    ["zylos-browser-remote.v3", `key.${process.env.BROWSER_REMOTE_KEY}`],
  );
  t.after(() => {
    release();
    ws.terminate();
    relay.close();
  });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw)));
  const send = (value) => ws.send(JSON.stringify(value));
  await once(ws, "open");
  send({
    type: "hello",
    version: "test",
    browserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    capabilities: ["agent-loop-v1", "browser-instance-v1", "agent-input-v1"],
  });
  await waitFor(() => frames.find((f) => f.type === "ready"));
  send({
    type: "agent-request",
    version: 2,
    id: "r1",
    taskId: "task-a",
    round: 1,
    message: {
      id: "task-a",
      role: "user",
      content: [{ type: "text", text: "Original" }],
    },
    context: { pages: [] },
    execution: {},
  });
  await waitFor(() => frames.find((f) => f.type === "agent-status"));
  send(input());
  send(input("u2", 2));
  await waitFor(() => frames.find((f) => f.inputId === "u2"));
  assert.deepEqual(
    received.map((msg) => msg.request.id),
    ["r1", "u1", "u2"],
  );
  assert.equal(
    frames.some((f) => f.inputId === "u1"),
    false,
  );
});
