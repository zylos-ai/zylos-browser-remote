'use strict';
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
 * the lane does own: key -> connection mapping, request/response correlation,
 * heartbeat, and bounding the chat envelope.
 */

const http = require('http');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { verifyKey, loadKeys } = require('./keys');

const SUBPROTOCOL = 'zylos-browser-remote.v2';
const KEY_PROTO_PREFIX = 'key.';
const EXT_PATH = '/ext';
const HEARTBEAT_MS = 17_000;       // app-level: a proxy may swallow raw ping frames
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;

// Side-panel chat. The owner's message is opaque data: never parsed, matched or
// rewritten here -- it only has to be bounded, so a runaway panel cannot push an
// unbounded argv at c4-receive. Over the cap the frame is REFUSED and said so,
// never silently shortened: half an instruction is worse than no instruction.
const MAX_CHAT_TEXT = 8000;
// Sent by the extension in `error` frames when it did not supply a code itself.
const DEFAULT_ERROR_CODE = 'EXT_ERROR';

/**
 * Emits:
 *   'connected'    (keyId, {label, version, capabilities})
 *   'disconnected' (keyId, code)
 *   'chat'         ({keyId, label, text, ts})
 *   'chat-refused' ({keyId, reason, length})
 */
class ExtLane extends EventEmitter {
  constructor({ log = () => {}, loadKeys: loader = loadKeys } = {}) {
    super();
    this.log = log;
    this.loadKeys = loader;
    this.conns = new Map();    // keyId -> Conn

    this.server = http.createServer((req, res) => {
      // Plain HTTP here is a misrouted probe (or someone poking the public URL).
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('upgrade required\n');
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));

    this.heartbeat = setInterval(() => this._beat(), HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  listen(port, bind) {
    return new Promise((resolve) => this.server.listen(port, bind, resolve));
  }

  // ------------------------------------------------------------ lookups

  connectedIds() {
    return [...this.conns.keys()];
  }

  isConnected(keyId) {
    const c = this.conns.get(keyId);
    return Boolean(c) && c.ws.readyState === c.ws.OPEN;
  }

  /**
   * Turn an agent-supplied `endpoint` into a keyId.
   *   omitted + exactly one connection -> that one
   *   omitted + several               -> AMBIGUOUS_ENDPOINT
   *   given but not connected          -> EXT_OFFLINE (known key) / UNKNOWN_ENDPOINT
   */
  resolve(endpoint) {
    if (endpoint === undefined || endpoint === null || endpoint === '') {
      const ids = this.connectedIds();
      if (ids.length === 1) return { keyId: ids[0] };
      if (ids.length === 0) return { error: 'EXT_OFFLINE', message: 'no extension connected' };
      return { error: 'AMBIGUOUS_ENDPOINT', message: `several extensions connected; pass endpoint (one of ${ids.join(', ')})` };
    }
    if (typeof endpoint !== 'string' || !/^[a-f0-9]{12}$/.test(endpoint)) {
      return { error: 'BAD_ENDPOINT', message: 'endpoint must be a 12-hex keyId' };
    }
    if (this.isConnected(endpoint)) return { keyId: endpoint };
    let known = false;
    try { known = Boolean(this.loadKeys()[endpoint]); } catch { /* treat as unknown */ }
    return known
      ? { error: 'EXT_OFFLINE', message: `extension ${endpoint} is not connected` }
      : { error: 'UNKNOWN_ENDPOINT', message: `no such key ${endpoint}` };
  }

  status() {
    const extensions = {};
    for (const [keyId, c] of this.conns) {
      extensions[keyId] = {
        connected: true,
        label: c.label,
        since: c.since,
        version: c.version || null,
        capabilities: c.capabilities || [],
        lastSeenMsAgo: Date.now() - c.lastSeen,
        pending: c.pending.size,
      };
    }
    return extensions;
  }

  // ------------------------------------------------------------ upgrade/auth

  _onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== EXT_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Auth rides in Sec-WebSocket-Protocol: an MV3 service worker cannot set
    // custom headers on a WebSocket, and a subprotocol -- unlike ?key= -- is
    // not written to every proxy access log along the path.
    const offered = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const keyProto = offered.find((p) => p.startsWith(KEY_PROTO_PREFIX));
    const presented = keyProto ? keyProto.slice(KEY_PROTO_PREFIX.length) : null;

    let identity = null;
    if (offered.includes(SUBPROTOCOL) && presented) {
      try {
        identity = verifyKey(presented, this.loadKeys());
      } catch (err) {
        this.log(`ext: keys unreadable: ${err.message}`);
      }
    }
    if (!identity) {
      this.log(`ext: upgrade REJECTED (key ${presented ? 'present/bad' : 'absent'})`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // ws echoes back only the first offered protocol we accept, never the key one.
    this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnected(ws, req, identity));
  }

  _onConnected(ws, req, { keyId, label }) {
    const prev = this.conns.get(keyId);
    if (prev) {
      // Newest wins: a reconnect after a half-dead socket must heal cleanly
      // rather than leave a zombie holding the key. Anything in flight on the
      // old socket is never answered, so fail it now instead of after 30s --
      // MV3 recycles the service worker routinely, so this is the common path.
      this.log(`ext[${keyId}]: superseding previous connection`);
      prev.superseded = true;
      this._failAllPending(prev, 'extension reconnected; in-flight request abandoned');
      try { prev.ws.close(4001, 'superseded by newer connection'); } catch { /* gone */ }
    }
    const conn = {
      keyId, label, ws,
      since: new Date().toISOString(),
      remote: req.socket.remoteAddress,
      alive: true,
      lastSeen: Date.now(),
      version: null,
      capabilities: [],
      nextId: 1,
      pending: new Map(),     // id -> {resolve, reject, timer, method}
      superseded: false,
    };
    this.conns.set(keyId, conn);
    this.log(`ext[${keyId}]: connected${label ? ` (${label})` : ''}`);

    ws.on('message', (raw) => this._onMessage(conn, raw));
    ws.on('close', (code) => {
      if (this.conns.get(keyId) === conn) {
        this.conns.delete(keyId);
        this._failAllPending(conn, 'extension disconnected');
        this.emit('disconnected', keyId, code);
      }
      this.log(`ext[${keyId}]: closed (${code})`);
    });
    ws.on('error', (err) => this.log(`ext[${keyId}]: socket error`, err.message));
  }

  // ------------------------------------------------------------ frames

  _onMessage(conn, raw) {
    conn.lastSeen = Date.now();
    conn.alive = true;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.log(`ext[${conn.keyId}]: dropped unparseable frame`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'pong':
        return;
      case 'hello':
        conn.version = typeof msg.version === 'string' ? msg.version : null;
        conn.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter((c) => typeof c === 'string') : [];
        this.log(`ext[${conn.keyId}]: hello v${conn.version || '?'} caps=${conn.capabilities.length}`);
        this.emit('connected', conn.keyId, { label: conn.label, version: conn.version, capabilities: conn.capabilities });
        return;
      case 'chat':
        this._onChat(conn, msg);
        return;
      case 'resp':
      case 'error':
        break;
      default:
        this.log(`ext[${conn.keyId}]: ignored frame type=${msg.type}`);
        return;
    }

    const p = conn.pending.get(msg.id);
    if (!p) return;                       // late or duplicate; the timer already fired
    clearTimeout(p.timer);
    conn.pending.delete(msg.id);
    if (msg.type === 'error') {
      const err = new Error(typeof msg.message === 'string' ? msg.message : (typeof msg.error === 'string' ? msg.error : 'extension error'));
      err.code = typeof msg.code === 'string' && msg.code ? msg.code : DEFAULT_ERROR_CODE;
      err.details = msg.details;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  /**
   * Owner typed in the side panel: {type:'chat', text, ts}. Envelope only --
   * the text belongs to the owner and goes to the agent verbatim (server.js
   * hands it to c4-receive as one argv element, so no shell ever sees it).
   */
  _onChat(conn, msg) {
    const text = typeof msg.text === 'string' ? msg.text : null;
    const ts = Number.isFinite(msg.ts) ? msg.ts : Date.now();
    const chatId = typeof msg.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(msg.id) ? msg.id : undefined;
    // Keep acknowledgements on the socket that submitted the message. A late
    // C4 result must not be sent to a replacement connection using this key.
    const reportStatus = (status) => {
      if (this.conns.get(conn.keyId) !== conn) return false;
      return this._send(conn, { type: 'chat-status', ...status, chatId, ts: Date.now() });
    };

    const refuse = (reason) => {
      // Loud on both sides: a dropped owner message must never be silent.
      this.log(`ext[${conn.keyId}]: chat REFUSED (${reason})`);
      reportStatus({ state: 'failed', code: 'CHAT_REFUSED', error: `message refused: ${reason}` });
      this.emit('chat-refused', { keyId: conn.keyId, reason, length: text == null ? 0 : text.length });
    };

    if (text == null) return refuse('missing text');
    if (text.length === 0) return refuse('empty text');
    if (text.length > MAX_CHAT_TEXT) {
      return refuse(`text too long (${text.length} > ${MAX_CHAT_TEXT} chars) -- send it in parts`);
    }

    this.log(`ext[${conn.keyId}]: chat (${text.length} chars)`);
    this.emit('chat', { keyId: conn.keyId, label: conn.label, text, ts, chatId }, reportStatus);
  }

  // ------------------------------------------------------------ outbound

  /** Agent's reply, pushed down the panel socket. */
  sendChat(keyId, { text, role = 'assistant', ts = Date.now(), final = true } = {}) {
    const conn = this.conns.get(keyId);
    if (!conn) return false;
    return this._send(conn, { type: 'chat', role, text, ts, final });
  }

  /**
   * Forward one command and await its answer. `method`/`params` are opaque to
   * the relay; `requestId` is the agent's idempotency key and is passed through
   * untouched for the extension to honour.
   */
  request(keyId, { method, params, requestId, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const conn = this.conns.get(keyId);
      if (!conn || conn.ws.readyState !== conn.ws.OPEN) {
        const err = new Error('extension not connected');
        err.code = 'EXT_OFFLINE';
        reject(err);
        return;
      }
      const ms = clampTimeout(timeoutMs);
      const id = conn.nextId++;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        const err = new Error(`timeout after ${ms}ms waiting for ${method}`);
        err.code = 'EXT_TIMEOUT';
        reject(err);
      }, ms);
      conn.pending.set(id, { method, timer, resolve, reject });
      const frame = { id, type: 'req', method, params: params || {}, deadline: Date.now() + ms };
      if (requestId) frame.requestId = requestId;
      if (!this._send(conn, frame)) {
        clearTimeout(timer);
        conn.pending.delete(id);
        const err = new Error('send failed');
        err.code = 'EXT_OFFLINE';
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
      err.code = 'EXT_OFFLINE';
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
        this.log(`ext[${conn.keyId}]: heartbeat missed, terminating`);
        try { conn.ws.terminate(); } catch { /* noop */ }
        continue;
      }
      conn.alive = false;
      this._send(conn, { type: 'ping', ts: Date.now() });
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const conn of this.conns.values()) {
      this._failAllPending(conn, 'relay shutting down');
      try { conn.ws.close(1001, 'relay shutting down'); } catch { /* noop */ }
    }
    this.server.close();
  }
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), 1000), MAX_COMMAND_TIMEOUT_MS);
}

module.exports = {
  ExtLane, SUBPROTOCOL, KEY_PROTO_PREFIX, EXT_PATH, HEARTBEAT_MS,
  COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, MAX_CHAT_TEXT, DEFAULT_ERROR_CODE,
};
