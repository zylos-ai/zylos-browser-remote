/*
 * Extension lane -- :3802, the ONLY publicly reachable surface.
 *
 *   owner's Chrome --[MV3 ext]--> wss://<domain>/browser-remote/ext
 *                                   platform edge (TLS, Host -> localhost)
 *                                 caddy :3800 handle /browser-remote/* (strips prefix)
 *                                 THIS LANE  ws://127.0.0.1:3802/ext
 *
 * Caddy's strip_prefix forwards EVERY path on this port, so this lane exposes
 * exactly one: /ext, key-authed. Everything else is refused. Whoever learns the
 * public URL can, at most and only with a key, offer to BE a browser. Driving
 * one happens on the agent lane (:3803), which is loopback-only and never routed.
 *
 * This lane is a pipe. It does not know what a browser command is, what tabs
 * exist, or which methods are allowed -- all of that lives in the extension,
 * which treats this relay as untrusted and re-checks everything itself. What
 * the lane does own: browser endpoint -> connection mapping, request/response correlation,
 * heartbeat, and bounding the chat envelope.
 */

import http from "http";
import { createHash } from "node:crypto";
import { EventEmitter } from "events";
import { controlLossReceipt } from "./control-loss.js";
import { WebSocketServer } from "ws";
import { verifyKey, loadKeys } from "./keys.js";
import { ATTACHMENT_CAPABILITY } from "../../scripts/attachments.js";
import { INTERRUPT_CAPABILITY } from "./agent-interrupt.js";
import {
  AGENT_MESSAGE_CAPABILITY,
  STEER_CAPABILITY,
  normalizeAgentRequest,
  normalizeAgentInput,
  messageText,
} from "./agent-message.js";

// `ws.close()` can throw when the socket is already torn down. Every call site
// below runs inside a `message`/`connection` handler, where a throw escapes into
// the ws emitter and takes the relay process with it -- including the supersede
// path, which closes a DIFFERENT (older, possibly half-dead) socket than the one
// being handled. Match the guarded style already used by `_beat()`/`close()`.
function safeClose(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    /* noop */
  }
}

const SUBPROTOCOL = "zylos-browser-remote.v3";
const LEGACY_SUBPROTOCOL = "zylos-browser-remote.v2";
import {
  BROWSER_ID_RE,
  ENDPOINT_RE,
  INSTANCE_CAPABILITY,
} from "./endpoint.js";
const HANDSHAKE_MS = 10000;
const MAX_CONNECTIONS_PER_KEY = 32;
const KEY_PROTO_PREFIX = "key.";
const EXT_PATH = "/ext";
const HEARTBEAT_MS = 17_000; // app-level: a proxy may swallow raw ping frames
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;

// Side-panel chat. The owner's message is opaque data: never parsed, matched or
// rewritten here -- it only has to be bounded, so a runaway panel cannot push an
// unbounded argv at c4-receive. Over the cap the frame is REFUSED and said so,
// never silently shortened: half an instruction is worse than no instruction.
const MAX_CHAT_TEXT = 8000;
// Sent by the extension in `error` frames when it did not supply a code itself.
const DEFAULT_ERROR_CODE = "EXT_ERROR";
const RESUME_CAPABILITY = "task-resume-v1";
const RECOVERY_MS = 120000;

/**
 * Emits:
 *   'connected'    (endpointId, {keyId, browserId, label, version, capabilities})
 *   'disconnected' (endpointId, code)
 *   'agent-request' ({endpointId, keyId, browserId, label, text, request})
 */
class ExtLane extends EventEmitter {
  constructor({ log = () => {}, loadKeys: loader = loadKeys, recoveryMs = RECOVERY_MS } = {}) {
    super();
    this.log = log;
    this.loadKeys = loader;
    this.recoveryMs = Math.min(RECOVERY_MS, Math.max(1, recoveryMs));
    this.conns = new Map(); // endpointId -> registered Conn

    this.server = http.createServer((req, res) => {
      // Plain HTTP here is a misrouted probe (or someone poking the public URL).
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("upgrade required\n");
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 8 * 1024 * 1024,
      handleProtocols: (offered) =>
        offered.has(SUBPROTOCOL)
          ? SUBPROTOCOL
          : offered.has(LEGACY_SUBPROTOCOL)
            ? LEGACY_SUBPROTOCOL
            : false,
    });
    this.server.on("upgrade", (req, socket, head) =>
      this._onUpgrade(req, socket, head),
    );

    this.heartbeat = setInterval(() => this._beat(), HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  listen(port, bind) {
    return new Promise((resolve) => this.server.listen(port, bind, resolve));
  }

  // ------------------------------------------------------------ lookups

  connectedIds() {
    return [...this.conns.keys()].filter((endpointId) =>
      this.isConnected(endpointId),
    );
  }

  isConnected(endpointId) {
    const c = this.conns.get(endpointId);
    return Boolean(c?.ready) && c.ws.readyState === c.ws.OPEN;
  }

  // Decisions must name their original endpoint. Never guess another browser,
  // even if only one happens to remain connected.
  resolve(endpoint, { allowRecovery = false } = {}) {
    if (typeof endpoint !== "string" || !ENDPOINT_RE.test(endpoint)) {
      return {
        error: "BAD_ENDPOINT",
        message: "An explicit browser endpoint is required",
      };
    }
    if (this.isConnected(endpoint)) return { endpointId: endpoint };
    if (allowRecovery && this.conns.get(endpoint)?.recoveryTimer)
      return { endpointId: endpoint };
    let known = false;
    try {
      known = Boolean(this.loadKeys()[endpoint.split(".")[0]]);
    } catch {
      /* unknown */
    }
    return known
      ? {
          error: "EXT_OFFLINE",
          message: `browser ${endpoint} is not connected`,
        }
      : { error: "UNKNOWN_ENDPOINT", message: "Unknown browser endpoint" };
  }

  status() {
    const extensions = {};
    for (const [endpointId, c] of this.conns) {
      extensions[endpointId] = {
        endpointId,
        keyId: c.keyId,
        browserId: c.browserId,
        connected: this.isConnected(endpointId),
        recovery: c.recoveryTimer ? { state: "reconnecting", expiresAt: c.recoveryExpiresAt } : null,
        label: c.label,
        since: c.since,
        version: c.version || null,
        capabilities: c.capabilities || [],
        lastSeenMsAgo: Date.now() - c.lastSeen,
        pending: c.pending.size,
        agentTurn: c.agentTurn || null,
      };
    }
    return extensions;
  }

  // ------------------------------------------------------------ upgrade/auth

  _onUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== EXT_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Auth rides in Sec-WebSocket-Protocol: an MV3 service worker cannot set
    // custom headers on a WebSocket, and a subprotocol -- unlike ?key= -- is
    // not written to every proxy access log along the path.
    const offered = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const keyProto = offered.find((p) => p.startsWith(KEY_PROTO_PREFIX));
    const presented = keyProto ? keyProto.slice(KEY_PROTO_PREFIX.length) : null;

    let identity = null;
    if (
      (offered.includes(SUBPROTOCOL) || offered.includes(LEGACY_SUBPROTOCOL)) &&
      presented
    ) {
      try {
        identity = verifyKey(presented, this.loadKeys());
      } catch (err) {
        this.log(`ext: keys unreadable: ${err.message}`);
      }
    }
    if (!identity) {
      this.log(
        `ext: upgrade REJECTED (key ${presented ? "present/bad" : "absent"})`,
      );
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // ws echoes back only the first offered protocol we accept, never the key one.
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this._onConnected(ws, req, identity),
    );
  }

  _onConnected(ws, req, { keyId, label }) {
    // Register only after a valid hello. A bad or incomplete handshake must
    // never evict a working instance using the same credential.
    const conn = {
      keyId,
      label,
      ws,
      endpointId: null,
      browserId: null,
      since: new Date().toISOString(),
      remote: req.socket.remoteAddress,
      alive: true,
      lastSeen: Date.now(),
      version: null,
      capabilities: [],
      nextId: 1,
      pending: new Map(),
      superseded: false,
    };
    conn.handshakeTimer = setTimeout(
      () => safeClose(ws, 4002, "hello required"),
      HANDSHAKE_MS,
    );
    conn.handshakeTimer.unref?.();
    ws.on("message", (raw) => this._onMessage(conn, raw));
    ws.on("close", (code) => {
      clearTimeout(conn.handshakeTimer);
      if (this.conns.get(conn.endpointId) === conn) {
        if (!this._suspend(conn, code)) this._terminate(conn, code);
      }
      this.log(`ext[${conn.endpointId || keyId}]: closed (${code})`);
    });
    ws.on("error", (err) =>
      this.log(`ext[${conn.endpointId || keyId}]: socket error`, err.message),
    );
  }

  _hello(conn, msg) {
    if (conn.ready) {
      safeClose(conn.ws, 4002, "identity already established");
      return;
    }
    const instanceProtocol = conn.ws.protocol === SUBPROTOCOL;
    const caps = Array.isArray(msg.capabilities)
      ? msg.capabilities.filter((c) => typeof c === "string").slice(0, 32)
      : [];
    if (caps.includes(RESUME_CAPABILITY) &&
        (!instanceProtocol || typeof msg.runtimeEpoch !== "string" ||
         !/^[a-zA-Z0-9_-]{16,128}$/.test(msg.runtimeEpoch))) {
      safeClose(conn.ws, 4002, "invalid runtime epoch");
      return;
    }
    if (
      !caps.includes("agent-loop-v1") ||
      (instanceProtocol &&
        (!caps.includes(INSTANCE_CAPABILITY) ||
          typeof msg.browserId !== "string" ||
          !BROWSER_ID_RE.test(msg.browserId)))
    ) {
      safeClose(
        conn.ws,
        4002,
        "browser identity and required capabilities missing",
      );
      return;
    }
    conn.browserId = instanceProtocol ? msg.browserId : null;
    const endpointId = conn.browserId
      ? `${conn.keyId}.${conn.browserId}`
      : conn.keyId;
    const prev = this.conns.get(endpointId);
    const resumable = caps.includes(RESUME_CAPABILITY);
    const newTask = Boolean(prev && msg.resume && !prev.agentTurn &&
      !prev.seenTasks?.has(msg.resume.taskId) && msg.resume.phase === "waiting" && msg.resume.round === 1);
    const requestMatches = msg.resume && (newTask || msg.resume.phase === "terminal" ||
      (typeof msg.resume.requestId === "string" &&
       (msg.resume.requestId === prev?.currentRequestId && msg.resume.round === prev.agentRound ||
        msg.resume.phase === "waiting" && msg.resume.round === (prev?.agentRound || 0) + 1)));
    const resumed = Boolean(prev && resumable && prev.runtimeEpoch === msg.runtimeEpoch &&
      prev.capabilities.includes(RESUME_CAPABILITY) && msg.resume &&
      (newTask || !(prev.agentTurn || prev.lastTaskId) || (prev.agentTurn || prev.lastTaskId) === msg.resume.taskId) &&
      typeof msg.resume.taskId === "string" && msg.resume.taskId.length > 0 && msg.resume.taskId.length <= 160 &&
      ["waiting", "executing", "terminal"].includes(msg.resume.phase) &&
      requestMatches &&
      (!prev.recoveryExpiresAt || prev.recoveryExpiresAt > Date.now()));
    if (msg.resume && !resumed) {
      if (prev) {
        this._terminate(prev, 4005, "resume identity mismatch");
        safeClose(prev.ws, 4005, "resume identity mismatch");
      }
      this._send(conn, { type: "ready", endpointId, capabilities: [RESUME_CAPABILITY],
        runtimeEpoch: msg.runtimeEpoch, resume: { status: "rejected", reason: "RESUME_STATE_MISMATCH" } });
      safeClose(conn.ws, 4005, "resume rejected");
      return;
    }
    if (
      !prev &&
      [...this.conns.values()].filter((c) => c.keyId === conn.keyId).length >=
        MAX_CONNECTIONS_PER_KEY
    ) {
      safeClose(conn.ws, 4003, "too many browser instances");
      return;
    }
    if (prev) {
      prev.superseded = true;
      this.log(
        `ext[${endpointId}]: superseding previous connection of this instance`,
      );
      if (resumed) {
        clearTimeout(prev.recoveryTimer);
        for (const [id, pending] of prev.pending) {
          if (pending.method === "agent-decision") continue;
          clearTimeout(pending.timer);
          prev.pending.delete(id);
          pending.reject(Object.assign(new Error("connection replaced"), { code: "EXT_OFFLINE" }));
        }
        for (const name of ["agentTurn", "lastTaskId", "agentRound", "currentRequestId", "agentRequests", "ownerText",
          "inputSequence", "agentStopping", "deliveries", "seenTasks", "pending", "nextId"])
          conn[name] = prev[name];
        for (const pending of conn.pending.values()) clearTimeout(pending.timer);
      } else this._terminate(prev, 4001, "browser instance replaced");
      safeClose(prev.ws, 4001, "superseded by same browser instance");
    }
    clearTimeout(conn.handshakeTimer);
    conn.endpointId = endpointId;
    conn.version =
      typeof msg.version === "string" ? msg.version.slice(0, 80) : null;
    conn.capabilities = caps;
    conn.runtimeEpoch = resumable ? msg.runtimeEpoch : null;
    conn.deliveries ||= new Map();
    conn.ready = true;
    this.conns.set(endpointId, conn);
    this.log(
      `ext[${endpointId}]: connected${conn.label ? ` (${conn.label})` : ""}`,
    );
    this.emit("connected", endpointId, {
      endpointId: conn.endpointId,
      keyId: conn.keyId,
      browserId: conn.browserId,
      label: conn.label,
      version: conn.version,
      capabilities: caps,
    });
    this._send(conn, {
      type: "ready",
      endpointId,
      ...(resumable ? { runtimeEpoch: conn.runtimeEpoch, recoveryWindowMs: this.recoveryMs,
        resume: { status: resumed ? "resumed" : "fresh" } } : {}),
      capabilities: instanceProtocol
        ? [
            "agent-loop-v1",
            INSTANCE_CAPABILITY,
            RESUME_CAPABILITY,
            ATTACHMENT_CAPABILITY,
            AGENT_MESSAGE_CAPABILITY,
            INTERRUPT_CAPABILITY,
            STEER_CAPABILITY,
            "agent-steer-v1", // Older clients still send updates in decision requests.
          ]
        : [
            "agent-loop-v1",
            ATTACHMENT_CAPABILITY,
            AGENT_MESSAGE_CAPABILITY,
            STEER_CAPABILITY,
            "agent-steer-v1",
          ],
    });
    if (resumed) {
      for (const [id, pending] of conn.pending) this._sendPending(conn, id, pending);
      this.emit("resumed", endpointId);
    }
  }

  _suspend(conn, code) {
    if (this.closing || conn.terminalTransport || [4002, 4004, 4005].includes(code) ||
        !conn.capabilities.includes(RESUME_CAPABILITY)) return false;
    if (conn.recoveryTimer) return true;
    conn.recoveryExpiresAt = Date.now() + this.recoveryMs;
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer);
      if (pending.method !== "agent-decision") {
        conn.pending.delete(id);
        pending.reject(Object.assign(new Error("extension disconnected"), { code: "EXT_OFFLINE" }));
      }
    }
    conn.recoveryTimer = setTimeout(() => {
      if (this.conns.get(conn.endpointId) === conn)
        this._terminate(conn, 4005, "recovery window expired");
    }, this.recoveryMs);
    conn.recoveryTimer.unref?.();
    this.emit("suspended", conn.endpointId, { expiresAt: conn.recoveryExpiresAt });
    return true;
  }

  _terminate(conn, code, reason = "extension disconnected") {
    conn.terminalTransport = true;
    clearTimeout(conn.recoveryTimer);
    conn.recoveryTimer = null;
    if (this.conns.get(conn.endpointId) === conn) this.conns.delete(conn.endpointId);
    this._failAllPending(conn, reason);
    this.emit("disconnected", conn.endpointId, code);
  }

  _delivery(conn, msg) {
    if (!conn.capabilities?.includes(RESUME_CAPABILITY)) return true;
    if (msg.runtimeEpoch !== conn.runtimeEpoch || typeof msg.deliveryId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.deliveryId)) return false;
    const signature = createHash("sha256").update(JSON.stringify(msg)).digest("hex");
    const previous = conn.deliveries.get(msg.deliveryId);
    if (previous) {
      if (previous.signature !== signature) {
        this._terminate(conn, 4005, "delivery identity collision");
        safeClose(conn.ws, 4005, "delivery identity collision");
        return false;
      }
      if (previous.acked) this._ackDelivery(conn, msg);
      return false;
    }
    for (const [id, entry] of conn.deliveries) {
      if (conn.deliveries.size < 256) break;
      if (entry.acked) conn.deliveries.delete(id);
    }
    if (conn.deliveries.size >= 256) {
      this._terminate(conn, 4005, "recovery delivery buffer full");
      safeClose(conn.ws, 4005, "recovery delivery buffer full");
      return false;
    }
    conn.deliveries.set(msg.deliveryId, { acked: false, signature });
    return true;
  }

  _ackDelivery(conn, msg, statusFrame) {
    if (!msg.deliveryId) return;
    const receipt = conn.deliveries.get(msg.deliveryId);
    if (receipt) {
      receipt.acked = true;
      if (statusFrame) receipt.statusFrame = statusFrame;
    }
    const current = this.conns.get(conn.endpointId);
    if (current?.runtimeEpoch === conn.runtimeEpoch) {
      if (receipt?.statusFrame && (!current.agentTurn || current.agentTurn === msg.taskId))
        this._send(current, receipt.statusFrame);
      this._send(current, { type: "task-ack", deliveryId: msg.deliveryId, runtimeEpoch: conn.runtimeEpoch });
    }
  }

  // ------------------------------------------------------------ frames

  _onMessage(conn, raw) {
    if (
      conn.ws.readyState !== conn.ws.OPEN ||
      conn.superseded ||
      (conn.endpointId && this.conns.get(conn.endpointId) !== conn)
    )
      return;
    conn.lastSeen = Date.now();
    conn.alive = true;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.log(`ext[${conn.endpointId}]: dropped unparseable frame`);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (!conn.ready && msg.type !== "hello") {
      safeClose(conn.ws, 4002, "hello required before messages");
      return;
    }

    switch (msg.type) {
      case "pong":
        return;
      case "hello":
        return this._hello(conn, msg);
      case "agent-request":
        if (!this._delivery(conn, msg)) return;
        return this._onAgentRequest(conn, msg);
      case "agent-input":
        if (!this._delivery(conn, msg)) return;
        return this._onAgentInput(conn, msg);
      case "agent-turn-end": {
        if (!this._delivery(conn, msg)) return;
        if (!conn.agentTurn || msg.taskId !== conn.agentTurn) {
          this._ackDelivery(conn, msg);
          return;
        }
        conn.lastTaskId = conn.agentTurn;
        conn.agentTurn = null;
        // Release this task's dedup entries so the bounded set cannot evict a
        // live task's IDs just because an old finished task is still holding
        // slots.
        if (conn.agentRequests)
          for (const entry of conn.agentRequests)
            if (entry.startsWith(`${msg.taskId} `))
              conn.agentRequests.delete(entry);
        const interrupt = msg.status === "stopped" && msg.interrupt === true;
        conn.agentStopping = interrupt;
        let reported = false;
        this.emit(
          "agent-turn-end",
          {
            endpointId: conn.endpointId,
            keyId: conn.keyId,
            browserId: conn.browserId,
            taskId: msg.taskId,
            interrupt,
            ...(msg.status === "interrupted" && controlLossReceipt(msg.interruption)
              ? { interruption: controlLossReceipt(msg.interruption) } : {}),
            status: ["done", "blocked", "interrupted", "stopped"].includes(
              msg.status,
            )
              ? msg.status
              : "interrupted",
            text:
              typeof msg.text === "string"
                ? msg.text.slice(0, MAX_CHAT_TEXT)
                : "",
          },
          (result) => {
            if (reported) return;
            reported = true;
            conn.agentStopping = false;
            const current = this.conns.get(conn.endpointId);
            if (!current || (current !== conn &&
                (!conn.runtimeEpoch || current.runtimeEpoch !== conn.runtimeEpoch || current.lastTaskId !== msg.taskId))) return;
            current.agentStopping = false;
            this._send(current, {
              type: "agent-stop-result",
              taskId: msg.taskId,
              ...result,
            });
          },
        );
        for (const [id, pending] of conn.pending) {
          if (pending.method !== "agent-decision") continue;
          clearTimeout(pending.timer);
          conn.pending.delete(id);
          pending.reject(Object.assign(new Error("browser task ended"), { code: "TURN_TERMINATED" }));
        }
        this._ackDelivery(conn, msg);
        return;
      }
      case "agent-event":
        if (
          msg.taskId !== conn.agentTurn ||
          typeof msg.id !== "string" ||
          msg.id.length > 160 ||
          typeof msg.method !== "string" ||
          msg.method.length > 128 ||
          !["start", "end"].includes(msg.phase) ||
          Buffer.byteLength(JSON.stringify(msg)) > 32000
        )
          return;
        this.emit("agent-event", {
          ...msg,
          endpointId: conn.endpointId,
          keyId: conn.keyId,
          browserId: conn.browserId,
        });
        return;
      case "resp":
      case "error":
        break;
      default:
        this.log(`ext[${conn.endpointId}]: ignored frame type=${msg.type}`);
        return;
    }

    const p = conn.pending.get(msg.id);
    if (!p) return; // late or duplicate; the timer already fired
    clearTimeout(p.timer);
    conn.pending.delete(msg.id);
    if (msg.type === "error") {
      const err = new Error(
        typeof msg.message === "string"
          ? msg.message
          : typeof msg.error === "string"
            ? msg.error
            : "extension error",
      );
      err.code =
        typeof msg.code === "string" && msg.code
          ? msg.code
          : DEFAULT_ERROR_CODE;
      err.details = msg.details;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  _onAgentRequest(conn, msg) {
    const reportStatus = (status) => {
      const frame = { type: "agent-status", requestId: msg.id, ...status };
      if (msg.deliveryId) return this._ackDelivery(conn, msg, frame);
      const current = this.conns.get(conn.endpointId);
      if (current === conn || (current?.runtimeEpoch && current.runtimeEpoch === conn.runtimeEpoch))
        this._send(current, {
          type: "agent-status",
          requestId: msg.id,
          ...status,
        });
    };
    if (conn.agentStopping)
      return reportStatus({ state: "failed", code: "AGENT_STOPPING" });
    let request;
    try {
      if (!conn.ready) throw new Error("Not ready");
      request = normalizeAgentRequest(msg);
    } catch {
      return reportStatus({ state: "failed", code: "BAD_AGENT_REQUEST" });
    }
    if ((conn.agentTurn && conn.agentTurn !== msg.taskId) ||
        (!conn.agentTurn && conn.seenTasks?.has(msg.taskId)))
      return reportStatus({ state: "failed", code: "TURN_BUSY" });
    // Scope dedup to the task: the protocol only promises IDs correlate within
    // a task, so a client that restarts its counter must not have a legitimate
    // request silently swallowed by a previous task's ID. A duplicate is still
    // never enqueued twice, but it now always gets a status frame back —
    // returning silently left the extension waiting forever.
    conn.agentRequests ||= new Set();
    const dedupKey = `${msg.taskId} ${msg.id}`;
    if (conn.agentRequests.has(dedupKey))
      return reportStatus({ state: "failed", code: "DUPLICATE_REQUEST" });
    if (
      request.round !==
      (conn.agentTurn === request.taskId ? conn.agentRound + 1 : 1)
    )
      return reportStatus({ state: "failed", code: "BAD_AGENT_REQUEST" });
    conn.seenTasks ||= new Set();
    if (!conn.seenTasks.has(msg.taskId) && conn.seenTasks.size >= 1024) {
      reportStatus({ state: "failed", code: "TASK_HISTORY_FULL" });
      this._terminate(conn, 4005, "task history full");
      safeClose(conn.ws, 4005, "task history full");
      return;
    }
    conn.seenTasks.add(msg.taskId);
    conn.agentRequests.add(dedupKey);
    while (conn.agentRequests.size > 100)
      conn.agentRequests.delete(conn.agentRequests.values().next().value);
    conn.agentTurn = msg.taskId;
    conn.agentRound = request.round;
    conn.currentRequestId = request.id;
    if (request.round === 1) {
      conn.ownerText = messageText(request.message);
      conn.inputSequence = 0;
    }
    this.emit(
      "agent-request",
      {
        endpointId: conn.endpointId,
        keyId: conn.keyId,
        browserId: conn.browserId,
        label: conn.label,
        text: conn.ownerText,
        chatId: msg.taskId,
        request,
      },
      reportStatus,
    );
  }

  _onAgentInput(conn, msg) {
    const reportStatus = (status) => {
      const frame = { type: "agent-input-status", taskId: msg.taskId, inputId: msg.id, ...status };
      if (msg.deliveryId) return this._ackDelivery(conn, msg, frame);
      const current = this.conns.get(conn.endpointId);
      if (current === conn || (current?.runtimeEpoch && current.runtimeEpoch === conn.runtimeEpoch))
        this._send(current, {
          type: "agent-input-status",
          taskId: msg.taskId,
          inputId: msg.id,
          ...status,
        });
    };
    if (conn.agentStopping)
      return reportStatus({ state: "failed", code: "AGENT_STOPPING" });
    let request;
    try {
      request = normalizeAgentInput(msg);
    } catch {
      return reportStatus({ state: "failed", code: "BAD_AGENT_INPUT" });
    }
    if (
      !conn.capabilities.includes(STEER_CAPABILITY) ||
      conn.agentTurn !== request.taskId
    )
      return reportStatus({ state: "failed", code: "STALE_INPUT" });
    // WS frames are ordered. This counter rejects duplicates even in very long
    // tasks, without retaining a queue of message bodies or an unbounded ID set.
    if (request.sequence !== conn.inputSequence + 1)
      return reportStatus({ state: "failed", code: "BAD_INPUT_SEQUENCE" });
    conn.inputSequence = request.sequence;
    this.emit(
      "agent-input",
      {
        kind: "input",
        endpointId: conn.endpointId,
        keyId: conn.keyId,
        browserId: conn.browserId,
        label: conn.label,
        text: messageText(request.message),
        chatId: request.taskId,
        request,
      },
      reportStatus,
    );
  }

  /** Correlated transport for a client decision; browser actions remain opaque. */
  request(endpointId, { method, params, requestId, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const conn = this.conns.get(endpointId);
      if (!conn?.ready || (conn.ws.readyState !== conn.ws.OPEN &&
          !(conn.recoveryTimer && method === "agent-decision"))) {
        const err = new Error("extension not connected");
        err.code = "EXT_OFFLINE";
        reject(err);
        return;
      }
      const ms = clampTimeout(timeoutMs);
      const id = conn.nextId++;
      const frame = {
        id,
        type: "req",
        method,
        params: params || {},
        deadline: Date.now() + ms,
      };
      if (requestId) frame.requestId = requestId;
      const pending = { method, ms, frame, resolve, reject };
      conn.pending.set(id, pending);
      if (!conn.recoveryTimer) this._sendPending(conn, id, pending);
    });
  }

  _sendPending(conn, id, pending) {
    pending.frame.deadline = Date.now() + pending.ms;
    pending.timer = setTimeout(() => {
      conn.pending.delete(id);
      pending.reject(Object.assign(new Error(`timeout waiting for ${pending.method}`), { code: "EXT_TIMEOUT" }));
    }, pending.ms);
    if (!this._send(conn, pending.frame)) {
      if (pending.method === "agent-decision" && this._suspend(conn, 1006)) return;
      clearTimeout(pending.timer);
      conn.pending.delete(id);
      pending.reject(Object.assign(new Error("send failed"), { code: "EXT_OFFLINE" }));
    }
  }

  _send(conn, frame) {
    if (conn.ws.readyState !== conn.ws.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  _failAllPending(conn, reason) {
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      conn.pending.delete(id);
      const err = new Error(reason);
      err.code = "EXT_OFFLINE";
      p.reject(err);
    }
  }

  // Doubles as the MV3 keepalive: Chrome 116+ resets the service-worker idle
  // timer on WebSocket activity, so this traffic is what keeps the extension
  // from being torn down at ~30s.
  _beat() {
    // The key is only verified at upgrade, so without this a revoked credential
    // would keep working for as long as the socket stays open. Re-read once per
    // beat and drop connections whose keyId is gone. If the registry is
    // unreadable we keep everyone connected: a transient read error must not
    // disconnect working browsers.
    let known = null;
    try {
      known = this.loadKeys();
    } catch (err) {
      this.log(`ext: keys unreadable during beat: ${err.message}`);
    }
    for (const conn of this.conns.values()) {
      if (known && !known[conn.keyId]) {
        this.log(`ext[${conn.endpointId || conn.keyId}]: key revoked, closing`);
        this._terminate(conn, 4004, "key revoked");
        safeClose(conn.ws, 4004, "key revoked");
        continue;
      }
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      if (!conn.alive) {
        this.log(`ext[${conn.endpointId}]: heartbeat missed, terminating`);
        try {
          conn.ws.terminate();
        } catch {
          /* noop */
        }
        continue;
      }
      conn.alive = false;
      this._send(conn, { type: "ping", ts: Date.now() });
    }
  }

  close() {
    this.closing = true;
    clearInterval(this.heartbeat);
    for (const conn of this.conns.values()) {
      this._terminate(conn, 1001, "relay shutting down");
      safeClose(conn.ws, 1001, "relay shutting down");
    }
    for (const ws of this.wss.clients) ws.terminate();
    this.server.close();
  }
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), 1000), MAX_COMMAND_TIMEOUT_MS);
}

export {
  ExtLane,
  SUBPROTOCOL,
  LEGACY_SUBPROTOCOL,
  KEY_PROTO_PREFIX,
  EXT_PATH,
  HEARTBEAT_MS,
  COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_CHAT_TEXT,
  DEFAULT_ERROR_CODE,
};
