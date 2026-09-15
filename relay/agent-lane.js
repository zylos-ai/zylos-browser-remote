'use strict';
/*
 * Agent lane -- :3803, LOOPBACK ONLY, never routed by Caddy.
 *
 * The surface the agent drives. Three endpoints, no opinions:
 *
 *   POST /rpc     {endpoint?, method, params?, requestId?, timeoutMs?}
 *                 -> 200 {ok:true, result}
 *                 -> 200 {ok:false, code, message, details?}   the extension refused
 *                 -> 4xx/5xx {ok:false, code, message}         relay-level failure
 *   POST /chat    {endpoint?, text, final?}  agent -> side-panel chat bubble
 *   GET  /status  {ok, extensions:{<keyId>:{...}}}
 *
 * `method` and `params` are forwarded verbatim; the relay does not know which
 * methods exist. Which extension answers is chosen by `endpoint` (a keyId, the
 * same value C4 hands the agent as the reply endpoint); it may be omitted when
 * exactly one extension is connected.
 *
 * Binding here to anything but 127.0.0.1 hands browser control to the network.
 * The bind address is not configurable for that reason.
 */

const http = require('http');
const { MAX_CHAT_TEXT } = require('./ext-lane');

const BIND = '127.0.0.1';
const BODY_LIMIT_BYTES = 256 * 1024;   // params can carry a selector list, not a screenshot
const METHOD_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const RELAY_ERROR_STATUS = {
  EXT_OFFLINE: 503,
  EXT_TIMEOUT: 504,
  AMBIGUOUS_ENDPOINT: 400,
  BAD_ENDPOINT: 400,
  UNKNOWN_ENDPOINT: 404,
};

class AgentLane {
  constructor({ extLane, port, log = () => {} }) {
    this.ext = extLane;
    this.port = port;
    this.log = log;
    this.server = http.createServer((req, res) => this._onHttp(req, res));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(this.port, BIND, resolve));
  }

  async _onHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const reply = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(obj));
    };
    const fail = (status, code, message, extra) => reply(status, { ok: false, code, message, ...extra });

    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        return reply(200, { ok: true, extensions: this.ext.status() });
      }

      if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/chat')) {
        let body;
        try {
          body = await readJson(req, BODY_LIMIT_BYTES);
        } catch (err) {
          return fail(/too large/.test(err.message) ? 413 : 400, 'BAD_REQUEST', err.message);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return fail(400, 'BAD_REQUEST', 'body must be a JSON object');
        }
        const target = this.ext.resolve(body.endpoint);
        if (target.error) return fail(RELAY_ERROR_STATUS[target.error] || 500, target.error, target.message);

        if (url.pathname === '/chat') return this._chat(target.keyId, body, reply, fail);
        return this._rpc(target.keyId, body, reply, fail);
      }

      return fail(404, 'NOT_FOUND', 'not found');
    } catch (err) {
      return fail(500, 'INTERNAL', err.message);
    }
  }

  async _rpc(keyId, body, reply, fail) {
    const { method, params, requestId, timeoutMs } = body;
    if (typeof method !== 'string' || !METHOD_RE.test(method)) {
      return fail(400, 'BAD_REQUEST', 'method must be a short identifier');
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return fail(400, 'BAD_REQUEST', 'params must be an object when present');
    }
    if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId))) {
      return fail(400, 'BAD_REQUEST', 'requestId must match [A-Za-z0-9._:-]{1,128}');
    }
    const t0 = Date.now();
    try {
      const result = await this.ext.request(keyId, { method, params, requestId, timeoutMs });
      this.log(`rpc[${keyId}] ${method} ok (${Date.now() - t0}ms)`);
      return reply(200, { ok: true, endpoint: keyId, result: result === undefined ? null : result });
    } catch (err) {
      const code = err.code || 'EXT_ERROR';
      const relayStatus = RELAY_ERROR_STATUS[code];
      this.log(`rpc[${keyId}] ${method} FAILED ${code} (${Date.now() - t0}ms): ${err.message}`);
      // Extension-level refusals are a successful relay round trip: 200 with ok:false.
      if (relayStatus) return fail(relayStatus, code, err.message);
      return reply(200, { ok: false, endpoint: keyId, code, message: err.message, details: err.details });
    }
  }

  _chat(keyId, body, reply, fail) {
    // Egress half of the side-panel chat. It lives HERE, on the loopback lane,
    // and must never be added to :3802: that port is routed by Caddy, and an
    // unauthenticated /chat there would let anyone who learns the public URL
    // put words in the agent's mouth inside the owner's panel.
    const text = body.text;
    if (typeof text !== 'string' || text === '') {
      return fail(400, 'BAD_REQUEST', 'text must be a non-empty string');
    }
    if (text.length > MAX_CHAT_TEXT) {
      return fail(400, 'BAD_REQUEST', `text too long (${text.length} > ${MAX_CHAT_TEXT} chars)`);
    }
    if (body.final !== undefined && typeof body.final !== 'boolean') {
      return fail(400, 'BAD_REQUEST', 'final must be a boolean when present');
    }
    if (!this.ext.sendChat(keyId, { text, final: body.final ?? true })) {
      return fail(503, 'EXT_OFFLINE', 'extension not connected');
    }
    this.log(`chat[${keyId}] -> panel (${text.length} chars)`);
    return reply(200, { ok: true, endpoint: keyId, delivered: true });
  }

  close() {
    this.server.close();
  }
}

function readJson(req, limitBytes) {
  // Past the cap the body is DRAINED, not collected, and the socket is left
  // alive so the refusal can actually be written back -- destroying the request
  // mid-upload resets the connection and the caller sees a socket error instead
  // of the 413 that explains itself. A genuine flood still gets cut off.
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

module.exports = { AgentLane, BIND, BODY_LIMIT_BYTES, RELAY_ERROR_STATUS };
