"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const WebSocket = require("ws");
const { start } = require("../src/index");
const { replyCommands, parseReplyEndpoint } = require("../scripts/reply-route");

const remote = path.resolve(__dirname, "..");
const coreSend =
  process.env.ZYLOS_C4_SEND ||
  path.resolve(remote, "../zylos-core/skills/comm-bridge/scripts/c4-send.js");
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await pause();
  }
  throw new Error("Expected reply event did not arrive");
}
async function run(args, env, input = "") {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("final reply endpoints require an explicit request and terminal status", () => {
  const endpoint = "a".repeat(12);
  assert.deepEqual(parseReplyEndpoint(`${endpoint}|req:r-2|status:blocked`), {
    endpoint,
    id: "r-2",
    status: "blocked",
  });
  for (const value of [
    endpoint,
    `${endpoint}|req:r2`,
    `${endpoint}|req:r2|status:actions`,
    `${endpoint}|req:r2|status:done|req:r3`,
    `${endpoint}|req:$(touch x)|status:done`,
  ]) {
    assert.throws(() => parseReplyEndpoint(value));
  }
  assert.match(
    replyCommands(endpoint, "r2").done,
    /c4-send\.js browser-remote 'aaaaaaaaaaaa\|req:r2\|status:done'/,
  );
  for (const message of ["", " ", "x".repeat(8001)]) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(remote, "scripts/send.js"),
        `${endpoint}|req:r2|status:done`,
        message,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /1–8000/);
  }
});

async function finalReplyScenario(t, useC4) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "br-final-"));
  const oldKey = process.env.BROWSER_REMOTE_KEY;
  process.env.BROWSER_REMOTE_KEY = "cd".repeat(32);
  const relay = await start({
    extPort: 0,
    agentPort: 0,
    onRequest: async () => ({ ok: true }),
  });
  const ws = new WebSocket(
    `ws://127.0.0.1:${relay.ext.server.address().port}/ext`,
    ["zylos-browser-remote.v2", `key.${process.env.BROWSER_REMOTE_KEY}`],
  );
  const frames = [],
    saved = [],
    receipts = new Map();
  let pending = "r1",
    task = "task1";
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw);
    frames.push(frame);
    if (frame.type !== "req") return;
    const { id, decision } = frame.params;
    const signature = JSON.stringify(decision);
    const previous = receipts.get(id);
    const code =
      previous && previous !== signature
        ? "DECISION_CONFLICT"
        : !previous && id !== pending
          ? "STALE_DECISION"
          : null;
    if (code) {
      ws.send(
        JSON.stringify({ type: "error", id: frame.id, code, message: code }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        type: "resp",
        id: frame.id,
        result: { accepted: true, replayed: !!previous },
      }),
    );
    if (!previous) {
      receipts.set(id, signature);
      pending = null;
      saved.push(decision);
      ws.send(
        JSON.stringify({
          type: "agent-turn-end",
          taskId: task,
          status: decision.kind,
          text: decision.text,
        }),
      );
    }
  });
  t.after(() => {
    ws.terminate();
    relay.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.BROWSER_REMOTE_KEY;
    else process.env.BROWSER_REMOTE_KEY = oldKey;
  });
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      version: "fixture",
      capabilities: ["agent-loop-v1"],
    }),
  );
  await waitFor(() => frames.some((f) => f.type === "ready"));
  const endpoint = relay.ext.connectedIds()[0];
  const env = {
    BROWSER_REMOTE_AGENT_URL: `http://127.0.0.1:${relay.agent.server.address().port}`,
    ZYLOS_DIR: tmp,
  };
  if (useC4) {
    const skills = path.join(tmp, ".claude/skills");
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(remote, path.join(skills, "browser-remote"), "dir");
  }
  const send = (id, status, text) => {
    const target = `${endpoint}|req:${id}|status:${status}`;
    return useC4
      ? run([coreSend, "browser-remote", target], env, text)
      : run([path.join(remote, "scripts/send.js"), target, text], env);
  };
  const request = async () => {
    ws.send(
      JSON.stringify({
        type: "agent-request",
        id: pending,
        taskId: task,
        round: 1,
        text: "hello",
        context: "{}",
        payload: {},
      }),
    );
    await waitFor(() =>
      frames.some((f) => f.type === "agent-status" && f.requestId === pending),
    );
  };
  await request();
  const answer = "## 已完成\n\n你好！保留 $(literal)、`code` 和 \\n。";
  const result = await send("r1", "done", answer);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /"finished":true/);
  assert.deepEqual(saved, [{ kind: "done", text: answer }]);
  assert.equal((await send("r1", "done", answer)).code, 0);
  assert.equal(saved.length, 1, "retry must not display twice");
  const conflict = await send("r1", "done", "different");
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stdout, /DECISION_CONFLICT/);
  pending = "r2";
  task = "task2";
  await request();
  const stale = await send("r1", "done", answer);
  assert.notEqual(stale.code, 0);
  assert.match(stale.stdout, /STALE_DECISION/);
  assert.equal(saved.length, 1, "stale reply must not close the current task");
  const blocked = await send("r2", "blocked", "需要你登录");
  assert.equal(blocked.code, 0, blocked.stdout + blocked.stderr);
  assert.equal(saved[1].kind, "blocked");
  if (useC4) {
    // Read with Core's own database dependency, in a temporary ZYLOS_DIR only.
    const query = `import {getDb,close} from ${JSON.stringify(new URL("file://" + path.join(path.dirname(coreSend), "c4-db.js")).href)}; const rows=getDb().prepare("SELECT channel,endpoint_id,content FROM conversations WHERE direction='out' ORDER BY id").all(); console.log(JSON.stringify(rows)); close();`;
    const audit = await run(["--input-type=module", "-e", query], env);
    assert.equal(audit.code, 0, audit.stderr);
    const rows = JSON.parse(audit.stdout.trim());
    assert.equal(rows[0].channel, "browser-remote");
    assert.equal(rows[0].endpoint_id, `${endpoint}|req:r1|status:done`);
    assert.equal(rows[0].content, answer);
    assert.equal(
      rows.length,
      5,
      "C4 audits each send attempt, including failed/duplicate attempts",
    );
  }
}

test("send.js correlates final replies, duplicates, conflicts, stale requests and blocked status", (t) =>
  finalReplyScenario(t, false));
test(
  "real Core c4-send records final text and dispatches through the channel adapter",
  {
    skip:
      !fs.existsSync(coreSend) &&
      "Core checkout unavailable; set ZYLOS_C4_SEND",
  },
  (t) => finalReplyScenario(t, true),
);
