'use strict';
/*
 * ConnectionProvider -- the migration seam (protocol layer 3).
 *
 * Callers never learn where the browser actually lives. They ask a provider for
 * a LEASE and attach to `lease.cdpUrl`. Today that resolves to the local relay;
 * later a ConnectorProvider can resolve it to a platform-brokered endpoint, and
 * no call site changes.
 *
 * A lease, not a bare endpoint, because access to the owner's real browser must
 * be time-boxed and revocable even if a caller forgets to clean up.
 *
 * NOTE: the safety guard deliberately does NOT live here. It sits below, at the
 * relay's single CDP chokepoint, so that swapping providers cannot bypass it.
 */

class ConnectionProvider {
  /* eslint-disable no-unused-vars */

  /**
   * @param {{ttl?: number, tabId?: string|number}} [opts]
   * @returns {Promise<{
   *   leaseId: string, cdpUrl: string, ttl: number, expiresAt: string,
   *   renew: (ttl?: number) => Promise<object>,
   *   revoke: () => Promise<boolean>,
   *   isExpired: () => boolean,
   * }>}
   */
  async acquire(opts) {
    throw new Error('acquire() not implemented');
  }

  /** @returns {Promise<object>} transport health, provider-specific shape. */
  async status() {
    throw new Error('status() not implemented');
  }

  /** Human-readable provider name, for logs and /status. */
  get name() {
    return this.constructor.name;
  }
}

module.exports = { ConnectionProvider };
