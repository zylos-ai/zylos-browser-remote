import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  c4ControlPath,
  readSessionMode,
  c4ControlSupportsGroup,
  readGroupRun,
  parseJsonResult,
  C4_CHANNEL,
} from "./c4.js";
import { sessionGroupFromEndpoint } from "./session-group.js";
const run = promisify(execFile);

const INTERRUPT_CAPABILITY = "agent-interrupt-v1";

// Core codes meaning "the target session is not running": nothing was queued.
const NOT_RUNNING = ["TARGET_NOT_RUNNING", "TARGET_MISMATCH", "TARGET_NOT_READY", "STALE_TARGET"];

// Full Core name of the browser connection's own group (namespace included),
// when the relay has no record of the task (for example after a restart).
async function browserGroupFullName(endpointId, script) {
  try {
    const name = sessionGroupFromEndpoint(endpointId);
    const { stdout } = await run(process.execPath,
      [path.join(path.dirname(script), "c4-db.js"), "session-group", C4_CHANNEL, "--session-group", name, "--json"],
      { timeout: 3000, maxBuffer: 4000, killSignal: "SIGKILL" });
    // Core prints { ok: true, data: "<namespace>:<name>" }.
    const parsed = JSON.parse(stdout.trim());
    const value = parsed?.ok === true ? parsed.data : parsed;
    return typeof value === "string" && value.endsWith(`:${name}`) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The group the Escape must target, or null when Core needs none (no
 * session_mode: the pre-multi-session behaviour, unchanged).
 * Resolves { args } or { fail: { code, why } }.
 */
async function stopTarget(event, script, route) {
  const mode = readSessionMode();
  if (!mode.present) return { args: [] };
  if (!(await c4ControlSupportsGroup(script)))
    return { fail: { code: "AGENT_INTERRUPT_UNSUPPORTED", why: "Core config has session_mode but c4-control does not accept --group" } };
  if (mode.mode !== "multi") return { args: ["--group", "origin"] }; // single mode after migration
  const group = route?.group || (await browserGroupFullName(event.endpointId, script));
  if (!group) return { fail: { code: "AGENT_INTERRUPT_NO_TARGET", why: "no Core session is recorded for this task" } };
  const ready = readGroupRun(group);
  if (!ready) return { fail: { code: "AGENT_SESSION_NOT_RUNNING", why: `session ${group} is not running (no READY identity)` }, group };
  return { args: ["--group", group, "--target-run", ready.runId, "--json"], group };
}

// Stop the CURRENT turn of the session that owns the task, as requested by the
// owner. Without multi-session Core, C4 selects the single active session.
// A done receipt means the key was delivered, not that every subprocess exited.
async function interruptAgent(
  event,
  log = () => {},
  { script = c4ControlPath(), deadlineSeconds = 5, pollMs = 200, route } = {},
) {
  const call = (args) =>
    run(process.execPath, [script, ...args], {
      timeout: 1500,
      maxBuffer: 4000,
      killSignal: "SIGKILL",
    });
  const target = await stopTarget(event, script, route);
  const where = target.group ? ` in session ${target.group}` : "";
  if (target.fail) {
    // Nothing was queued, so there is nothing to wait for.
    log(`stop[${event.endpointId}]: interrupt NOT sent (task ${event.taskId}): ${target.fail.why}`);
    return { ok: false, code: target.fail.code };
  }
  // Keep waiting beyond the enqueue timeout + queue expiry before releasing the
  // client's send button. Never leave a minutes-old Escape queued for a new turn.
  const deadline = Date.now() + 1500 + deadlineSeconds * 1000 + 500;
  let controlId;
  let reason = "deadline passed before delivery";
  try {
    let stdout;
    try {
      ({ stdout } = await call([
        "enqueue",
        "--content",
        "[KEYSTROKE]Escape",
        "--priority",
        "0",
        "--bypass-state",
        "--no-ack-suffix",
        "--ack-deadline",
        String(deadlineSeconds),
        ...target.args,
      ]));
    } catch (err) {
      const rejected = parseJsonResult(err.stdout);
      const code = rejected?.ok === false ? rejected.error?.code : /^Error \[([A-Z_]+)\]/m.exec(String(err.stderr || ""))?.[1];
      if (code && NOT_RUNNING.includes(code)) {
        log(`stop[${event.endpointId}]: interrupt NOT sent (task ${event.taskId}): ${target.group ? `session ${target.group}` : "the session"} is not running (${code})`);
        return { ok: false, code: "AGENT_SESSION_NOT_RUNNING" };
      }
      if (code) {
        log(`stop[${event.endpointId}]: interrupt rejected by Core${where} (task ${event.taskId}): ${code}`);
        return { ok: false, code: "AGENT_INTERRUPT_REJECTED" };
      }
      reason = err.killed ? "c4-control enqueue timed out" : `c4-control enqueue failed (exit ${err.code ?? "?"})`;
      throw err;
    }
    const json = parseJsonResult(stdout);
    controlId = json ? (json.ok === true && Number.isSafeInteger(json.data?.id) ? String(json.data.id) : undefined)
      : stdout.match(/^OK: enqueued control (\d+)$/m)?.[1];
    if (!controlId) {
      reason = "c4-control returned no enqueue receipt";
      throw new Error(reason);
    }
    while (Date.now() < deadline) {
      const { stdout: status } = await call(["get", "--id", controlId]);
      if (/^status=done$/m.test(status)) {
        log(
          `stop[${event.endpointId}]: interrupt key delivered${where} (task ${event.taskId}, control ${controlId})`,
        );
        return { ok: true };
      }
      const final = /^status=(failed|timeout|superseded)$/m.exec(status)?.[1];
      if (final) {
        reason = `control ${controlId} ended ${final}`;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (err) {
    if (controlId && reason === "deadline passed before delivery") reason = `status check failed: ${err.message}`;
    // Do not retry an uncertain key delivery: a second Escape could affect a
    // subsequent turn. The queue's short deadline bounds any pending control.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, deadline - Date.now())),
    );
  }
  log(
    `stop[${event.endpointId}]: interrupt not confirmed${where} (task ${event.taskId}): ${reason}`,
  );
  return { ok: false, code: "AGENT_INTERRUPT_UNCONFIRMED" };
}

export { INTERRUPT_CAPABILITY, c4ControlPath, interruptAgent, stopTarget };
