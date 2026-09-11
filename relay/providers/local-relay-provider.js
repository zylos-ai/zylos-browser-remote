'use strict';
/*
 * LocalRelayProvider -- talks to the relay in this repo over its loopback agent
 * lane (default http://127.0.0.1:3803). This is the only provider that exists
 * today; ConnectorProvider comes later and must satisfy the same contract.
 *
 * Deliberately HTTP rather than an in-process import: the agent usually runs in
 * a different process from the relay, and going through the same endpoints the
 * relay actually exposes keeps this honest -- if the HTTP surface breaks, the
 * provider breaks with it instead of papering over the gap.
 */

const { ConnectionProvider } = require('./connection-provider');

const DEFAULT_BASE = 'http://127.0.0.1:3803';

class LocalRelayProvider extends ConnectionProvider {
  constructor({ baseUrl = process.env.BROWSER_REMOTE_AGENT_URL || DEFAULT_BASE, fetchImpl = globalThis.fetch } = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    if (typeof this.fetch !== 'function') {
      throw new Error('no fetch available; pass fetchImpl (Node >=18 has global fetch)');
    }
  }

  get name() {
    return `LocalRelayProvider(${this.baseUrl})`;
  }

  async _call(method, path, body) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`relay returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(json.error || `relay returned ${res.status}`);
    return json;
  }

  async acquire({ ttl, tabId } = {}) {
    const raw = await this._call('POST', '/lease', { ttl, tabId });
    return this._wrap(raw);
  }

  async status() {
    return this._call('GET', '/status');
  }

  _wrap(raw) {
    const provider = this;
    const expiresAtMs = Date.parse(raw.expiresAt);
    return {
      leaseId: raw.leaseId,
      cdpUrl: raw.cdpUrl,
      tabId: raw.tabId,
      ttl: raw.ttl,
      expiresAt: raw.expiresAt,
      isExpired: () => Date.now() >= expiresAtMs,
      renew: async (newTtl) => {
        const next = await provider._call('POST', `/lease/${raw.leaseId}/renew`, { ttl: newTtl });
        return provider._wrap(next);
      },
      revoke: async () => {
        const out = await provider._call('DELETE', `/lease/${raw.leaseId}`);
        return Boolean(out.ok);
      },
    };
  }
}

module.exports = { LocalRelayProvider, DEFAULT_BASE };
