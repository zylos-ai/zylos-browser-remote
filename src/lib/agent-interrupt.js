"use strict";
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

const INTERRUPT_CAPABILITY = "agent-interrupt-v1";

function c4ControlPath() {
  if (process.env.ZYLOS_C4_CONTROL) return process.env.ZYLOS_C4_CONTROL;
  if (process.env.ZYLOS_C4_RECEIVE)
    return path.join(
      path.dirname(process.env.ZYLOS_C4_RECEIVE),
      "c4-control.js",
    );
  return path.join(
    process.env.ZYLOS_DIR || path.join(os.homedir(), "zylos"),
    ".claude",
    "skills",
    "comm-bridge",
    "scripts",
    "c4-control.js",
  );
}

// Stop the runtime's CURRENT turn, as requested by the owner. C4 selects the
// active Claude/Codex tmux session. This is not task-scoped runtime cancellation.
// A done receipt means the key was delivered, not that every subprocess exited.
async function interruptAgent(
  event,
  log = () => {},
  { script = c4ControlPath(), deadlineSeconds = 5, pollMs = 200 } = {},
) {
  const call = (args) =>
    run(process.execPath, [script, ...args], {
      timeout: 1500,
      maxBuffer: 4000,
      killSignal: "SIGKILL",
    });
  // Keep waiting beyond the enqueue timeout + queue expiry before releasing the
  // client's send button. Never leave a minutes-old Escape queued for a new turn.
  const deadline = Date.now() + 1500 + deadlineSeconds * 1000 + 500;
  let controlId;
  try {
    const { stdout } = await call([
      "enqueue",
      "--content",
      "[KEYSTROKE]Escape",
      "--priority",
      "0",
      "--bypass-state",
      "--no-ack-suffix",
      "--ack-deadline",
      String(deadlineSeconds),
    ]);
    controlId = stdout.match(/^OK: enqueued control (\d+)$/m)?.[1];
    if (!controlId) throw new Error("Unconfirmed control intake");
    while (Date.now() < deadline) {
      const { stdout: status } = await call(["get", "--id", controlId]);
      if (/^status=done$/m.test(status)) {
        log(
          `stop[${event.endpointId}]: interrupt key delivered (task ${event.taskId}, control ${controlId})`,
        );
        return { ok: true };
      }
      if (/^status=(failed|timeout|superseded)$/m.test(status)) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch {
    // Do not retry an uncertain key delivery: a second Escape could affect a
    // subsequent turn. The queue's short deadline bounds any pending control.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, deadline - Date.now())),
    );
  }
  log(
    `stop[${event.endpointId}]: interrupt not confirmed (task ${event.taskId})`,
  );
  return { ok: false, code: "AGENT_INTERRUPT_UNCONFIRMED" };
}

module.exports = { INTERRUPT_CAPABILITY, c4ControlPath, interruptAgent };
