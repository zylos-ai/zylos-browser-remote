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
 * exactly one: /ext, token-authed. Everything else is refused. Whoever learns the
 * public URL can, at most and only with the token, offer to BE a browser. Driving
 * one happens on the agent lane (:3803), which is loopback-only and never routed.
 */

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const SUBPROTOCOL = 'zylos-browser-remote.v1';
const EXT_PATH = '/ext';
const HEARTBEAT_MS = 17_000;       // app-level: a proxy may swallow raw ping frames
const COMMAND_TIMEOUT_MS = 30_000;

// Side-panel chat (SIDEPANEL-SPEC.md A/B). The owner's message is opaque data:
// it is never parsed, matched or rewritten here -- it only has to be bounded, so
// a runaway panel cannot push an unbounded argv at c4-receive. Over the cap the
// frame is REFUSED and said so, never silently shortened: half an instruction
// ("买两张票" -> "买两") is worse than no instruction.
const MAX_CHAT_TEXT = 8000;
// The sessionId is the C4 endpoint id and reaches a queue that names files after
// it, so it is screened as an identifier, not as free text.
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Constant-time compare over fixed-width digests (raw lengths differ -> leak). */
function tokenMatches(expected, presented) {
  if (!expected || !presented) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Emits: 'connected', 'disconnected' (code), 'hello' (payload), 'event' (frame),
 *        'state' (frame), 'chat' ({sessionId, text, ts}),
 *        'chat-refused' ({reason, sessionId, length})
 */
class ExtLane extends EventEmitter {
  constructor({ token, log = () => {} }) {
    super();
    this.token = token;
    this.log = log;
    this.ws = null;
    this.info = null;          // {since, remote, alive, lastSeen, capabilities, version}
    this.tabs = [];            // last reported tab list, newest wins
    this.nextId = 1;
    this.pending = new Map();  // id -> {resolve, reject, timer, method}

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

  isConnected() {
    return Boolean(this.ws) && this.ws.readyState === this.ws.OPEN;
  }

  status() {
    return this.info
      ? {
          connected: true,
          since: this.info.since,
          version: this.info.version || null,
          capabilities: this.info.capabilities || [],
          lastSeenMsAgo: Date.now() - this.info.lastSeen,
          tabs: this.tabs.length,
        }
      : { connected: false };
  }

  /** URL of the tab a lease is driving -- what guard.screen() screens against. */
  tabUrl(tabId) {
    if (!this.tabs.length) return undefined;
    if (tabId == null) return this.tabs[0].url;
    const hit = this.tabs.find((t) => String(t.id) === String(tabId));
    return hit ? hit.url : undefined;
  }

  // -------------------------------------------------------------- upgrade/auth

  _onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== EXT_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Auth rides in Sec-WebSocket-Protocol: an MV3 service worker cannot set
    // custom headers on a WebSocket, and a subprotocol -- unlike ?token= -- is
    // not written to every proxy access log along the path.
    const offered = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const tokenProto = offered.find((p) => p.startsWith('token.'));
    const presented = tokenProto ? tokenProto.slice('token.'.length) : null;

    if (!offered.includes(SUBPROTOCOL) || !tokenMatches(this.token, presented)) {
      this.log(`ext: upgrade REJECTED (token ${presented ? 'present/bad' : 'absent'})`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Echo back only the non-secret subprotocol.
    this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnected(ws, req));
  }

  _onConnected(ws, req) {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      // Newest wins: a reconnect after a half-dead socket must heal cleanly
      // rather than leave a zombie holding the lane.
      this.log('ext: superseding previous connection');
      // Anything still in flight was sent on the socket being replaced, so its
      // answer is never coming. Fail it HERE: the close handler below cannot,
      // because `this.ws` is reassigned to the new socket before the old one's
      // close event fires, so its `this.ws === ws` guard is already false.
      // Left to time out instead, an in-flight `attach` stalls the full 30s and
      // (since the agent lane registers its frame handler only after that
      // attach resolves) every agent command silently vanishes meanwhile.
      // MV3 recycles the extension service worker routinely, so this is the
      // common path, not an edge case.
      this._failAllPending('extension reconnected; in-flight request abandoned');
      try { this.ws.close(4001, 'superseded by newer connection'); } catch { /* gone */ }
    }
    this.ws = ws;
    this.info = {
      since: new Date().toISOString(),
      remote: req.socket.remoteAddress,
      alive: true,
      lastSeen: Date.now(),
    };
    this.log('ext: connected');
    this.emit('connected');

    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', (code) => {
      if (this.ws === ws) {
        this.ws = null;
        this.info = null;
        this.tabs = [];
        this._failAllPending('extension disconnected');
        this.emit('disconnected', code);
      }
      this.log(`ext: closed (${code})`);
    });
    ws.on('error', (err) => this.log('ext: socket error', err.message));
  }

  // -------------------------------------------------------------- frames

  _onMessage(raw) {
    if (this.info) {
      this.info.lastSeen = Date.now();
      this.info.alive = true;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.log('ext: dropped unparseable frame');
      return;
    }

    switch (msg.type) {
      case 'pong':
        return;
      case 'hello':
        if (this.info) {
          this.info.version = msg.version;
          this.info.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
        }
        if (Array.isArray(msg.tabs)) this.tabs = msg.tabs;
        this.log(`ext: hello v${msg.version || '?'} tabs=${this.tabs.length}`);
        this.emit('hello', msg);
        return;
      case 'state':
        if (Array.isArray(msg.tabs)) this.tabs = msg.tabs;
        this.emit('state', msg);
        return;
      case 'event':
        this.emit('event', msg);
        return;
      case 'chat':
        this._onChat(msg);
        return;
      case 'resp':
      case 'error':
        break;
      default:
        this.log(`ext: ignored frame type=${msg.type}`);
        return;
    }

    const p = this.pending.get(msg.id);
    if (!p) return;                       // late or duplicate; the timer already fired
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error || 'extension error'));
    else p.resolve(msg.result);
  }

  /**
   * Owner typed in the side panel: {type:'chat', sessionId, text, ts}.
   *
   * This lane validates the ENVELOPE only. The text is never inspected,
   * normalised or matched against anything -- it belongs to the owner and goes
   * to the agent verbatim (server.js hands it to c4-receive as one argv
   * element, so no quoting or shell parsing is ever applied to it).
   */
  _onChat(msg) {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
    const text = typeof msg.text === 'string' ? msg.text : null;
    const ts = Number.isFinite(msg.ts) ? msg.ts : Date.now();

    const refuse = (reason) => {
      // Loud on both sides: a dropped owner message must never be silent.
      this.log(`ext: chat REFUSED (${reason})`);
      this.notify({ type: 'chat-status', state: 'idle', error: `message refused: ${reason}`, ts: Date.now() });
      this.emit('chat-refused', { reason, sessionId, length: text == null ? 0 : text.length });
    };

    if (!SESSION_ID_RE.test(sessionId)) return refuse('missing or malformed sessionId');
    if (text == null) return refuse('missing text');
    if (text.length === 0) return refuse('empty text');
    if (text.length > MAX_CHAT_TEXT) {
      return refuse(`text too long (${text.length} > ${MAX_CHAT_TEXT} chars) -- send it in parts`);
    }

    this.log(`ext: chat from ${sessionId} (${text.length} chars)`);
    this.emit('chat', { sessionId, text, ts });
  }

  /** Agent's reply, pushed down the panel socket (SIDEPANEL-SPEC.md B/C). */
  sendChat({ text, sessionId, role = 'assistant', ts = Date.now() } = {}) {
    const frame = { type: 'chat', role, text, ts };
    if (sessionId) frame.sessionId = sessionId;
    return this.notify(frame);
  }

  /**
   * Send a request and await its answer. Callers MUST have passed the chokepoint
   * first -- this method does no screening of its own by design: one gate, and it
   * lives above this lane so no provider swap can route around it.
   */
  request({ type = 'req', method, params, tabId, timeoutMs = COMMAND_TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('no extension connected'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method || type}`));
      }, timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, type, method, params: params || {}, tabId }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Fire-and-forget (lease-lost, ping). */
  notify(frame) {
    if (!this.isConnected()) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  _failAllPending(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }

  // Doubles as the MV3 keepalive: Chrome 116+ resets the service-worker idle
  // timer on WebSocket activity, so this traffic is what keeps the executor
  // from being torn down at ~30s.
  _beat() {
    if (!this.isConnected()) return;
    if (this.info && !this.info.alive) {
      this.log('ext: heartbeat missed, terminating');
      try { this.ws.terminate(); } catch { /* noop */ }
      return;
    }
    if (this.info) this.info.alive = false;
    this.notify({ type: 'ping', ts: Date.now() });
  }

  close() {
    clearInterval(this.heartbeat);
    this._failAllPending('relay shutting down');
    try { this.ws?.close(1001, 'relay shutting down'); } catch { /* noop */ }
    this.server.close();
  }
}

module.exports = {
  ExtLane, SUBPROTOCOL, EXT_PATH, HEARTBEAT_MS, COMMAND_TIMEOUT_MS, tokenMatches,
  MAX_CHAT_TEXT, SESSION_ID_RE,
};
