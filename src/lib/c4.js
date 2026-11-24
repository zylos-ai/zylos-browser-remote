// Core (comm-bridge) compatibility helpers. Everything here is read fresh on
// every call: the owner can upgrade Core or switch session mode while the
// relay runs, and an older Core must see exactly the arguments it saw before.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

// `browser` is taken by the official zylos-browser capability component and
// `browser-extension` by zylos-browser-channel; this name must match SKILL.md.
const C4_CHANNEL = "browser-remote";

function zylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), "zylos");
}

// ZYLOS_C4_RECEIVE stays as the test/deployment override the relay always had.
function getC4ReceivePath() {
  return process.env.ZYLOS_C4_RECEIVE ||
    path.join(zylosDir(), ".claude/skills/comm-bridge/scripts/c4-receive.js");
}

function c4ControlPath() {
  if (process.env.ZYLOS_C4_CONTROL) return process.env.ZYLOS_C4_CONTROL;
  return path.join(path.dirname(getC4ReceivePath()), "c4-control.js");
}

/** Whether the installed c4-receive declares `name` in its options manifest. */
function c4ReceiveSupportsOption(name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(getC4ReceivePath()), "c4-receive-options.json"), "utf8"));
    return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === "object"
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

/**
 * Core's session mode from `<ZYLOS_DIR>/.zylos/config.json`. `present` is true
 * only when the key exists (multi mode, or single mode after migration); then
 * Core requires every control to name its target group. An unreadable config
 * counts as absent, which is how the relay behaved before multi-session.
 */
function readSessionMode(dir = zylosDir()) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".zylos/config.json"), "utf8"));
    if (config && typeof config === "object" && Object.hasOwn(config, "session_mode"))
      return { present: true, mode: config.session_mode };
  } catch { /* absent */ }
  return { present: false, mode: null };
}

const isMulti = (dir) => readSessionMode(dir).mode === "multi";

/** Whether the installed c4-control accepts `enqueue --group` (from its usage text). */
function c4ControlSupportsGroup(script = c4ControlPath()) {
  return new Promise((resolve) => {
    try {
      execFile(process.execPath, [script, "--help"], { timeout: 1500, maxBuffer: 16000, killSignal: "SIGKILL" },
        (err, stdout, stderr) => resolve(!err?.killed && /--group\b/.test(`${stdout}\n${stderr}`)));
    } catch {
      resolve(false);
    }
  });
}

/**
 * The READY identity Core publishes for a running group (runId, sessionId), or
 * null. A stale file is possible; Core rejects a stale --target-run itself.
 */
function readGroupRun(group, dir = zylosDir()) {
  if (typeof group !== "string" || !group || group.includes("/") || group.startsWith(".")) return null;
  try {
    const value = JSON.parse(fs.readFileSync(
      path.join(dir, "activity-monitor", "session-groups", group, "current-session.json"), "utf8"));
    return typeof value?.runId === "string" && value.runId
      ? { runId: value.runId, ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}) }
      : null;
  } catch {
    return null;
  }
}

// error.persisted lists rows Core already stored for this message.
function classifyRejection(error) {
  const persisted = error?.persisted;
  if (!Array.isArray(persisted)) return "uncertain";
  return persisted.length > 0 ? "committed" : "not_stored";
}

/** Parse Core's `--json` stdout; null when it is not a Core result. */
function parseJsonResult(stdout) {
  try {
    const value = JSON.parse(String(stdout || "").trim().split("\n").at(-1));
    return value && typeof value === "object" && typeof value.ok === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Enqueue a control into a named group (multi-session Core only).
 * Resolves { ok:true, id } or { ok:false, code, detail }; never throws.
 */
function enqueueControl({ script = c4ControlPath(), content, group, targetRun, ackDeadline, priority = "3",
  bypassState = false, timeoutMs = 5000 }) {
  const args = [script, "enqueue", "--content", content, "--priority", String(priority),
    ...(bypassState ? ["--bypass-state"] : []), "--no-ack-suffix", "--ack-deadline", String(ackDeadline),
    "--group", group, ...(targetRun ? ["--target-run", targetRun] : []), "--json"];
  return new Promise((resolve) => {
    try {
      execFile(process.execPath, args, { timeout: timeoutMs, maxBuffer: 64000, killSignal: "SIGKILL" },
        (err, stdout) => {
          const result = parseJsonResult(stdout);
          if (result?.ok === true && Number.isSafeInteger(result.data?.id)) return resolve({ ok: true, id: result.data.id });
          if (result?.ok === false) return resolve({ ok: false, code: result.error?.code || "CONTROL_REJECTED",
            stored: classifyRejection(result.error) });
          resolve({ ok: false, code: err?.killed ? "CONTROL_TIMEOUT" : err ? "CONTROL_FAILED" : "CONTROL_UNCONFIRMED", stored: "uncertain" });
        });
    } catch {
      resolve({ ok: false, code: "CONTROL_FAILED", stored: "not_stored" });
    }
  });
}

export {
  C4_CHANNEL, zylosDir, getC4ReceivePath, c4ControlPath, c4ReceiveSupportsOption, readSessionMode, isMulti,
  c4ControlSupportsGroup, readGroupRun, classifyRejection, parseJsonResult, enqueueControl,
};
