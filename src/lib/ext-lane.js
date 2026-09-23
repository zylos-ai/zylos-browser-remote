"use strict";
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

const http = require("http");
const { EventEmitter } = require("events");
const { WebSocketServer } = require("ws");
const { verifyKey, loadKeys } = require("./keys");
const { ATTACHMENT_CAPABILITY } = require("../../scripts/attachments");
const { INTERRUPT_CAPABILITY } = require("./agent-interrupt");
const {
  AGENT_MESSAGE_CAPABILITY,
  normalizeAgentRequest,
  messageText,
} = require("./agent-message");

const SUBPROTOCOL = "zylos-browser-remote.v3";
const LEGACY_SUBPROTOCOL = "zylos-browser-remote.v2";
const {
  BROWSER_ID_RE,
  ENDPOINT_RE,
  INSTANCE_CAPABILITY,
} = require("./endpoint");
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

/**
 * Emits:
 *   'connected'    (endpointId, {keyId, browserId, label, version, capabilities})
 *   'disconnected' (endpointId, code)
 *   'agent-request' ({endpointId, keyId, browserId, label, text, request})
 */
class ExtLane extends EventEmitter {
  constructor({ log = () => {}, loadKeys: loader = loadKeys } = {}) {
    super();
    this.log = log;
    this.loadKeys = loader;
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
  resolve(endpoint) {
    if (typeof endpoint !== "string" || !ENDPOINT_RE.test(endpoint)) {
      return {
        error: "BAD_ENDPOINT",
        message: "An explicit browser endpoint is required",
      };
    }
    if (this.isConnected(endpoint)) return { endpointId: endpoint };
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
        connected: !!c.ready,
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
      () => ws.close(4002, "hello required"),
      HANDSHAKE_MS,
    );
    conn.handshakeTimer.unref?.();
    ws.on("message", (raw) => this._onMessage(conn, raw));
    ws.on("close", (code) => {
      clearTimeout(conn.handshakeTimer);
      if (this.conns.get(conn.endpointId) === conn) {
        this.conns.delete(conn.endpointId);
        this._failAllPending(conn, "extension disconnected");
        this.emit("disconnected", conn.endpointId, code);
      }
      this.log(`ext[${conn.endpointId || keyId}]: closed (${code})`);
    });
    ws.on("error", (err) =>
      this.log(`ext[${conn.endpointId || keyId}]: socket error`, err.message),
    );
  }

  _hello(conn, msg) {
    if (conn.ready) {
      conn.ws.close(4002, "identity already established");
      return;
    }
    const instanceProtocol = conn.ws.protocol === SUBPROTOCOL;
    const caps = Array.isArray(msg.capabilities)
      ? msg.capabilities.filter((c) => typeof c === "string").slice(0, 32)
      : [];
    if (
      !caps.includes("agent-loop-v1") ||
      (instanceProtocol &&
        (!caps.includes(INSTANCE_CAPABILITY) ||
          typeof msg.browserId !== "string" ||
          !BROWSER_ID_RE.test(msg.browserId)))
    ) {
      conn.ws.close(4002, "browser identity and required capabilities missing");
      return;
    }
    conn.browserId = instanceProtocol ? msg.browserId : null;
    const endpointId = conn.browserId
      ? `${conn.keyId}.${conn.browserId}`
      : conn.keyId;
    const prev = this.conns.get(endpointId);
    if (
      !prev &&
      [...this.conns.values()].filter((c) => c.keyId === conn.keyId).length >=
        MAX_CONNECTIONS_PER_KEY
    ) {
      conn.ws.close(4003, "too many browser instances");
      return;
    }
    if (prev) {
      prev.superseded = true;
      this.log(
        `ext[${endpointId}]: superseding previous connection of this instance`,
      );
      this.emit("disconnected", endpointId, 4001);
      this._failAllPending(
        prev,
        "browser instance reconnected; in-flight request abandoned",
      );
      prev.ws.close(4001, "superseded by same browser instance");
    }
    clearTimeout(conn.handshakeTimer);
    conn.endpointId = endpointId;
    conn.version =
      typeof msg.version === "string" ? msg.version.slice(0, 80) : null;
    conn.capabilities = caps;
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
      capabilities: instanceProtocol
        ? [
            "agent-loop-v1",
            INSTANCE_CAPABILITY,
            ATTACHMENT_CAPABILITY,
            AGENT_MESSAGE_CAPABILITY,
            INTERRUPT_CAPABILITY,
          ]
        : ["agent-loop-v1", ATTACHMENT_CAPABILITY, AGENT_MESSAGE_CAPABILITY],
    });
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
      conn.ws.close(4002, "hello required before messages");
      return;
    }

    switch (msg.type) {
      case "pong":
        return;
      case "hello":
        return this._hello(conn, msg);
      case "agent-request":
        return this._onAgentRequest(conn, msg);
      case "agent-turn-end": {
        if (!conn.agentTurn || msg.taskId !== conn.agentTurn) return;
        conn.agentTurn = null;
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
            if (this.conns.get(conn.endpointId) !== conn || conn.superseded)
              return;
            this._send(conn, {
              type: "agent-stop-result",
              taskId: msg.taskId,
              ...result,
            });
          },
        );
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
      if (this.conns.get(conn.endpointId) === conn)
        this._send(conn, {
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
    if (conn.agentTurn && conn.agentTurn !== msg.taskId)
      return reportStatus({ state: "failed", code: "TURN_BUSY" });
    conn.agentRequests ||= new Set();
    if (conn.agentRequests.has(msg.id)) return; // Never enqueue a decision twice.
    if (
      request.round !==
      (conn.agentTurn === request.taskId ? conn.agentRound + 1 : 1)
    )
      return reportStatus({ state: "failed", code: "BAD_AGENT_REQUEST" });
    conn.agentRequests.add(msg.id);
    while (conn.agentRequests.size > 100)
      conn.agentRequests.delete(conn.agentRequests.values().next().value);
    conn.agentTurn = msg.taskId;
    conn.agentRound = request.round;
    if (request.round === 1) conn.ownerText = messageText(request.message);
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

  /** Correlated transport for a client decision; browser actions remain opaque. */
  request(endpointId, { method, params, requestId, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const conn = this.conns.get(endpointId);
      if (!conn?.ready || conn.ws.readyState !== conn.ws.OPEN) {
        const err = new Error("extension not connected");
        err.code = "EXT_OFFLINE";
        reject(err);
        return;
      }
      const ms = clampTimeout(timeoutMs);
      const id = conn.nextId++;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        const err = new Error(`timeout after ${ms}ms waiting for ${method}`);
        err.code = "EXT_TIMEOUT";
        reject(err);
      }, ms);
      conn.pending.set(id, { method, timer, resolve, reject });
      const frame = {
        id,
        type: "req",
        method,
        params: params || {},
        deadline: Date.now() + ms,
      };
      if (requestId) frame.requestId = requestId;
      if (!this._send(conn, frame)) {
        clearTimeout(timer);
        conn.pending.delete(id);
        const err = new Error("send failed");
        err.code = "EXT_OFFLINE";
        reject(err);
      }
    });
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
    for (const conn of this.conns.values()) {
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
    clearInterval(this.heartbeat);
    for (const conn of this.conns.values()) {
      this._failAllPending(conn, "relay shutting down");
      try {
        conn.ws.close(1001, "relay shutting down");
      } catch {
        /* noop */
      }
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

module.exports = {
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
