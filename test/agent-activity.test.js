import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentActivity,
  ActivitySession,
  CAPABILITY,
  HISTORY_CAPABILITY,
  describeTool,
} from "../src/lib/agent-activity.js";
import { Monitor } from "../src/lib/monitor.js";
import { RolloutSession } from "../src/lib/agent-trace.js";

function fixture(runtime = "codex", history = false) {
  let now = 10000;
  const frames = [];
  const ext = {
    conns: new Map(),
    isConnected: (id) => ext.conns.has(id),
    _send: (conn, frame) => frames.push({ conn, ...frame }),
  };
  const collector = new AgentActivity(ext, { now: () => now });
  const connect = (
    endpointId,
    taskId = "same-task",
    capabilities = history ? [CAPABILITY, HISTORY_CAPABILITY] : [CAPABILITY],
  ) => {
    ext.conns.set(endpointId, { agentTurn: taskId, capabilities });
    const token = collector.bind({ endpointId, request: { taskId } });
    return token;
  };
  const token = connect("aaaaaaaaaaaa.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const session = new ActivitySession(collector, "session", now, runtime);
  const emit = (type, payload) =>
    session.event({ timestamp: new Date(++now).toISOString(), type, payload });
  const prompt = (id = token) =>
    emit("response_item", {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `[Browser] [Activity ${id}]\n[Browser] [Extension decision request endpoint/request]`.slice(
            0,
            100,
          ),
        },
      ],
    });
  const call = (
    id = "call",
    name = "functions.exec_command",
    args = { cmd: "python3 script.py --key=super-secret" },
  ) =>
    emit("response_item", {
      type: "function_call",
      call_id: id,
      name,
      arguments: JSON.stringify(args),
    });
  const result = (id = "call") =>
    emit("response_item", {
      type: "function_call_output",
      call_id: id,
      output: "SECRET OUTPUT",
    });
  const claude = (type, content, other = {}) =>
    session.event({
      timestamp: new Date(++now).toISOString(),
      type,
      sessionId: "session",
      uuid: `${now}`,
      message: { content },
      ...other,
    });
  return {
    collector,
    ext,
    frames,
    session,
    token,
    connect,
    emit,
    prompt,
    call,
    result,
    claude,
    now: () => now,
  };
}

test("Codex activity replaces one current frame, pairs overlapping tools and never leaks arguments or output", () => {
  const f = fixture();
  f.prompt();
  f.call();
  f.collector.flush();
  assert.equal(f.frames.at(-1).category, "command");
  assert.equal(f.frames.at(-1).detail, "python3");
  f.call("read", "read_file", { path: "/private/customer.txt" });
  f.collector.flush();
  assert.equal(f.frames.at(-1).category, "read");
  f.result("call");
  f.collector.flush();
  assert.equal(f.frames.at(-1).category, "read");
  f.result("read");
  f.collector.flush();
  assert.equal(f.frames.at(-1).phase, "returned");
  assert.deepEqual(
    f.frames.map((f) => f.sequence),
    [1, 2, 3, 4],
  );
  assert.doesNotMatch(
    JSON.stringify(f.frames),
    /secret|SECRET|customer|script.py/,
  );
  f.emit("event_msg", { type: "task_complete" });
  f.collector.flush();
  assert.equal(f.frames.at(-1).category, "idle");
});

for (const field of ["channel", "phase"])
  test(`Codex ${field} commentary and paired tools preserve quick events between polls`, () => {
    const f = fixture("codex", true);
    f.prompt();
    const comment = {
      type: "message",
      id: "comment-1",
      role: "assistant",
      [field]: "commentary",
      content: [
        {
          type: "output_text",
          text: "I will compare the sources. API_KEY=secret-value",
        },
      ],
    };
    f.emit("response_item", comment);
    f.emit("response_item", comment);
    f.emit("response_item", {
      ...comment,
      id: "private",
      channel: "analysis",
      content: [{ type: "output_text", text: "PRIVATE reasoning" }],
    });
    f.emit("response_item", {
      type: "reasoning",
      summary: [{ text: "PRIVATE summary" }],
    });
    f.emit("response_item", {
      ...comment,
      id: "final",
      channel: "final",
      content: [{ type: "output_text", text: "FINAL" }],
    });
    f.call();
    f.result();
    f.call("two", "read_file");
    f.collector.flush();
    const events = f.frames.at(-1).events;
    assert.equal(events.length, 3);
    assert.match(events[0].text, /compare the sources/);
    assert.match(events[0].text, /已隐藏/);
    assert.equal(events[1].tool, "exec_command");
    assert.equal(events[1].detail, "python3");
    assert.ok(events[1].endedAt >= events[1].at);
    assert.equal(events[2].tool, "read_file");
    assert.doesNotMatch(
      JSON.stringify(f.frames),
      /PRIVATE|FINAL|secret-value|script.py|SECRET OUTPUT/,
    );
    f.result("two");
    f.collector.flush();
    assert.equal(f.frames.at(-1).events.length, 1);
    assert.equal(f.frames.at(-1).events[0].id, events[2].id);
    assert.ok(f.frames.at(-1).events[0].endedAt);
  });

test("Claude public text is captured once; hidden thinking, tools output and other routes remain excluded", () => {
  const f = fixture("claude", true);
  f.claude("user", `[Browser] [Activity ${f.token}]`);
  const content = [
    { type: "text", text: "Checking the next group of results." },
    { type: "thinking", thinking: "PRIVATE" },
    { type: "redacted_thinking", data: "PRIVATE" },
    {
      type: "tool_use",
      id: "read",
      name: "Read",
      input: { path: "/secret/file" },
    },
  ];
  f.claude("assistant", content, { uuid: "once" });
  f.claude("assistant", content, { uuid: "once" });
  f.claude("assistant", [{ type: "text", text: "SIDECHAIN" }], {
    isSidechain: true,
  });
  f.collector.flush();
  assert.equal(f.frames.at(-1).events.length, 2);
  const count = f.frames.length;
  f.claude("user", [
    { type: "tool_result", tool_use_id: "read", content: "PRIVATE" },
  ]);
  f.claude("user", "different channel");
  f.claude("assistant", [{ type: "text", text: "UNRELATED" }]);
  f.collector.flush();
  assert.ok(f.frames.length > count);
  assert.doesNotMatch(
    JSON.stringify(f.frames),
    /PRIVATE|SIDECHAIN|UNRELATED|secret/,
  );
});

test("history is bounded, capability gated, and never drained into another browser or mixed turn", () => {
  const old = fixture();
  old.prompt();
  old.call();
  old.collector.flush();
  assert.equal(old.frames.at(-1).events, undefined);
  const f = fixture("codex", true);
  const a = [...f.ext.conns.keys()][0];
  const b = "aaaaaaaaaaaa.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const tokenB = f.connect(b);
  f.prompt();
  for (let i = 0; i < 550; i++) f.call(`call-${i}`);
  f.collector.flush();
  assert.equal(f.frames.at(-1).endpointId, a);
  assert.equal(f.frames.at(-1).events.length, 100);
  assert.equal(f.frames.at(-1).dropped, 50);
  for (let i = 0; i < 4; i++) f.collector.flush();
  assert.equal(f.frames.flatMap((frame) => frame.events || []).length, 500);
  assert.ok(f.frames.every((frame) => frame.endpointId === a));
  f.call("unflushed");
  f.prompt(tokenB);
  f.collector.flush();
  assert.ok(
    !f.frames
      .flatMap((frame) => frame.events || [])
      .some((event) => event.id.includes("unflushed")),
  );
});

test("same key and same task ID in two installations, reconnects, old tokens and mixed channels remain isolated", () => {
  const f = fixture();
  const endpointA = [...f.ext.conns.keys()][0];
  const endpointB = "aaaaaaaaaaaa.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const tokenB = f.connect(endpointB);
  f.prompt();
  f.call();
  f.collector.flush();
  assert.equal(f.frames.at(-1).endpointId, endpointA);
  f.prompt(tokenB);
  f.call("ambiguous");
  f.collector.flush();
  assert.ok(
    f.frames.every(
      (frame) => frame.category === "idle" || frame.endpointId === endpointA,
    ),
  );
  f.emit("event_msg", { type: "task_started" });
  f.prompt(tokenB);
  f.call("b");
  f.collector.flush();
  assert.equal(f.frames.at(-1).endpointId, endpointB);
  assert.equal(f.frames.at(-1).category, "command");
  f.collector.unbind(endpointB);
  const count = f.frames.length;
  f.call("late");
  f.collector.flush();
  assert.equal(f.frames.length, count);
  const replacement = f.connect(endpointB);
  assert.notEqual(replacement, tokenB);
  f.emit("event_msg", { type: "task_started" });
  f.prompt(tokenB);
  f.call("old-token");
  f.collector.flush();
  assert.equal(f.frames.length, count);
  f.emit("event_msg", { type: "task_started" });
  f.emit("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "[Lark] unrelated task" }],
  });
  f.call("other-channel");
  f.collector.flush();
  assert.equal(f.frames.length, count);
});

test("Claude root transcript tools work; reasoning, subagents and tool-result text cannot impersonate prompts", () => {
  const f = fixture("claude");
  f.claude("user", `[Browser] [Activity ${f.token}]`);
  f.claude("assistant", [
    { type: "thinking", thinking: "PRIVATE" },
    {
      type: "tool_use",
      id: "bash",
      name: "Bash",
      input: { command: "rg token /private/file" },
    },
  ]);
  f.collector.flush();
  assert.equal(f.frames.at(-1).detail, "rg");
  const count = f.frames.length;
  f.claude(
    "assistant",
    [{ type: "tool_use", id: "child", name: "Write", input: {} }],
    { isSidechain: true },
  );
  f.collector.flush();
  assert.equal(f.frames.length, count);
  f.claude("user", [
    {
      type: "tool_result",
      tool_use_id: "bash",
      content: `[Browser] [Activity ${f.token}] PRIVATE`,
    },
  ]);
  f.collector.flush();
  assert.equal(f.frames.at(-1).phase, "returned");
  assert.doesNotMatch(JSON.stringify(f.frames), /PRIVATE|private/);
  f.claude("user", "unrelated next task");
  f.claude("assistant", [
    { type: "tool_use", id: "other", name: "Read", input: {} },
  ]);
  f.collector.flush();
  assert.equal(f.frames.at(-1).category, "idle");
});

test("collector polls bounded files without Monitor, handles partial lines and rotation, and does no idle discovery", async (t) => {
  const f = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-activity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const record = (payload) =>
    JSON.stringify({
      timestamp: new Date(f.now()).toISOString(),
      type: "response_item",
      payload,
    });
  const prompt = record({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `[Browser] [Activity ${f.token}]` }],
  });
  const call = record({
    type: "function_call",
    call_id: "a",
    name: "exec_command",
    arguments: '{"cmd":"node hello.js"}',
  });
  fs.writeFileSync(file, `${prompt}\n${call.slice(0, -3)}`);
  let discoveries = 0;
  f.collector.discover = async () => {
    discoveries++;
    return [{ id: "file-session", runtime: "codex", rollout_path: file }];
  };
  await f.collector.poll();
  assert.equal(f.frames.at(-1).category, "processing");
  fs.appendFileSync(file, `${call.slice(-3)}\n`);
  await f.collector.poll();
  assert.equal(f.frames.at(-1).detail, "node");
  assert.equal(discoveries, 1);
  fs.writeFileSync(file, "");
  await f.collector.poll();
  assert.equal(f.frames.at(-1).category, "idle");
  for (const endpoint of f.ext.conns.keys()) f.collector.unbind(endpoint);
  await f.collector.poll();
  assert.equal(discoveries, 1);
});

test("new short activity header preserves optional diagnostic Monitor attribution", () => {
  const f = fixture();
  const endpoint = [...f.ext.conns.keys()][0];
  const monitor = new Monitor({ now: f.now });
  const ticket = monitor.received({
    endpointId: endpoint,
    text: "hello",
    chatId: "same-task",
  });
  monitor.agentActivityRun = (token, at) =>
    f.collector.agentActivityRun(token, at)
      ? monitor.agentRun(endpoint, at)
      : null;
  const session = new RolloutSession(monitor, "diagnostics", f.now());
  session.event({
    timestamp: new Date(f.now()).toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `[Browser] [Activity ${f.token}]\n[Browser] [Extension decision request ${endpoint}/req]`.slice(
            0,
            100,
          ),
        },
      ],
    },
  });
  assert.equal(ticket.run.agentObserved, true);
});

test("classifier exposes fixed categories even for unknown or malicious tool names", () => {
  assert.deepEqual(
    describeTool({ name: "secret-123", params: "credential=VALUE" }),
    { category: "tool" },
  );
  assert.deepEqual(describeTool({ name: "web_search" }), { category: "web" });
  assert.deepEqual(describeTool({ name: "write_stdin" }), {
    category: "waiting",
  });
});

test("multiple task markers in one prompt and malformed records never attribute tools to the first task", async (t) => {
  const f = fixture();
  const other = f.connect("bbbbbbbbbbbb.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  f.emit("response_item", {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `[Browser] [Activity ${f.token}]\n[Browser] [Activity ${other}]`,
      },
    ],
  });
  f.call();
  f.collector.flush();
  assert.equal(f.frames.length, 0);
  f.emit("event_msg", { type: "task_started" });
  f.prompt();
  f.call("valid");
  f.collector.flush();
  assert.equal(f.frames.at(-1).category, "command");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-gap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gap.jsonl");
  fs.writeFileSync(file, "{broken\n");
  f.session.read(file);
  f.collector.flush();
  assert.equal(f.frames.at(-1).category, "idle");
  const count = f.frames.length;
  f.call("unknown-owner");
  f.collector.flush();
  assert.equal(f.frames.length, count);
});

test("Claude discovery is restricted to this Agent project and ignores nested subagent logs", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "activity-claude-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const directory = path.join(tmp, "agent");
  const claudeDirectory = path.join(tmp, "claude");
  fs.mkdirSync(path.join(directory, ".zylos"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, ".zylos/config.json"),
    '{"runtime":"claude"}',
  );
  const project = path.join(
    claudeDirectory,
    "projects",
    fs.realpathSync(directory).replace(/[^a-zA-Z0-9]/g, "-"),
  );
  fs.mkdirSync(path.join(project, "subagents"), { recursive: true });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  fs.writeFileSync(path.join(project, id + ".jsonl"), "");
  fs.writeFileSync(path.join(project, "subagents", id + ".jsonl"), "");
  const collector = new AgentActivity({}, { directory, claudeDirectory });
  const rows = await collector.findSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runtime, "claude");
  assert.equal(rows[0].rollout_path, path.join(project, id + ".jsonl"));
});
