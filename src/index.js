"use strict";
// One process: authenticated extension ingress and private Agent decision HTTP.
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { ExtLane } = require("./lib/ext-lane");
const { AgentLane } = require("./lib/agent-lane");
const { loadKeys, keysFile } = require("./lib/keys");
const { Monitor } = require("./lib/monitor");
const { AgentTrace } = require("./lib/agent-trace");
const { materializeImages } = require("../scripts/attachments");
const { AgentExchange } = require("./lib/agent-exchange");
const { replyCommands } = require("../scripts/reply-route");

const EXT_PORT = Number(process.env.BROWSER_REMOTE_EXT_PORT || 3802);
const AGENT_PORT = Number(process.env.BROWSER_REMOTE_AGENT_PORT || 3803);
const EXT_BIND = "127.0.0.1"; // Caddy reaches it on loopback; nothing else should

const DEFAULT_C4_RECEIVE = path.join(
  os.homedir(),
  "zylos",
  ".claude",
  "skills",
  "comm-bridge",
  "scripts",
  "c4-receive.js",
);
// `browser` is taken by the official zylos-browser capability component and
// `browser-extension` by zylos-browser-channel; this name must match SKILL.md.
const C4_CHANNEL = "browser-remote";
const C4_PRIORITY = "2";
const C4_CONTENT_PREFIX = "[Browser] ";
const C4_STDERR_KEEP = 2000; // enough to identify a failure, not enough to flood the log
const C4_DELIVERY_TIMEOUT_MS = 45_000;

// Resolved per call, not at load: tests point it at a stub mid-run.
function c4ReceivePath() {
  return process.env.ZYLOS_C4_RECEIVE || DEFAULT_C4_RECEIVE;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Hand one side-panel message to C4. The text is passed as a single argv
 * element via spawn() with an args ARRAY -- there is no shell in this path, so
 * quotes, $(...), newlines and semicolons in the owner's message are inert data.
 *
 * Failures are logged loudly at every stage. A message the owner typed and
 * believes was delivered must never vanish quietly.
 *
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
function deliverRequestToC4(
  { keyId, text, chatId, request },
  logFn = log,
  { timeoutMs = C4_DELIVERY_TIMEOUT_MS } = {},
) {
  const script = c4ReceivePath();
  // Generic Agent adapter: operation schemas and browser rules are opaque
  // extension data. Images are materialized on THIS Agent host, never Chrome.
  const payload = JSON.stringify(materializeImages(request.payload));
  const commands = replyCommands(keyId, request.id);
  const content =
    C4_CONTENT_PREFIX +
    `[Extension decision request ${keyId}/${request.id}]\n` +
    "Use the attached extension contract to decide. For actions, pipe the JSON decision into replyCommands.actions. For done/blocked (including ordinary chat), pipe only the final answer text into the matching replyCommands.done/blocked C4 command, not JSON. Do not submit the same final reply through both routes.\n" +
    `replyCommands: ${JSON.stringify(commands)}\n` +
    "Use quoted heredoc delimiters to preserve literal message content. Each command waits for client execution or completion. Actions return the next request and fresh replyCommands in stdout; use the NEW request's commands. End only when finished:true or an explicit stop/disconnect is returned. Do not poll or call browser actions yourself. Allow 125 seconds and enough output tokens for the schema/state JSON.\n" +
    `Owner request: ${JSON.stringify(text)}\nExtension contract and observations:\n${payload}`;
  if (Buffer.byteLength(content) > 100000)
    return Promise.resolve({ ok: false, code: "AGENT_REQUEST_TOO_LARGE" });
  const args = [
    script,
    "--channel",
    C4_CHANNEL,
    "--endpoint",
    keyId,
    "--priority",
    C4_PRIORITY,
    "--json",
    "--no-reply",
    "--content",
    content,
  ];
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const complete = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      logFn(
        `chat: c4-receive spawn threw for ${keyId}: ${err.message} (MESSAGE NOT DELIVERED)`,
      );
      complete({ ok: false, code: "C4_DELIVERY_FAILED" });
      return;
    }
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (c) => {
      if (stderr.length < C4_STDERR_KEEP)
        stderr += c.toString().slice(0, C4_STDERR_KEEP - stderr.length);
    });
    child.stdout.on("data", (c) => {
      if (stdout.length < C4_STDERR_KEEP)
        stdout += c.toString().slice(0, C4_STDERR_KEEP - stdout.length);
    });
    timer = setTimeout(() => {
      logFn(
        `chat: C4 delivery timed out (endpoint ${keyId}, chat ${chatId || "-"}; delivery unknown)`,
      );
      complete({ ok: false, code: "C4_DELIVERY_TIMEOUT" });
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      force.unref();
      child.once("close", () => clearTimeout(force));
    }, timeoutMs);
    child.on("error", (err) => {
      logFn(
        `chat: c4-receive failed to start for ${keyId}: ${err.message} (MESSAGE NOT DELIVERED)`,
      );
      complete({ ok: false, code: "C4_DELIVERY_FAILED" });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        let result;
        try {
          result = JSON.parse(stdout);
        } catch {
          /* cannot confirm intake */
        }
        if (result?.ok === true && result.action === "queued") {
          logFn(
            `chat: queued in C4 (endpoint ${keyId}, chat ${chatId || "-"}, conversation ${result.id})`,
          );
          complete({ ok: true });
        } else if (
          result?.ok === true &&
          ["delivered", "suppressed"].includes(result.action)
        ) {
          logFn(
            `chat: Agent unavailable (endpoint ${keyId}, chat ${chatId || "-"}, action ${result.action})`,
          );
          complete({ ok: false, code: "AGENT_UNAVAILABLE" });
        } else {
          logFn(
            `chat: C4 returned no queue receipt (endpoint ${keyId}, chat ${chatId || "-"})`,
          );
          complete({ ok: false, code: "C4_DELIVERY_UNCONFIRMED" });
        }
        return;
      }
      logFn(
        `chat: c4-receive exited ${code} for ${keyId} (MESSAGE NOT DELIVERED): ${stderr.trim().slice(0, 400) || "<no stderr>"}`,
      );
      complete({ ok: false, code: "C4_DELIVERY_FAILED" });
    });
  });
}

function start({
  extPort = EXT_PORT,
  agentPort = AGENT_PORT,
  onRequest = deliverRequestToC4,
  monitor = process.env.BROWSER_REMOTE_MONITOR === "1",
  monitorFile = process.env.BROWSER_REMOTE_MONITOR_FILE,
  agentMonitorDir = process.env.BROWSER_REMOTE_MONITOR_AGENT_DIR,
  agentTraceOptions,
} = {}) {
  const trace = monitor ? new Monitor({ file: monitorFile }) : null;
  const agentTrace =
    trace && agentMonitorDir
      ? new AgentTrace(trace, {
          directory: agentMonitorDir,
          ...agentTraceOptions,
        }).start()
      : null;
  const ext = new ExtLane({ log });
  const exchange = new AgentExchange(ext);
  const agent = new AgentLane({
    extLane: ext,
    port: agentPort,
    log,
    monitor: trace,
    exchange,
  });
  if (trace) {
    ext.on("connected", (keyId) => trace.connection(keyId, true));
    ext.on("disconnected", (keyId) => trace.connection(keyId, false));
  }

  // Ingress: panel -> relay -> C4 queue. ext-lane has already bounded the text
  // and checked the envelope; nothing here looks at what the owner wrote.
  const intake = (msg, reportStatus) => {
    const ticket =
      msg.request && msg.request.round > 1
        ? trace?.decisionRequested(msg)
        : trace?.received(msg);
    // Ack only C4 intake. No claim about model progress or task completion.
    Promise.resolve()
      .then(() => onRequest(msg))
      .then((result) => {
        trace?.intake(ticket, result);
        if (result?.ok === true) return reportStatus({ state: "queued" });
        const code =
          typeof result?.code === "string"
            ? result.code
            : "C4_DELIVERY_UNCONFIRMED";
        const uncertain = [
          "C4_DELIVERY_TIMEOUT",
          "C4_DELIVERY_UNCONFIRMED",
        ].includes(code);
        reportStatus({
          state: uncertain ? "unknown" : "failed",
          code,
          error: uncertain
            ? "Delivery to the Agent queue could not be confirmed. Check the Agent before retrying."
            : code === "AGENT_UNAVAILABLE"
              ? "The Agent is unavailable; this message was not queued."
              : "Message could not reach the Agent queue. Check Browser Remote and C4.",
        });
      })
      .catch((err) => {
        trace?.intake(ticket, { ok: false, code: "C4_DELIVERY_UNCONFIRMED" });
        log(`chat: unexpected delivery error: ${err.message}`);
        reportStatus({
          state: "unknown",
          code: "C4_DELIVERY_UNCONFIRMED",
          error:
            "Delivery to the Agent queue could not be confirmed. Check the Agent before retrying.",
        });
      });
  };
  ext.on("agent-request", (msg, reportStatus) => {
    if (exchange.ingest(msg)) {
      const ticket = trace?.decisionRequested(msg);
      trace?.intake(ticket, { ok: true });
      if (ticket) {
        ticket.step.title = `状态返回 Agent · 第 ${msg.request.round} 轮`;
        ticket.step.result = "直接返回决策命令，无需重新经过 C4 队列";
      }
      reportStatus({ state: "queued" });
    } else intake(msg, reportStatus);
  });
  const localSteps = new Map();
  ext.on("agent-event", (event) => {
    if (!trace) return;
    const id = `${event.keyId}:${event.id}`;
    if (event.phase === "start") {
      if (localSteps.has(id) || localSteps.size >= 100) return;
      localSteps.set(id, trace.actionStarted(event.keyId, event));
    } else {
      const ticket = localSteps.get(id);
      if (!ticket) return;
      localSteps.delete(id);
      trace.actionEnded(ticket, event.result, event.error);
    }
  });
  const discardSteps = (keyId) => {
    for (const [id, ticket] of localSteps)
      if (id.startsWith(keyId + ":")) {
        trace?.actionEnded(ticket, undefined, { code: "INTERRUPTED" });
        localSteps.delete(id);
      }
  };
  ext.on("agent-turn-end", (event) => {
    discardSteps(event.keyId);
    trace?.extensionEnded(event);
  });
  ext.on("disconnected", (keyId) => {
    discardSteps(keyId);
    trace?.extensionEnded({ keyId, status: "interrupted" });
  });

  return Promise.all([ext.listen(extPort, EXT_BIND), agent.listen()]).then(
    () => {
      log(
        `ext lane    ws://${EXT_BIND}:${extPort}/ext   (public via /browser-remote/ext)`,
      );
      log(`agent lane http://127.0.0.1:${agentPort}      (loopback only)`);
      return {
        ext,
        agent,
        monitor: trace,
        close() {
          agentTrace?.close();
          exchange.close();
          agent.close();
          ext.close();
          trace?.close();
        },
      };
    },
  );
}

// Service entry. This file is the entry point the component spec declares and
// the path PM2 launches, so it stays self-starting; main() is also exported so
// a supervisor can drive startup without spawning a process.
function main() {
  let count = 0;
  try {
    count = Object.keys(loadKeys()).length;
  } catch (err) {
    console.error(`FATAL: cannot read keys (${keysFile()}): ${err.message}`);
    process.exit(1);
  }
  if (count === 0) {
    console.error(
      `WARNING: no extension keys yet (${keysFile()}). Mint one with:  node scripts/key.js new --label <who>`,
    );
  } else {
    log(
      `keys: ${count} loaded from ${process.env.BROWSER_REMOTE_KEY ? "BROWSER_REMOTE_KEY" : keysFile()}`,
    );
  }
  start().then((relay) => {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        log(`${sig}: shutting down`);
        relay.close();
        process.exit(0);
      });
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  start,
  deliverRequestToC4,
  c4ReceivePath,
  DEFAULT_C4_RECEIVE,
  C4_CHANNEL,
  C4_CONTENT_PREFIX,
};
