'use strict';
/*
 * Agent lane -- :3803, LOOPBACK ONLY, never routed by Caddy.
 *
 * This is the surface the agent drives: a small imitation of Chrome's DevTools
 * HTTP endpoints plus a real CDP WebSocket, so a stock CDP client attaches
 * without special-casing (`zylos-browser` only has to accept a URL instead of a
 * bare port number).
 *
 *   GET  /json/version              Chrome-shaped version blob
 *   GET  /json , /json/list         one page target per active lease
 *   GET  /status                    relay health
 *   POST /chat                      agent -> side panel chat bubble
 *   POST /lease                     acquire  -> {leaseId, cdpUrl, ttl, expiresAt}
 *   POST /lease/<id>/renew          extend
 *   DEL  /lease/<id>                revoke
 *   WS   /devtools/page/<leaseId>   the CDP socket
 *
 * Binding here to anything but 127.0.0.1 hands browser control to the network.
 * The bind address is not configurable for that reason.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const chokepoint = require('./chokepoint');
const { MAX_CHAT_TEXT, SESSION_ID_RE } = require('./ext-lane');

const BIND = '127.0.0.1';
const DEVTOOLS_PREFIX = '/devtools/page/';

// POST /chat carries one chat bubble, nothing else. 64 KiB is ~8x the accepted
// text cap, so a legitimate body never trips it and a runaway one dies early
// instead of being buffered.
const CHAT_BODY_LIMIT_BYTES = 64 * 1024;

// CDP error codes. -32601 is JSON-RPC "method not found", which is what a client
// expects when a method is unavailable; refusals by policy are server errors.
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_REFUSED = -32000;
const ERR_UPSTREAM = -32001;

class AgentLane {
  constructor({ extLane, leases, port, log = () => {} }) {
    this.ext = extLane;
    this.leases = leases;
    this.port = port;
    this.log = log;
    this.idem = new chokepoint.IdempotencyCache();
    this.sockets = new Map();     // leaseId -> agent WebSocket

    this.server = http.createServer((req, res) => this._onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));

    // A lease ending must tear down the browser side too, not just the socket:
    // the extension keeps chrome.debugger attached until told otherwise.
    this.leases.on('closed', (lease, reason) => this._onLeaseClosed(lease, reason));

    // CDP events flow the other way, straight to whoever holds the lease.
    this.ext.on('event', (frame) => this._fanoutEvent(frame));
    this.ext.on('disconnected', () => {
      for (const [leaseId] of this.sockets) {
        this._closeAgentSocket(leaseId, 4004, 'extension disconnected');
      }
    });
  }

  listen() {
    return new Promise((resolve) => this.server.listen(this.port, BIND, resolve));
  }

  cdpUrl(leaseId) {
    return `ws://${BIND}:${this.port}${DEVTOOLS_PREFIX}${leaseId}`;
  }

  // ---------------------------------------------------------------- HTTP

  async _onHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(obj, null, 2));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/json/version') {
        return reply(200, {
          Browser: 'zylos-browser-remote/0.1.0',
          'Protocol-Version': '1.3',
          'User-Agent': 'zylos-browser-remote relay (owner Chrome via MV3 extension)',
          'V8-Version': '0.0',
          'WebKit-Version': '0.0',
        });
      }

      if (req.method === 'GET' && (url.pathname === '/json' || url.pathname === '/json/list')) {
        return reply(200, this._targets());
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        const active = this.leases.active();
        return reply(200, {
          ok: true,
          extension: this.ext.status(),
          lease: active ? active.toJSON() : null,
          agentAttached: this.sockets.size,
          idempotencyCached: this.idem.size,
        });
      }

      // Egress half of the side-panel chat (SIDEPANEL-SPEC.md C). It lives HERE,
      // on the loopback lane, and must never be added to :3802: that port is
      // routed by Caddy, and an unauthenticated /chat there would let anyone who
      // learns the public URL put words in the agent's mouth inside the owner's
      // panel.
      if (req.method === 'POST' && url.pathname === '/chat') {
        let body;
        try {
          body = await readJson(req, CHAT_BODY_LIMIT_BYTES);
        } catch (err) {
          const tooBig = /too large/.test(err.message);
          return reply(tooBig ? 413 : 400, { ok: false, error: err.message });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return reply(400, { ok: false, error: 'body must be a JSON object' });
        }
        const text = body.text;
        if (typeof text !== 'string' || text === '') {
          return reply(400, { ok: false, error: 'text must be a non-empty string' });
        }
        if (text.length > MAX_CHAT_TEXT) {
          return reply(400, { ok: false, error: `text too long (${text.length} > ${MAX_CHAT_TEXT} chars)` });
        }
        const sessionId = body.sessionId === undefined || body.sessionId === null ? '' : body.sessionId;
        if (sessionId !== '' && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) {
          return reply(400, { ok: false, error: 'malformed sessionId' });
        }
        if (!this.ext.isConnected()) {
          return reply(503, { ok: false, error: 'extension not connected' });
        }
        // Default = the connected panel: one extension socket, so an omitted
        // sessionId is unambiguous.
        const delivered = this.ext.sendChat({ text, sessionId: sessionId || undefined });
        if (!delivered) {
          // Lost the socket between the check above and the send.
          return reply(503, { ok: false, error: 'extension not connected' });
        }
        this.log(`chat -> panel (${text.length} chars${sessionId ? `, session ${sessionId}` : ''})`);
        return reply(200, { ok: true, delivered: true });
      }

      if (req.method === 'POST' && url.pathname === '/lease') {
        const body = await readJson(req);
        if (!this.ext.isConnected()) {
          return reply(503, { ok: false, error: 'no extension connected' });
        }
        let lease;
        try {
          lease = this.leases.acquire({ ttl: body.ttl, tabId: body.tabId ?? this._defaultTabId() });
        } catch (err) {
          return reply(409, { ok: false, error: err.message });
        }
        this.log(`lease ${lease.leaseId} acquired (tab ${lease.tabId}, ttl ${lease.ttl}ms)`);
        return reply(200, { ok: true, ...lease.toJSON(), cdpUrl: this.cdpUrl(lease.leaseId) });
      }

      const renew = /^\/lease\/([a-f0-9]+)\/renew$/.exec(url.pathname);
      if (req.method === 'POST' && renew) {
        const body = await readJson(req);
        const lease = this.leases.renew(renew[1], body.ttl);
        if (!lease) return reply(404, { ok: false, error: 'no such active lease' });
        return reply(200, { ok: true, ...lease.toJSON(), cdpUrl: this.cdpUrl(lease.leaseId) });
      }

      const revoke = /^\/lease\/([a-f0-9]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && revoke) {
        const ok = this.leases.revoke(revoke[1], 'revoked by agent');
        return reply(ok ? 200 : 404, { ok, error: ok ? undefined : 'no such active lease' });
      }

      return reply(404, { ok: false, error: 'not found' });
    } catch (err) {
      return reply(500, { ok: false, error: err.message });
    }
  }

  _defaultTabId() {
    return this.ext.tabs.length ? this.ext.tabs[0].id : null;
  }

  /**
   * Chrome-shaped target list. When nothing holds a lease but a browser is
   * available, one is minted here so a stock client that only knows
   * /json/list -> webSocketDebuggerUrl works unmodified. That shortcut is only
   * defensible because this lane is loopback-only.
   *
   * A connected extension with ZERO reported tabs is a real, useful state under
   * the session model: the agent connects first and calls `_br.openTarget` to
   * create the tab. So the lease is still minted -- returning [] here would
   * break that flow before it starts. What is NOT acceptable is the old
   * pretence that the session was already driving a page: a phantom
   * `"remote tab" @ about:blank` reads as a real target, and a caller that
   * screenshots it gets nothing with no way to tell why. Hence `zylosHasTab`,
   * plus a title that says so in words.
   */
  _targets() {
    if (!this.ext.isConnected()) return [];
    let lease = this.leases.active();
    if (!lease) {
      lease = this.leases.acquire({ tabId: this._defaultTabId() });
      this.log(`lease ${lease.leaseId} auto-acquired via /json/list`);
    }
    const tab = this.ext.tabs.find((t) => String(t.id) === String(lease.tabId)) || this.ext.tabs[0] || null;
    const hasTab = Boolean(tab && tab.url);
    const expires = new Date(lease.expiresAt).toISOString();
    return [{
      id: lease.leaseId,
      type: 'page',
      title: hasTab ? (tab.title || 'remote tab') : 'Zylos session (no tab yet)',
      url: hasTab ? tab.url : 'about:blank',
      description: hasTab
        ? `lease expires ${expires}`
        : `session ready, no tab yet -- call _br.openTarget; lease expires ${expires}`,
      // Non-standard, deliberately prefixed: a caller can distinguish
      // "session ready, no tab" from "session driving a real page" without
      // guessing from the url.
      zylosHasTab: hasTab,
      zylosTabId: hasTab ? (tab.id ?? null) : null,
      webSocketDebuggerUrl: this.cdpUrl(lease.leaseId),
      devtoolsFrontendUrl: '',
    }];
  }

  // ---------------------------------------------------------------- WS

  _onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(DEVTOOLS_PREFIX)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const leaseId = url.pathname.slice(DEVTOOLS_PREFIX.length);
    const lease = this.leases.get(leaseId);
    if (!lease) {
      socket.write('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this._onAgentConnected(ws, lease));
  }

  async _onAgentConnected(ws, lease) {
    const prev = this.sockets.get(lease.leaseId);
    if (prev) { try { prev.close(4005, 'superseded'); } catch { /* gone */ } }
    this.sockets.set(lease.leaseId, ws);
    this.log(`agent attached to lease ${lease.leaseId}`);

    // Listen BEFORE the handshake, not after. A client that connects and sends
    // immediately is doing nothing wrong, but its frames arrive while the
    // attach below is still in flight -- and a handler registered afterwards
    // never sees them. They are not queued by ws and not replayed: they are
    // dropped with no response, no error and no log line, which is
    // indistinguishable from a dead extension and took a live debugging
    // session to track down. So buffer here and drain once attached.
    let pendingFrames = [];
    let attached = false;
    ws.on('message', (raw) => {
      if (attached) this._onAgentFrame(ws, lease, raw);
      else pendingFrames.push(raw);
    });

    ws.on('close', () => {
      if (this.sockets.get(lease.leaseId) === ws) this.sockets.delete(lease.leaseId);
      this.log(`agent detached from lease ${lease.leaseId}`);
    });
    ws.on('error', (err) => this.log('agent: socket error', err.message));

    // Tell the extension to put chrome.debugger on the tab -- but ONLY if the
    // lease already names one. A tabless lease is the session model's normal
    // starting state: the agent connects first and calls `_br.openTarget` to
    // create the tab. Attaching eagerly there deadlocks the whole flow -- the
    // extension answers "no active task tab: call _br.openTarget first" (it is
    // right; there is none), we close the socket, and the agent is gone before
    // it can send the one call that would have created the tab. No site is
    // reachable, ever. Found on the first real-Chrome run; see
    // tools/test-extension.js "a tabless session must be DRIVABLE".
    //
    // Deferring costs nothing: the extension resolves the target and attaches
    // per command anyway (execute() -> resolveTarget -> ensureAttached), and
    // `_br.openTarget` attaches to the tab it opens. Nothing is ever driven
    // unattached; the attach just happens when there is something to attach to.
    if (lease.tabId != null) {
      // A failure with a named tab IS worth surfacing immediately -- the
      // alternative is every command failing later with a confusing upstream
      // error.
      try {
        await this.ext.request({ type: 'attach', tabId: lease.tabId });
      } catch (err) {
        this.log(`attach failed for lease ${lease.leaseId}: ${err.message}`);
        // Answer the buffered frames instead of dropping them, so a client that
        // spoke early learns why it failed rather than waiting out its timeout.
        for (const raw of pendingFrames) this._failFrame(ws, raw, `attach failed: ${err.message}`);
        pendingFrames = [];
        try { ws.close(4006, `attach failed: ${err.message}`); } catch { /* noop */ }
        this.sockets.delete(lease.leaseId);
        return;
      }
    } else {
      this.log(`lease ${lease.leaseId} has no tab yet; deferring attach until _br.openTarget`);
    }

    attached = true;
    const queued = pendingFrames;
    pendingFrames = [];
    for (const raw of queued) this._onAgentFrame(ws, lease, raw);
  }

  /** Reply to an unprocessed frame with an error, preserving its id. */
  _failFrame(ws, raw, message) {
    let id = 0;
    try { id = JSON.parse(raw.toString()).id ?? 0; } catch { /* keep 0 */ }
    send(ws, { id, error: { code: ERR_UPSTREAM, message } });
  }

  async _onAgentFrame(ws, lease, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { id: 0, error: { code: -32700, message: 'parse error' } });
    }
    const id = msg.id;
    const method = msg.method;
    const params = msg.params || {};

    if (lease.isExpired()) {
      send(ws, { id, error: { code: ERR_REFUSED, message: 'lease expired' } });
      this._closeAgentSocket(lease.leaseId, 4003, 'lease expired');
      return;
    }

    // Out-of-band control: CDP has no idempotency concept, so it travels as a
    // reserved param and is stripped before the frame reaches the browser.
    const idempotencyKey = params.__idempotencyKey;
    if (idempotencyKey !== undefined) delete params.__idempotencyKey;

    // ---- THE chokepoint. Allowlist, then URL guard. No other path exists. ----
    const tabUrl = this.ext.tabUrl(lease.tabId);
    const refusal = chokepoint.check({ method, params, tabUrl });
    if (refusal) {
      this.log(`REFUSED ${method}: ${refusal}`);
      const code = refusal.includes('not in the P0 allowlist') ? ERR_METHOD_NOT_FOUND : ERR_REFUSED;
      return send(ws, { id, error: { code, message: refusal } });
    }

    if (idempotencyKey && chokepoint.isMutating(method)) {
      const hit = this.idem.get(idempotencyKey);
      if (hit) {
        // An edge cutoff mid-flight makes the caller retry; without this a retry
        // would double-execute (double click, double navigate).
        return send(ws, { id, result: { ...hit, replayed: true } });
      }
    }

    try {
      const result = await this.ext.request({ method, params, tabId: lease.tabId });
      if (idempotencyKey && chokepoint.isMutating(method)) this.idem.set(idempotencyKey, result);
      send(ws, { id, result: result === undefined ? {} : result });
    } catch (err) {
      send(ws, { id, error: { code: ERR_UPSTREAM, message: err.message } });
    }
  }

  _fanoutEvent(frame) {
    const lease = this.leases.active();
    if (!lease) return;
    const ws = this.sockets.get(lease.leaseId);
    if (!ws) return;
    send(ws, { method: frame.method, params: frame.params || {} });
  }

  _onLeaseClosed(lease, reason) {
    this.log(`lease ${lease.leaseId} closed (${reason})`);
    this.ext.notify({ type: 'lease-lost', leaseId: lease.leaseId, reason });
    // Best effort: if the extension is gone this is a no-op, and it re-attaches
    // clean on the next lease anyway.
    this.ext.request({ type: 'detach', tabId: lease.tabId }).catch(() => {});
    this._closeAgentSocket(lease.leaseId, 4003, `lease ${reason}`);
  }

  _closeAgentSocket(leaseId, code, reason) {
    const ws = this.sockets.get(leaseId);
    if (!ws) return;
    this.sockets.delete(leaseId);
    try { ws.close(code, reason); } catch { /* already gone */ }
  }

  close() {
    for (const [leaseId] of this.sockets) this._closeAgentSocket(leaseId, 1001, 'relay shutting down');
    this.server.close();
  }
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
}

function readJson(req, limitBytes = 1_000_000) {
  // Past the cap the body is DRAINED, not collected, and the socket is left
  // alive so the refusal can actually be written back -- destroying the request
  // mid-upload (what this used to do) resets the connection and the caller sees
  // a socket error instead of the 413 that explains itself. A genuine flood
  // still gets cut off at the hard ceiling rather than drained forever.
  const hardKillBytes = limitBytes * 8;
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        if (!over) {
          over = true;
          chunks.length = 0;
          reject(new Error('body too large'));
        }
        if (size > hardKillBytes) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

module.exports = { AgentLane, BIND, DEVTOOLS_PREFIX, CHAT_BODY_LIMIT_BYTES };
