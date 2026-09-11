'use strict';
/*
 * Leases.
 *
 * A lease is a time-boxed grant to drive the owner's browser. It exists so that
 * "the agent is attached" is an explicit, expiring, revocable fact rather than
 * an implicit consequence of a socket being open. If this process leaks a
 * connection, or a future ConnectorProvider hands out an endpoint, the TTL still
 * closes the window.
 *
 * P0 is single-owner/single-tab, so there is at most ONE active lease. Acquiring
 * while another lease is live is refused rather than silently superseded --
 * two agents fighting over one real browser is worse than one agent being told no.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const SWEEP_MS = 5_000;

class Lease {
  constructor(manager, { ttl, tabId }) {
    this.manager = manager;
    this.leaseId = crypto.randomBytes(12).toString('hex');
    this.tabId = tabId ?? null;
    this.createdAt = Date.now();
    this.ttl = clampTtl(ttl);
    this.expiresAt = this.createdAt + this.ttl;
    this.revokedAt = null;
  }

  isExpired(now = Date.now()) {
    return this.revokedAt !== null || now >= this.expiresAt;
  }

  renew(ttl) {
    if (this.isExpired()) throw new Error(`lease ${this.leaseId} is no longer active`);
    this.ttl = clampTtl(ttl ?? this.ttl);
    this.expiresAt = Date.now() + this.ttl;
    this.manager.emit('renewed', this);
    return this;
  }

  revoke(reason = 'revoked') {
    return this.manager.revoke(this.leaseId, reason);
  }

  toJSON() {
    return {
      leaseId: this.leaseId,
      tabId: this.tabId,
      ttl: this.ttl,
      createdAt: new Date(this.createdAt).toISOString(),
      expiresAt: new Date(this.expiresAt).toISOString(),
      expiresInMs: Math.max(0, this.expiresAt - Date.now()),
    };
  }
}

function clampTtl(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return Math.min(Math.floor(n), MAX_TTL_MS);
}

class LeaseManager extends EventEmitter {
  constructor({ sweepMs = SWEEP_MS } = {}) {
    super();
    this.leases = new Map();
    // unref: a sweep timer must never be the reason this process stays alive.
    this.timer = setInterval(() => this.sweep(), sweepMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** @returns {Lease} @throws when another lease is still active */
  acquire({ ttl, tabId } = {}) {
    const active = this.active();
    if (active) {
      throw new Error(
        `a lease is already active (${active.leaseId}, expires ${new Date(active.expiresAt).toISOString()}); ` +
        'revoke it first',
      );
    }
    const lease = new Lease(this, { ttl, tabId });
    this.leases.set(lease.leaseId, lease);
    this.emit('acquired', lease);
    return lease;
  }

  /** The live lease, or null. Expired ones are treated as absent. */
  active() {
    for (const lease of this.leases.values()) {
      if (!lease.isExpired()) return lease;
    }
    return null;
  }

  /** Strict lookup: returns the lease ONLY if it is still valid. */
  get(leaseId) {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.isExpired()) return null;
    return lease;
  }

  renew(leaseId, ttl) {
    const lease = this.get(leaseId);
    if (!lease) return null;
    return lease.renew(ttl);
  }

  revoke(leaseId, reason = 'revoked') {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.revokedAt) return false;
    lease.revokedAt = Date.now();
    this.leases.delete(leaseId);
    this.emit('closed', lease, reason);
    return true;
  }

  sweep(now = Date.now()) {
    for (const lease of [...this.leases.values()]) {
      if (lease.isExpired(now)) {
        this.leases.delete(lease.leaseId);
        this.emit('closed', lease, 'expired');
      }
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { LeaseManager, Lease, DEFAULT_TTL_MS, MAX_TTL_MS };
