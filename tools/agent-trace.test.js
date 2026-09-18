"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Monitor, MAX_STEPS } = require("../relay/monitor");
const {
  AgentTrace,
  RolloutSession,
  inputSummary,
  outputSummary,
} = require("../relay/agent-trace");
const { inputDetails, MAX_INPUT_BYTES } = require("../relay/monitor-input");
const endpoint = "a".repeat(12);
const event = (at, type, payload) => ({
  timestamp: new Date(at).toISOString(),
  type,
  payload,
});
const prompt = (at, key = endpoint) =>
  event(at, "response_item", {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `[Browser] [Extension decision request ${key}/request-1] Read example`,
      },
    ],
  });
const call = (at, id = "c1", name = "exec_command") =>
  event(at, "response_item", {
    type: "function_call",
    name,
    call_id: id,
    arguments: JSON.stringify({
      cmd: "node decision.js --token private-token",
      token: "private-token",
    }),
  });
const output = (
  at,
  id = "c1",
  text = "Process exited with code 0\nOutput: private-output",
) =>
  event(at, "response_item", {
    type: "function_call_output",
    call_id: id,
    output: text,
  });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-agent-trace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const monitor = new Monitor({ now: () => 1000 });
  t.after(() => monitor.close());
  const { run } = monitor.received({ keyId: endpoint, text: "Read example" });
  return {
    dir,
    monitor,
    run,
    session: new RolloutSession(monitor, "zylos-session", 1000),
  };
}

test("extension decision header correlates even in the 100-character C4 preview without a reply suffix", (t) => {
  const { run, session } = fixture(t);
  const header = `[Browser] [Extension decision request ${endpoint}/11111111-1111-4111-8111-111111111111]\n`;
  assert.ok(header.length < 100);
  session.event(
    event(1200, "response_item", {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: header + "[C4] TRUNCATED — read complete message file",
        },
      ],
    }),
  );
  session.event(call(1300));
  session.event(output(1400));
  assert.equal(
    run.steps.find((step) => step.kind === "agent").status,
    "success",
  );
  assert.equal(run.agentObserved, true);
});

test("Agent and browser calls are counted separately, correlated by route, deduplicated and timed", (t) => {
  const { monitor, run, session } = fixture(t);
  session.event(
    event(1100, "event_msg", { type: "task_started", turn_id: "turn-1" }),
  );
  session.event(
    event(1101, "response_item", {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>context</environment_context>",
        },
      ],
    }),
  );
  session.event(prompt(1200));
  session.event(call(1300));
  session.event(call(1300));
  const rpc = monitor.actionStarted(endpoint, {
    method: "observe",
    params: {},
  });
  monitor.actionEnded(rpc, {
    screenshot: { data: "private-image" },
    text: "page",
  });
  assert.equal(run.steps.find((s) => s.kind === "agent").status, "running");
  session.event(output(1450));
  const step = run.steps.find((s) => s.kind === "agent");
  assert.equal(step.title, "exec_command");
  assert.equal(step.status, "success");
  assert.equal(step.durationMs, 150);
  assert.deepEqual(run.toolCounts, {
    browser: [{ name: "observe", count: 1 }],
    agent: [{ name: "exec_command", count: 1 }],
  });
  session.event(call(1500, "c2", "view_image"));
  // A reply acknowledgement can arrive before the collector reads a tool result.
  monitor.extensionEnded({ keyId: endpoint, status: "done", text: "done" });
  session.event(
    output(
      1650,
      "c2",
      JSON.stringify([{ type: "image", data: "private-image" }]),
    ),
  );
  assert.equal(run.status, "delivered");
  assert.equal(run.steps.find((s) => s.callId === "c2").status, "returned");
  const saved = JSON.stringify(run);
  for (const secret of ["private-token", "private-output", "private-image"])
    assert(!saved.includes(secret));
  assert(step.params.includes("decision.js"));
  assert.equal(
    JSON.parse(step.invocation.json).cmd,
    "node decision.js --token [已隐藏]",
  );
  const received = run.steps.find((s) => s.kind === "agent-input");
  assert(
    JSON.parse(received.invocation.json).includes(
      "[Extension decision request",
    ),
  );
});

test("command details preserve actual arguments and redact common credential forms before persistence", () => {
  const args = {
    cmd: "node decision.js\nnode decision.js",
    workdir: "/runtime",
    yield_time_ms: 1000,
    max_output_tokens: 2000,
  };
  const captured = inputDetails(JSON.stringify(args));
  assert.deepEqual(JSON.parse(captured.json), args);
  assert.equal(captured.redacted, false);
  assert.equal(captured.truncated, false);
  const secretArgs = {
    cmd:
      'API_KEY=env-secret node app.js --token "flag-secret" --key=key-secret ' +
      '-H "Authorization: Bearer bearer-secret" -H "Cookie: session=cookie-secret" ' +
      '--data \'{"password":"json-secret"}\' https://user:url-secret@example.com/?token=query-secret&q=visible',
    env: { OPENAI_API_KEY: "env-object-secret" },
    headers: { authorization: "header-secret" },
    access_token: "object-secret",
    max_output_tokens: 2000,
  };
  const before = JSON.stringify(secretArgs),
    secretResult = inputDetails(secretArgs);
  for (const value of [
    "env-secret",
    "flag-secret",
    "key-secret",
    "bearer-secret",
    "cookie-secret",
    "json-secret",
    "url-secret",
    "query-secret",
    "env-object-secret",
    "header-secret",
    "object-secret",
  ])
    assert(!secretResult.json.includes(value), value);
  assert(secretResult.redacted);
  assert(secretResult.json.includes("visible"));
  assert.equal(JSON.parse(secretResult.json).max_output_tokens, 2000);
  assert.equal(
    JSON.stringify(secretArgs),
    before,
    "only display copies are redacted",
  );
  const image = inputDetails({
    cmd: "node test.js",
    data: "data:image/png;base64," + "a".repeat(2048),
  });
  assert(!image.json.includes("a".repeat(256)));
  const huge = inputDetails({ cmd: "echo 中文\n".repeat(10000) });
  assert(huge.truncated);
  assert(Buffer.byteLength(huge.json) <= MAX_INPUT_BYTES);
  assert.doesNotThrow(() => JSON.parse(huge.json));
  assert.equal(inputDetails(undefined).json, "null");
});

test("unrelated, unobserved and mixed prompts do not silently attach tools to a browser question", (t) => {
  const { run, session } = fixture(t);
  session.event(prompt(999));
  session.event(call(1050)); // before capture began
  session.event(prompt(1100, "b".repeat(12)));
  session.event(call(1150)); // no matching browser
  session.event(
    event(1200, "event_msg", { type: "task_started", turn_id: "browser-turn" }),
  );
  session.event(prompt(1250));
  session.event(call(1300));
  session.event(
    event(1301, "response_item", {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "<skill>injected instructions</skill>" },
      ],
    }),
  );
  session.event(call(1350, "c2"));
  session.event(
    event(1400, "response_item", {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "A question from another channel" },
      ],
    }),
  );
  session.event(call(1500, "unrelated"));
  session.event(output(1550));
  assert.equal(run.agentMixed, true);
  assert.deepEqual(
    run.steps.filter((s) => s.kind === "agent").map((s) => s.callId),
    ["c1", "c2"],
  );
  assert.equal(run.steps.find((s) => s.callId === "c1").status, "success");
  session.event(
    event(1600, "event_msg", {
      type: "task_complete",
      turn_id: "browser-turn",
    }),
  );
  assert.equal(run.steps.find((s) => s.callId === "c2").status, "unknown");
});

test("failure, asynchronous process and custom/tool-search return states preserve their meaning", (t) => {
  const { run, session } = fixture(t);
  session.event(prompt(1100));
  session.event(call(1200));
  session.event(
    output(1300, "c1", "Process exited with code 7\nOutput: sensitive failure"),
  );
  assert.equal(run.steps.at(-1).status, "error");
  assert.equal(run.steps.at(-1).error, "退出码 7");
  session.event(
    event(1400, "response_item", {
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "patch",
      input: "secret patch",
    }),
  );
  session.event(
    event(1500, "response_item", {
      type: "custom_tool_call_output",
      call_id: "patch",
      output: { isError: true, content: "secret" },
    }),
  );
  assert.equal(run.steps.at(-1).status, "error");
  session.event(
    event(1600, "response_item", {
      type: "tool_search_call",
      call_id: "search",
      arguments: { query: "secret search" },
    }),
  );
  session.event(
    event(1700, "response_item", {
      type: "tool_search_output",
      call_id: "search",
      tools: ["tool"],
    }),
  );
  assert.equal(run.steps.at(-1).title, "tool_search");
  assert.equal(run.steps.at(-1).status, "returned");
  const running = outputSummary({
    output: "Process running with session ID 123",
  });
  assert.equal(running.status, "returned");
  assert(running.result.includes("仍在运行"));
  assert(!JSON.stringify(run).includes("secret"));
  assert(
    !inputSummary("exec_command", {
      cmd: "TOKEN=secret curl https://secret:password@x",
    }).includes("secret"),
  );
});

test("incremental JSONL reader handles partial UTF-8 lines, duplicates, rotation and old history", (t) => {
  const { dir, run, session } = fixture(t);
  const file = path.join(dir, "rollout.jsonl");
  const line = (e) => JSON.stringify(e) + "\n";
  fs.writeFileSync(
    file,
    line(prompt(800)) + line(call(900)) + line(prompt(1100)),
  );
  session.read(file);
  const pending = Buffer.from(
    line({
      ...call(1200),
      payload: {
        ...call(1200).payload,
        arguments: JSON.stringify({ cmd: "node decision.js 中文" }),
      },
    }),
  );
  const split = pending.indexOf(Buffer.from("中")) + 1;
  fs.appendFileSync(file, pending.subarray(0, split));
  session.read(file);
  assert.equal(run.steps.filter((s) => s.kind === "agent").length, 0);
  fs.appendFileSync(file, pending.subarray(split));
  session.read(file);
  session.read(file);
  assert.equal(run.steps.filter((s) => s.kind === "agent").length, 1);
  fs.appendFileSync(file, "broken-json\n" + line(output(1500)));
  session.read(file);
  assert.equal(run.steps.at(-1).durationMs, 300);
  fs.renameSync(file, file + ".old");
  fs.writeFileSync(
    file,
    line(prompt(1600)) + line(call(1700, "after-rotation")),
  );
  session.read(file);
  assert.equal(run.steps.at(-1).callId, "after-rotation");
});

test("distribution counts survive timeline truncation and persistence", (t) => {
  const { dir, monitor, run } = fixture(t);
  monitor.file = path.join(dir, "monitor.json");
  for (let i = 0; i < MAX_STEPS + 10; i++) {
    const ticket = monitor.agentStarted(run, {
      name: "exec_command",
      at: 1000 + i,
    });
    monitor.agentEnded(ticket, { status: "returned" }, 1001 + i);
  }
  assert.equal(run.steps.length, MAX_STEPS);
  assert.equal(run.toolCounts.agent[0].count, MAX_STEPS + 10);
  monitor.close();
  const restored = new Monitor({ file: monitor.file });
  assert.equal(restored.runs[0].toolCounts.agent[0].count, MAX_STEPS + 10);
  restored.close();
});

test("collector discovers only Zylos CLI sessions and degrades independently of browser recording", async (t) => {
  const { dir, monitor } = fixture(t);
  fs.mkdirSync(path.join(dir, ".zylos"));
  fs.writeFileSync(
    path.join(dir, ".zylos/config.json"),
    JSON.stringify({ runtime: "codex" }),
  );
  const db = path.join(dir, "state_5.sqlite");
  const cwd = fs.realpathSync(dir).replace(/'/g, "''");
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER);
    INSERT INTO threads VALUES('wanted','${cwd}/rollout.jsonl','${cwd}','cli',0,1),
    ('codex-app','elsewhere','${cwd}','vscode',0,4),('foreign','elsewhere','/different-project','cli',0,3),
    ('archived','elsewhere','${cwd}','cli',1,2);`,
  ]);
  const trace = new AgentTrace(monitor, {
    directory: dir,
    codexDirectory: dir,
  });
  assert.deepEqual(
    (await trace.findSessions()).map((row) => row.id),
    ["wanted"],
  );
  fs.writeFileSync(
    path.join(dir, "rollout.jsonl"),
    [prompt(1100), call(1200), output(1300)]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  await trace.poll();
  await trace.poll();
  assert.equal(monitor.agentSource.status, "connected");
  assert.equal(monitor.runs[0].toolCounts.agent[0].count, 1);
  fs.writeFileSync(
    path.join(dir, ".zylos/config.json"),
    JSON.stringify({ runtime: "claude" }),
  );
  await trace.poll();
  assert.equal(monitor.agentSource.status, "unavailable");
  const browser = monitor.actionStarted(endpoint, { method: "tabs" });
  monitor.actionEnded(browser, { tabs: [] });
  assert.equal(browser.step.status, "success");
  trace.close();
});
