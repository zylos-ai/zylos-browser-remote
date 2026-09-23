"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { interruptAgent } = require("../src/lib/agent-interrupt");

test("real C4 dispatcher delivers Escape to a disposable tmux runtime and expires undelivered controls", async (t) => {
  const core = path.resolve(
    __dirname,
    "../../zylos-core/skills/comm-bridge/scripts",
  );
  const tmux = spawnSync("which", ["tmux"], {
    encoding: "utf8",
  }).stdout?.trim();
  if (!fs.existsSync(path.join(core, "c4-control.js")) || !tmux) {
    t.skip("Sibling Core checkout and tmux required");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-core-stop-"));
  const socket = `br-stop-${process.pid}`;
  const previous = { ZYLOS_DIR: process.env.ZYLOS_DIR, PATH: process.env.PATH };
  let dispatcher;
  t.after(async () => {
    if (
      dispatcher &&
      dispatcher.exitCode === null &&
      dispatcher.signalCode === null
    ) {
      const closed = once(dispatcher, "close");
      dispatcher.kill("SIGKILL");
      await closed;
    }
    spawnSync(tmux, ["-L", socket, "kill-server"], { stdio: "ignore" });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, ".zylos"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, ".zylos/config.json"), '{"runtime":"codex"}');
  // All tmux calls from Core go to a private socket, never the live codex-main.
  fs.writeFileSync(
    path.join(dir, "bin/tmux"),
    `#!${process.execPath}
require('child_process').execFileSync(${JSON.stringify(tmux)}, ['-L',${JSON.stringify(socket)},...process.argv.slice(2)], {stdio:'inherit'});
`,
    { mode: 0o755 },
  );
  const input = path.join(dir, "input");
  const ready = path.join(dir, "ready");
  const terminal = path.join(dir, "terminal.cjs");
  fs.writeFileSync(
    terminal,
    `
const fs=require('fs');process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(input)},data));
fs.writeFileSync(${JSON.stringify(ready)},'ready');
`,
  );
  execFileSync(tmux, [
    "-L",
    socket,
    "new-session",
    "-d",
    "-s",
    "codex-main",
    process.execPath,
    terminal,
  ]);
  const wait = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("Isolated runtime did not receive input");
  };
  await wait(() => fs.existsSync(ready));
  process.env.ZYLOS_DIR = dir;
  process.env.PATH = path.join(dir, "bin") + path.delimiter + previous.PATH;
  // Provision the fixture before starting two clients. Otherwise the dispatcher
  // and the first control command can race to create/migrate a brand-new DB.
  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const db = await import(process.argv[1]); db.getDb(); db.close();",
    path.join(core, "c4-db.js"),
  ]);
  let dispatcherLog = "";
  dispatcher = spawn(process.execPath, [path.join(core, "c4-dispatcher.js")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [dispatcher.stdout, dispatcher.stderr])
    stream.on("data", (chunk) => {
      dispatcherLog = (dispatcherLog + chunk).slice(-8000);
    });
  const event = { endpointId: "isolated-browser", taskId: "isolated-task" };
  const options = { script: path.join(core, "c4-control.js"), pollMs: 50 };
  assert.deepEqual(
    await interruptAgent(event, () => {}, options),
    { ok: true },
    dispatcherLog,
  );
  await wait(() => fs.existsSync(input));
  assert.equal(
    fs.readFileSync(input).toString("hex"),
    "1b",
    "one Escape, with no pasted text or Enter",
  );
  const closed = once(dispatcher, "close");
  dispatcher.kill("SIGKILL");
  await closed;
  assert.equal(
    (await interruptAgent(event, () => {}, { ...options, deadlineSeconds: 1 }))
      .ok,
    false,
  );
  assert.equal(
    fs.readFileSync(input).toString("hex"),
    "1b",
    "expired controls do not deliver a second key",
  );
});
