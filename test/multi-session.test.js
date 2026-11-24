// Multi-session Core support (#32, #33, #14) against stub Core scripts in a
// throwaway ZYLOS_DIR. Every case also checks that an install without
// session_mode / without the manifest sees exactly the old arguments.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "br-multi-"));
process.env.ZYLOS_DIR = root;
process.env.BROWSER_REMOTE_OBS_DIR = path.join(root, "obs");
delete process.env.ZYLOS_C4_RECEIVE;
delete process.env.ZYLOS_C4_CONTROL;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { deliverRequestToC4 } = await import("../src/index.js");
const { interruptAgent } = await import("../src/lib/agent-interrupt.js");
const { AgentExchange } = await import("../src/lib/agent-exchange.js");
const { TaskSessions } = await import("../src/lib/task-sessions.js");
const { taskStartParams } = await import("../src/lib/task-start.js");
const { sessionFromEnv } = await import("../scripts/task-start.js");
const { AgentActivity } = await import("../src/lib/agent-activity.js");
const { c4ReceiveSupportsOption, readSessionMode } = await import("../src/lib/c4.js");

const scripts = path.join(root, ".claude/skills/comm-bridge/scripts");
const calls = path.join(root, "calls.jsonl");
const endpointId = "0123456789ab.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const browserGroup = `browser-${endpointId}`;

function config(value) {
  fs.mkdirSync(path.join(root, ".zylos"), { recursive: true });
  fs.writeFileSync(path.join(root, ".zylos/config.json"), JSON.stringify({ runtime: "claude", ...value }));
}
function manifest(withGroup) {
  const options = { "--channel": { takesValue: true }, ...(withGroup ? { "--session-group": { takesValue: true } } : {}) };
  fs.writeFileSync(path.join(scripts, "c4-receive-options.json"), JSON.stringify({ options }));
}
function ready(group, runId = "run-1", sessionId = "11111111-2222-4333-8444-555555555555") {
  const dir = path.join(root, "activity-monitor/session-groups", group);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "current-session.json"), JSON.stringify({ runId, sessionId, startupControlIds: [], ts: 1 }));
}
// Stub scripts record argv; `reply` is the body of the response logic.
function stub(name, reply) {
  fs.writeFileSync(path.join(scripts, name), `
    const fs = require("fs"); const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
    ${reply}`);
}
const recorded = (name) => fs.existsSync(calls)
  ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter(c => c[0] === name).map(c => c.slice(1))
  : [];
const optionValue = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

beforeEach(() => {
  fs.rmSync(path.join(root, ".zylos"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "activity-monitor"), { recursive: true, force: true });
  fs.rmSync(scripts, { recursive: true, force: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.rmSync(calls, { force: true });
});

const request = (id = "r1", execution = {}) => ({
  version: 2, id, taskId: "task-1", round: id === "r1" ? 1 : 2,
  message: { id: "task-1", role: "user", content: [{ type: "text", text: "hi" }] },
  context: { pages: [] }, execution,
});
const deliver = (extra = {}) => deliverRequestToC4({ endpointId, chatId: "task-1", request: request(), ...extra }, () => {}, { timeoutMs: 5000 });
// Stubs write .js under a module-type package; force CommonJS for them.
const cjs = () => fs.writeFileSync(path.join(scripts, "package.json"), '{"type":"commonjs"}');

test("c4-receive gets --session-group only when the manifest declares it, read on every call", async () => {
  cjs();
  stub("c4-receive.js", `console.log(JSON.stringify({ ok: true, action: "queued", id: 1,
    ...(args.includes("--session-group") ? { sessionGroup: "browser-remote:" + args[args.indexOf("--session-group") + 1] } : {}) }));`);
  // No manifest: exactly the old call (single-session Core).
  assert.deepEqual(await deliver(), { ok: true });
  manifest(false);
  assert.deepEqual(await deliver(), { ok: true });
  manifest(true);
  assert.deepEqual(await deliver(), { ok: true, sessionGroup: `browser-remote:${browserGroup}` });
  const runs = recorded("c4-receive.js");
  assert.equal(runs.length, 3);
  assert.ok(!runs[0].includes("--session-group") && !runs[1].includes("--session-group"));
  assert.equal(optionValue(runs[2], "--session-group"), browserGroup);
  assert.deepEqual(runs[0].slice(0, 8), ["--channel", "browser-remote", "--endpoint", endpointId, "--priority", "2", "--json", "--no-reply"]);
  assert.ok(c4ReceiveSupportsOption("--session-group"));
});

test("Core rejections are classified by persisted and never resent to the overall group", async () => {
  cjs();
  manifest(true);
  for (const [persisted, expected] of [[[], { ok: false, code: "C4_DELIVERY_FAILED" }],
    [null, { ok: false, code: "C4_DELIVERY_UNCONFIRMED" }], [["D1"], { ok: true }]]) {
    fs.rmSync(calls, { force: true });
    stub("c4-receive.js", `console.log(JSON.stringify({ ok: false, error: { code: "SESSION_GROUP_INVALID", message: "x", persisted: ${JSON.stringify(persisted)} } })); process.exitCode = 1;`);
    const logs = [];
    assert.deepEqual(await deliverRequestToC4({ endpointId, chatId: "task-1", request: request() }, (l) => logs.push(l), { timeoutMs: 5000 }), expected);
    const runs = recorded("c4-receive.js");
    assert.equal(runs.length, 1, "no resend");
    assert.equal(optionValue(runs[0], "--session-group"), browserGroup);
    assert.match(logs.join("\n"), /SESSION_GROUP_INVALID/);
  }
});

test("agent-started tasks are delivered to the starting session by a targeted control, only when it is running", async () => {
  cjs();
  manifest(true);
  stub("c4-receive.js", `console.log(JSON.stringify({ ok: true, action: "queued", id: 1 }));`);
  stub("c4-control.js", `console.log(JSON.stringify({ ok: true, data: { id: 9, supersededCount: 0 } }));`);
  const route = { origin: "agent", group: "lark:group-x" };
  // Single-session Core: the agent route is ignored, c4-receive as before.
  assert.deepEqual(await deliver({ route }), { ok: true });
  assert.equal(recorded("c4-control.js").length, 0);
  config({ session_mode: "multi" });
  const logs = [];
  assert.deepEqual(await deliverRequestToC4({ endpointId, chatId: "task-1", request: request(), route }, (l) => logs.push(l)),
    { ok: false, code: "AGENT_SESSION_NOT_RUNNING" });
  assert.equal(recorded("c4-control.js").length, 0, "not running: nothing sent");
  assert.match(logs.join("\n"), /lark:group-x is not running/);
  ready("lark:group-x", "run-7");
  assert.deepEqual(await deliver({ route }), { ok: true, sessionGroup: "lark:group-x" });
  const [args] = recorded("c4-control.js");
  assert.equal(args[0], "enqueue");
  assert.equal(optionValue(args, "--group"), "lark:group-x");
  assert.equal(optionValue(args, "--target-run"), "run-7");
  assert.equal(optionValue(args, "--ack-deadline"), "600");
  assert.ok(args.includes("--json") && args.includes("--no-ack-suffix"));
  assert.match(optionValue(args, "--content"), /\[Extension decision request /);
  // Core reports the session gone: logged, not resent.
  stub("c4-control.js", `console.log(JSON.stringify({ ok: false, error: { code: "TARGET_NOT_RUNNING", message: "x", persisted: [] } })); process.exitCode = 1;`);
  assert.deepEqual(await deliver({ route }), { ok: false, code: "AGENT_SESSION_NOT_RUNNING" });
  // Recovery requests carry their 120 s deadline; end notices need no request.
  stub("c4-control.js", `console.log(JSON.stringify({ ok: true, data: { id: 10, supersededCount: 0 } }));`);
  fs.rmSync(calls, { force: true });
  assert.equal((await deliver({ route, kind: "recovery", request: request("r2", { mode: "recovery" }) })).ok, true);
  assert.equal(optionValue(recorded("c4-control.js")[0], "--ack-deadline"), "120");
  assert.match(optionValue(recorded("c4-control.js")[0], "--content"), /\[Recovery\][\s\S]*120 seconds[\s\S]*replyCommands/);
  assert.equal((await deliver({ route, kind: "ended", request: undefined, status: "stopped" })).ok, true);
  assert.match(optionValue(recorded("c4-control.js")[1], "--content"), /\[Browser task ended .*\/task-1\]\nstatus: stopped\nreason: the browser owner pressed Stop/);
});

test("Stop: unchanged without session_mode; targeted with --group in multi mode; not sent when the session is down", async () => {
  cjs();
  const help = `if (args[0] === "--help") { console.error("enqueue --content <x> [--group G] [--target-run ID]"); process.exit(0); }`;
  stub("c4-control.js", `${help}
    if (args[0] === "enqueue") console.log(args.includes("--json") ? JSON.stringify({ ok: true, data: { id: 42 } }) : "OK: enqueued control 42");
    else console.log("status=done");`);
  const event = { endpointId, taskId: "task-1" };
  const logs = [];
  const stop = (route) => interruptAgent(event, (l) => logs.push(l), { pollMs: 10, route });
  // 1. Pre-multi-session Core: byte-identical enqueue arguments, no --help probe.
  assert.deepEqual(await stop(), { ok: true });
  let runs = recorded("c4-control.js");
  assert.deepEqual(runs[0], ["enqueue", "--content", "[KEYSTROKE]Escape", "--priority", "0", "--bypass-state", "--no-ack-suffix", "--ack-deadline", "5"]);
  assert.ok(!runs.some(a => a[0] === "--help"));
  // 2. Single mode after migration: origin.
  config({ session_mode: "single" });
  fs.rmSync(calls, { force: true });
  assert.deepEqual(await stop(), { ok: true });
  assert.equal(optionValue(recorded("c4-control.js").find(a => a[0] === "enqueue"), "--group"), "origin");
  // 3. Multi mode: the task's recorded session, bound to its running run.
  config({ session_mode: "multi" });
  ready("lark:group-x", "run-3");
  fs.rmSync(calls, { force: true });
  assert.deepEqual(await stop({ origin: "agent", group: "lark:group-x" }), { ok: true });
  const enqueue = recorded("c4-control.js").find(a => a[0] === "enqueue");
  assert.equal(optionValue(enqueue, "--group"), "lark:group-x");
  assert.equal(optionValue(enqueue, "--target-run"), "run-3");
  assert.ok(recorded("c4-control.js").some(a => a.join(" ") === "get --id 42"));
  // 4. Not running: nothing is enqueued.
  fs.rmSync(calls, { force: true });
  assert.deepEqual(await stop({ origin: "extension", group: "browser-remote:x" }), { ok: false, code: "AGENT_SESSION_NOT_RUNNING" });
  assert.ok(!recorded("c4-control.js").some(a => a[0] === "enqueue"));
  // 5. Core says the run is gone.
  stub("c4-control.js", `${help}
    console.log(JSON.stringify({ ok: false, error: { code: "TARGET_NOT_RUNNING", message: "x", persisted: [] } })); process.exitCode = 1;`);
  assert.deepEqual(await stop({ origin: "agent", group: "lark:group-x" }), { ok: false, code: "AGENT_SESSION_NOT_RUNNING" });
  // 6. Unrecorded task: the browser group's full name comes from Core's c4-db.
  stub("c4-db.js", `console.log(JSON.stringify({ ok: true, data: "browser-remote:" + args[args.indexOf("--session-group") + 1] }));`);
  stub("c4-control.js", `${help}
    if (args[0] === "enqueue") console.log(JSON.stringify({ ok: true, data: { id: 43 } })); else console.log("status=done");`);
  ready(`browser-remote:${browserGroup}`, "run-b");
  fs.rmSync(calls, { force: true });
  assert.deepEqual(await stop(), { ok: true });
  assert.deepEqual(recorded("c4-db.js")[0], ["session-group", "browser-remote", "--session-group", browserGroup, "--json"]);
  assert.equal(optionValue(recorded("c4-control.js").find(a => a[0] === "enqueue"), "--group"), `browser-remote:${browserGroup}`);
  // 7. session_mode present but this c4-control predates --group.
  stub("c4-control.js", `if (args[0] === "--help") { console.error("enqueue --content <x>"); process.exit(0); } console.log("OK: enqueued control 1");`);
  fs.rmSync(calls, { force: true });
  assert.deepEqual(await stop({ origin: "agent", group: "lark:group-x" }), { ok: false, code: "AGENT_INTERRUPT_UNSUPPORTED" });
  assert.ok(!recorded("c4-control.js").some(a => a[0] === "enqueue"));
  assert.match(logs.join("\n"), /not running \(TARGET_NOT_RUNNING\)/);
  assert.equal(readSessionMode().mode, "multi");
});

// #33 -------------------------------------------------------------------------
const message = (id, round, execution = { state: id }) => ({
  endpointId: "aaaaaaaaaaaa", chatId: "task",
  request: { version: 2, id, taskId: "task", round, message: { id: "task" }, context: { pages: [] }, execution },
});

test("with no reply call open, a recovery request is pushed once and a later reply call is pointed at it", async (t) => {
  const ext = new EventEmitter();
  const pushed = [];
  const exchange = new AgentExchange(ext, { push: (e) => pushed.push(e) });
  t.after(() => exchange.close());
  exchange.ingest(message("r1", 1));
  ext.request = async () => ({ accepted: true });
  const first = exchange.respond("aaaaaaaaaaaa", "r1", { kind: "actions", actions: [] });
  exchange.ingest(message("r2", 2));
  assert.equal((await first).next.id, "r2");
  // The agent now waits on a human; the browser loses control.
  assert.equal(exchange.ingest(message("rec", 3, { mode: "recovery", recovery: { expiresAt: 1 } })), true);
  assert.equal(exchange.ingest(message("rec", 3, { mode: "recovery", recovery: { expiresAt: 1 } })), true);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].kind, "recovery");
  assert.equal(pushed[0].request.id, "rec");
  assert.ok(pushed[0].request.replyCommands.actions.includes(" rec"));
  // A late reply call (a changed retry of an answered request) does not
  // receive the recovery request a second time.
  const late = await exchange.respond("aaaaaaaaaaaa", "r1", { kind: "actions", actions: [{ late: true }] });
  assert.equal(late.deliveredViaC4, "rec");
  assert.equal(late.next, undefined);
});

test("task ends the agent did not cause are pushed when no reply call is open; its own finish is not", async (t) => {
  for (const [status, expected] of [["stopped", 1], ["interrupted", 1], ["done", 0], ["blocked", 0]]) {
    const ext = new EventEmitter();
    const pushed = [];
    const exchange = new AgentExchange(ext, { push: (e) => pushed.push(e) });
    exchange.ingest(message("r1", 1));
    ext.emit("agent-turn-end", { endpointId: "aaaaaaaaaaaa", taskId: "task", status });
    assert.equal(pushed.length, expected, status);
    if (expected) assert.deepEqual([pushed[0].kind, pushed[0].status, pushed[0].known], ["ended", status, true]);
    exchange.close();
  }
  // A waiting reply call receives the end itself; no extra notice.
  const ext = new EventEmitter();
  const pushed = [];
  const exchange = new AgentExchange(ext, { push: (e) => pushed.push(e) });
  t.after(() => exchange.close());
  exchange.ingest(message("r1", 1));
  ext.request = async () => ({ accepted: true });
  const waiting = exchange.respond("aaaaaaaaaaaa", "r1", { kind: "actions", actions: [] });
  await new Promise((r) => setImmediate(r));
  ext.emit("agent-turn-end", { endpointId: "aaaaaaaaaaaa", taskId: "task", status: "stopped" });
  assert.equal((await waiting).status, "stopped");
  assert.equal(pushed.length, 0);
});

test("task sessions: agent owner wins, notices are deduplicated by id", () => {
  const tasks = new TaskSessions();
  assert.equal(tasks.record("e", "t", { origin: "agent", group: "bad group" }), undefined);
  tasks.record("e", "t", { origin: "agent", group: "lark:group-x" });
  tasks.record("e", "t", { origin: "extension", group: "browser-remote:browser-e" });
  assert.equal(tasks.get("e", "t").group, "lark:group-x");
  assert.equal(tasks.firstNotice("e", "t", "rec"), true);
  assert.equal(tasks.firstNotice("e", "t", "rec"), false);
  assert.equal(tasks.firstNotice("e", "other", "\nend"), true);
});

test("task-start records the starting session from ZYLOS_SESSION_GROUP and never forwards it", () => {
  assert.deepEqual(sessionFromEnv({}), {});
  assert.deepEqual(sessionFromEnv({ ZYLOS_SESSION_GROUP: "lark:group-x" }), { sessionGroup: "lark:group-x" });
  assert.deepEqual(sessionFromEnv({ ZYLOS_SESSION_GROUP: "origin" }), { sessionGroup: "origin" });
  assert.deepEqual(sessionFromEnv({ ZYLOS_SESSION_GROUP: "x y" }), {});
  const body = { endpoint: endpointId, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", prompt: "p", url: "https://example.com" };
  assert.deepEqual(Object.keys(taskStartParams({ ...body, sessionGroup: "lark:group-x" })), ["requestId", "prompt", "url"]);
  assert.throws(() => taskStartParams({ ...body, sessionGroup: "../x" }));
});

// #14 -------------------------------------------------------------------------
test("progress attribution accepts only the owning session's transcript in multi-session mode", () => {
  const conn = { capabilities: ["agent-activity-v1"] };
  const ext = { conns: new Map([["e", conn]]), isConnected: () => true };
  let multi = false;
  const activity = new AgentActivity(ext, { directory: root, groupFor: () => "lark:group-x", multi: () => multi,
    groupRun: (group) => group === "lark:group-x" ? { runId: "r", sessionId: "owner" } : null });
  conn.agentTurn = "task";
  const token = activity.bind({ endpointId: "e", request: { taskId: "task" } });
  const at = Date.now();
  // Single shared session: unchanged.
  assert.ok(activity.agentActivityRun(token, at, "anything"));
  multi = true;
  assert.ok(activity.agentActivityRun(token, at, "owner"));
  assert.equal(activity.agentActivityRun(token, at, "other-session"), null);
  assert.deepEqual([...activity.ownedSessions()], ["owner"]);
  activity.close();
});

test("agent-routed tasks get final-reply commands that hand off to the owning thread; others are unchanged", async () => {
  const { replyCommands } = await import("../scripts/reply-route.js");
  const plain = replyCommands(endpointId, "r1");
  assert.match(plain.done, /comm-bridge\/scripts\/c4-send\.js browser-remote '.*\|req:r1\|status:done'$/);
  const direct = replyCommands(endpointId, "r1", "i1", { direct: true });
  assert.match(direct.done, /browser-remote\/scripts\/handoff-final\.js '.*\|req:r1\|status:done\|input:i1'$/);
  assert.equal(direct.actions, replyCommands(endpointId, "r1", "i1").actions);
  const ext = new EventEmitter();
  const exchange = new AgentExchange(ext, { direct: (_e, task) => task === "task" });
  exchange.ingest(message("r1", 1));
  assert.match(exchange.states.get("aaaaaaaaaaaa").next.replyCommands.blocked, /handoff-final\.js/);
  exchange.close();
});

test("the handoff asks the owning browser thread to run the exact c4-send, with request, status and text", async () => {
  const { handoffMessage, owningGroup } = await import("../scripts/handoff-final.js");
  const target = `${endpointId}|req:r9|status:blocked|input:i3`;
  const text = "Login needed.\nEOF_FINAL_x appears here";
  const message = handoffMessage(target, text, { sender: "lark:group-x", delimiter: "EOF_FINAL_x" });
  assert.match(message, /^Please deliver to browser-remote .*\|req:r9\|status:blocked\|input:i3: the final blocked reply of browser request r9/);
  assert.match(message, /Why: thread lark:group-x started this browser task .* owner input i3/);
  // Delimiter never collides with the text; the command is the ordinary c4-send.
  const command = message.split("\n").find((l) => l.startsWith("cat <<"));
  const delimiter = /<<'([^']+)'/.exec(command)[1];
  assert.notEqual(delimiter, "EOF_FINAL_x");
  assert.equal(command, `cat <<'${delimiter}' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote '${target}'`);
  const lines = message.split("\n");
  const at = lines.indexOf(command);
  assert.deepEqual(lines.slice(at + 1, at + 4), ["Login needed.", "EOF_FINAL_x appears here", delimiter]);
  assert.throws(() => handoffMessage("bad", "x"));
  const run = (_node, args) => { assert.deepEqual(args.slice(1), ["session-group", "browser-remote", "--session-group", browserGroup, "--json"]);
    return JSON.stringify({ ok: true, data: `browser-remote:${browserGroup}` }); };
  assert.equal(owningGroup(endpointId, run, {}), `browser-remote:${browserGroup}`);
  assert.throws(() => owningGroup(endpointId, () => JSON.stringify({ ok: true, data: "other:x" }), {}));
});
