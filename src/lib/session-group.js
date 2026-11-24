/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * Partitioning: one session group per browser connection. The reply endpoint
 * is `<keyId>.<browserId>` (or a bare `<keyId>` from extensions that predate
 * browser instances), and the group is `browser-<endpoint>`. Every id the
 * mapping needs is in the endpoint, so the lookup needs no stored state.
 * Names are fixed once live: Core has no migration tool, so changing the
 * partitioning must be planned with Core. Core prefixes the component
 * namespace; never add it here.
 */
import { ENDPOINT_SOURCE } from "./endpoint.js";

// Core asks with the exact address the agent replies to, which for a final
// reply carries routing suffixes (`|req:<id>|status:<s>[|input:<id>]`); they
// never change the connection, so they never change the group.
const ADDRESS_RE = new RegExp(`^(${ENDPOINT_SOURCE})((?:\\|[a-z]+:[A-Za-z0-9._:-]{1,128})*)$`);

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === "string" && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

/**
 * Derive the session group for a browser connection from its reply endpoint.
 * @param {string} endpoint - `<keyId>.<browserId>` or legacy `<keyId>`, optionally
 *   followed by reply suffixes such as `|req:<id>|status:done`
 * @returns {string} Group name without namespace (never '' for this component)
 * @throws {Error} When the endpoint cannot be mapped (never falls back to the overall group)
 */
export function sessionGroupFromEndpoint(endpoint) {
  const connection = typeof endpoint === "string" ? ADDRESS_RE.exec(endpoint)?.[1] : undefined;
  if (!connection)
    throw new Error(`invalid browser endpoint ${JSON.stringify(String(endpoint).slice(0, 64))}`);
  const group = `browser-${connection}`;
  if (!isValidSessionGroup(group)) throw new Error(`session group for ${endpoint} is not Core-valid`);
  return group;
}
