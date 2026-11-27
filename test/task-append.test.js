import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { AgentLane } from "../src/lib/agent-lane.js";
import { digest, keyIdOf } from "../src/lib/keys.js";
import { createClient } from "../scripts/relay-client.js";
import { parseSendTarget, parseReplyEndpoint } from "../scripts/reply-route.js";
import { handoffMessage } from "../scripts/handoff-final.js";
import {
  taskAppendParams, taskAppendResult, appendIdFor, TASK_APPEND_CAPABILITY, TASK_APPEND_TIMEOUT_MS,
} from "../src/lib/task-append.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const key = "cd".repeat(32);
const browserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const endpoint = `${keyIdOf(key)}.${browserId}`;
const text = "The review finished: two comments, both addressed.";
const body = { endpoint, taskId, text };
const appendId = appendIdFor(endpoint, taskId, text);

async function setup(t, handler, caps = [TASK_APPEND_CAPABILITY], laneOptions = {}) {
  const logs = [];
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }) });
  await ext.listen(0, "127.0.0.1");
  const agent = new AgentLane({ extLane: ext, port: 0, log: (line) => logs.push(line), ...laneOptions });
  await agent.listen();
  t.after(() => { agent.close(); ext.close(); });
  const client = createClient({ base: `http://127.0.0.1:${agent.server.address().port}` });
  const ws = new WebSocket(`ws://127.0.0.1:${ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
  await once(ws, "open");
  const frames = [], ready = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw);
    if (frame.type === "ready") ready.push(frame);
    if (frame.type !== "req") return;
    frames.push(frame);
    const value = handler(frame, ws);
    if (value !== undefined) ws.send(JSON.stringify({ type: "resp", id: frame.id, result: value }));
  });
  const connected = once(ext, "connected");
  ws.send(JSON.stringify({ type: "hello", browserId, capabilities: ["agent-loop-v1", "browser-instance-v1", ...caps] }));
  await connected;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { client, frames, ready, ws, ext, logs };
}
const appended = (frame, extra = {}) => ({
  taskId: frame.params.taskId, appendId: frame.params.appendId, status: "appended", count: 1, limit: 20, ...extra,
});

test("append params are strict: exact endpoint, task ID, 1–8000 characters, nothing else", () => {
  assert.deepEqual(taskAppendParams({ ...body, text: `  ${text}\n` }), body);
  for (const change of [{ endpoint: keyIdOf(key) }, { endpoint: "all" }, { taskId: "" }, { taskId: "a b" },
    { taskId: "x".repeat(129) }, { text: " " }, { text: "x".repeat(8001) }, { text: 1 }, { requestId: "r1" }]) {
    assert.throws(() => taskAppendParams({ ...body, ...change }));
  }
  assert.equal(appendIdFor(endpoint, taskId, text), appendId);
  assert.notEqual(appendIdFor(endpoint, taskId, `${text}!`), appendId);
  assert.notEqual(appendIdFor(endpoint, "other", text), appendId);
  for (const change of [{ taskId: "other" }, { appendId: "other" }, { status: "done" }, { count: 0 },
    { count: 21 }, { extra: true }]) {
    assert.throws(() => taskAppendResult({ taskId, appendId, status: "appended", count: 1, limit: 20, ...change }, { taskId, appendId }));
  }
});

test("C4 append route parses alongside, and never changes, the final reply route", () => {
  assert.deepEqual(parseSendTarget(`${endpoint}|task:${taskId}|append`), { kind: "append", endpoint, taskId });
  assert.deepEqual(parseSendTarget(`${endpoint}|req:r1|status:done`), { kind: "reply", endpoint, id: "r1", status: "done" });
  assert.deepEqual(parseReplyEndpoint(`${endpoint}|req:r1|status:blocked|input:i1`),
    { endpoint, id: "r1", status: "blocked", inputId: "i1" });
  assert.throws(() => parseReplyEndpoint(`${endpoint}|task:${taskId}|append`));
  assert.throws(() => parseSendTarget(`${keyIdOf(key)}|task:${taskId}|append`), /exact browser endpoint/);
  for (const bad of [`${endpoint}|task:${taskId}`, `${endpoint}|task:a b|append`, `${endpoint}|task:${taskId}|append|x`, endpoint]) {
    assert.throws(() => parseSendTarget(bad));
  }
});

test("happy path: negotiated capability, exact params once, confirmed delivery", async (t) => {
  const { client, frames, ready, logs } = await setup(t, (frame) => appended(frame, { count: 3 }));
  assert.ok(ready[0].capabilities.includes(TASK_APPEND_CAPABILITY));
  const response = await client.taskAppend(body);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true, endpointId: endpoint, delivered: true, taskId, appendId, status: "appended", count: 3, limit: 20,
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, "task.append");
  assert.deepEqual(frames[0].params, { taskId, appendId, text });
  assert.ok(logs.some((line) => line.includes("appended (3/20)")));
  assert.ok(!logs.join("\n").includes(text), "follow-up text must not be logged");
});

test("capability missing: the relay refuses with a clear error and never asks the browser", async (t) => {
  const { client, frames, ready } = await setup(t, appended, []);
  assert.ok(!ready[0].capabilities.includes(TASK_APPEND_CAPABILITY));
  const response = await client.taskAppend(body);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "TASK_APPEND_UNSUPPORTED");
  assert.match(response.body.message, /agent-task-append-v1/);
  assert.equal((await client.taskAppend({ ...body, endpoint: keyIdOf(key) })).body.code, "BAD_REQUEST");
  assert.equal(frames.length, 0);
});

test("offline browser: explicit EXT_OFFLINE, never a silent success", async (t) => {
  const { client, ws, ext, frames } = await setup(t, appended);
  const gone = once(ext, "disconnected");
  ws.close();
  await gone;
  const response = await client.taskAppend(body);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "EXT_OFFLINE");
  assert.match(response.body.message, /NOT delivered/);
  assert.notEqual(response.body.ok, true);
  assert.equal(frames.length, 0);
});

test("extension refusals pass through with fixed messages; private text stays private", async (t) => {
  let code;
  const { client } = await setup(t, (frame, ws) => {
    ws.send(JSON.stringify({ type: "error", id: frame.id, code, message: "private sentinel" }));
  });
  const expected = {
    TASK_UNKNOWN: [404, /no such task/],
    TASK_TOO_OLD: [410, /24 hours/],
    TASK_APPEND_LIMIT: [429, /20 follow-up/],
    TASK_ACTIVE: [409, /still running/],
    TASK_NOT_APPENDABLE: [409, /did not end/],
    TASK_APPEND_CONFLICT: [409, /different follow-up/],
    BAD_PARAMS: [400, /Invalid/],
    TASK_APPEND_FAILED: [502, /could not save/],
  };
  for (const [name, [status, message]] of Object.entries(expected)) {
    code = name;
    const response = await client.taskAppend(body);
    assert.equal(response.status, status, name);
    assert.equal(response.body.code, name);
    assert.match(response.body.message, message);
    assert.doesNotMatch(JSON.stringify(response.body), /private sentinel/);
  }
  code = "SOMETHING_ELSE";
  assert.equal((await client.taskAppend(body)).body.code, "TASK_APPEND_FAILED");
});

test("no acknowledgement: outcome unconfirmed, same-text retry is safe (same append ID)", async (t) => {
  let answer = false;
  const { client, frames } = await setup(t, (frame) => (answer ? appended(frame, { status: "existing" }) : undefined),
    [TASK_APPEND_CAPABILITY], { taskAppendTimeoutMs: 300 });
  const first = await client.taskAppend(body);
  assert.equal(first.status, 504);
  assert.equal(first.body.code, "TASK_APPEND_UNCONFIRMED");
  assert.match(first.body.message, /same text is safe/);
  answer = true;
  const retry = await client.taskAppend(body);
  assert.equal(retry.body.status, "existing");
  assert.equal(frames.length, 2);
  assert.equal(frames[0].params.appendId, frames[1].params.appendId);
});

test("disconnect while waiting is unconfirmed; mismatched response is not delivery", async (t) => {
  let mode = "mismatch";
  const { client } = await setup(t, (frame, ws) => {
    if (mode === "close") { ws.close(); return undefined; }
    return appended(frame, { taskId: "other" });
  });
  const bad = await client.taskAppend(body);
  assert.equal(bad.body.code, "BAD_TASK_APPEND_RESPONSE");
  assert.notEqual(bad.body.delivered, true);
  mode = "close";
  assert.equal((await client.taskAppend(body)).body.code, "TASK_APPEND_UNCONFIRMED");
});

test("default extension acknowledgement timeout is 10s", () => {
  assert.equal(TASK_APPEND_TIMEOUT_MS, 10000);
  assert.equal(new AgentLane({ extLane: null, port: 0 }).taskAppendTimeoutMs, 10000);
});

test("handoff to the owning browser thread carries the append route unchanged", () => {
  const target = `${endpoint}|task:${taskId}|append`;
  const message = handoffMessage(target, text, { sender: "lark:group-x", delimiter: "EOF_FINAL_x" });
  assert.match(message, /follow-up reply to the ended browser task/);
  assert.ok(message.includes(`c4-send.js browser-remote '${target}'`));
  assert.ok(message.includes(text));
  assert.doesNotMatch(message, /final .* reply of browser request/);
  assert.match(handoffMessage(target, text), /<<'EOF_FOLLOWUP_[0-9a-f]{8}'/);
});

// A stand-in for Core's comm-bridge scripts: c4-db resolves the owning group,
// and c4-send asks the component's session-group.js about the exact outbound
// address first, as multi-session Core does, before recording the send.
function fakeCore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const groupScript = path.resolve(__dirname, "../scripts/session-group.js");
  fs.writeFileSync(path.join(dir, "c4-db.js"),
    `process.stdout.write(JSON.stringify({ ok: true, data: "browser-remote:" + process.argv[5] }));\n`);
  fs.writeFileSync(path.join(dir, "c4-send.js"), `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [channel, address] = process.argv.slice(2);
if (channel !== "internal") execFileSync(process.execPath, [${JSON.stringify(groupScript)}, address], { stdio: ["ignore", "pipe", "inherit"] });
fs.writeFileSync(${JSON.stringify(path.join(dir, "sent.json"))}, JSON.stringify({ channel, address, text: fs.readFileSync(0, "utf8") }));
process.stdout.write("sent\\n");
`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
  return { dir, sent: () => JSON.parse(fs.readFileSync(path.join(dir, "sent.json"), "utf8")) };
}

async function runHandoff(target, input, env) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "../scripts/handoff-final.js"), target], {
    env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("handoff-final.js hands off or sends a follow-up with follow-up wording", async (t) => {
  const core = fakeCore(t);
  const target = `${endpoint}|task:${taskId}|append`;
  const group = `browser-remote:browser-${endpoint}`;
  const handed = await runHandoff(target, text, { ZYLOS_C4_SCRIPTS: core.dir, ZYLOS_SESSION_GROUP: "lark:group-x" });
  assert.equal(handed.code, 0, handed.stderr);
  assert.equal(core.sent().channel, "internal");
  assert.equal(core.sent().address, group);
  assert.match(core.sent().text, /follow-up reply to the ended browser task/);
  assert.match(handed.stderr, /The follow-up is shown when that thread runs the command/);
  assert.doesNotMatch(handed.stderr, /task ends/);
  // The owning thread itself: sent directly; Core's session-group query accepts the address.
  const direct = await runHandoff(target, text, { ZYLOS_C4_SCRIPTS: core.dir, ZYLOS_SESSION_GROUP: group });
  assert.equal(direct.code, 0, direct.stderr);
  assert.deepEqual(core.sent(), { channel: "browser-remote", address: target, text });
  const empty = await runHandoff(target, " ", { ZYLOS_C4_SCRIPTS: core.dir });
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /Follow-up must contain/);
});

async function runSend(args, base) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "../scripts/send.js"), ...args], {
    env: { ...process.env, BROWSER_REMOTE_AGENT_URL: base }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("send.js routes an append to /task/append and exits non-zero unless delivered", async (t) => {
  const seen = [];
  let answer = { ok: true, delivered: true, endpointId: endpoint, taskId, appendId, status: "appended", count: 1, limit: 20 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, body: JSON.parse(raw) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await runSend([`${endpoint}|task:${taskId}|append`, `  ${text}\n`], base);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(seen[0], { path: "/task/append", body: { endpoint, taskId, text } });
  assert.doesNotMatch(ok.stderr, /already/);
  answer = { ...answer, status: "existing" };
  const resend = await runSend([`${endpoint}|task:${taskId}|append`, text], base);
  assert.equal(resend.code, 0, resend.stderr);
  assert.match(resend.stderr, /already saved and shown .* not shown again/);
  seen.pop();
  answer = { ok: false, code: "TASK_TOO_OLD", message: "old" };
  const refused = await runSend([`${endpoint}|task:${taskId}|append`, text], base);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /TASK_TOO_OLD/);
  const empty = await runSend([`${endpoint}|task:${taskId}|append`, " "], base);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /Follow-up must contain/);
  const bare = await runSend([`${keyIdOf(key)}|task:${taskId}|append`, text], base);
  assert.equal(bare.code, 2);
  assert.equal(seen.length, 2);
});

test("a request the relay could not send is EXT_OFFLINE; a lost in-flight one is unconfirmed", async (t) => {
  let failure;
  const stub = {
    resolve: (value) => ({ endpointId: value }),
    status: () => ({ [endpoint]: { capabilities: [TASK_APPEND_CAPABILITY] } }),
    request: async () => { throw failure; },
  };
  const agent = new AgentLane({ extLane: stub, port: 0 });
  await agent.listen();
  t.after(() => agent.close());
  const client = createClient({ base: `http://127.0.0.1:${agent.server.address().port}` });
  failure = Object.assign(new Error("extension not connected"), { code: "EXT_OFFLINE", unsent: true });
  assert.equal((await client.taskAppend(body)).body.code, "EXT_OFFLINE");
  failure = Object.assign(new Error("extension disconnected"), { code: "EXT_OFFLINE" });
  assert.equal((await client.taskAppend(body)).body.code, "TASK_APPEND_UNCONFIRMED");
});
