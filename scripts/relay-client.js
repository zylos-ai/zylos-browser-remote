'use strict';
/*
 * Loopback client for the agent lane. Shared by send.js and browser.js.
 * Never points anywhere but 127.0.0.1: the agent lane has no auth because the
 * loopback bind IS the auth.
 */

const http = require('http');

const BASE = process.env.BROWSER_REMOTE_AGENT_URL || `http://127.0.0.1:${process.env.BROWSER_REMOTE_AGENT_PORT || 3803}`;

function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      reject(new Error(`refusing non-loopback agent lane ${url.host}`));
      return;
    }
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(b); } catch { parsed = { ok: false, code: 'BAD_RESPONSE', message: b.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        resolve({ status: 0, body: { ok: false, code: 'RELAY_DOWN', message: `relay not listening at ${BASE} (pm2 status zylos-browser-remote)` } });
      } else {
        reject(err);
      }
    });
    if (data) req.write(data);
    req.end();
  });
}

module.exports = {
  BASE,
  status: () => call('GET', '/status'),
  rpc: (body) => call('POST', '/rpc', body),
  chat: (body) => call('POST', '/chat', body),
};
