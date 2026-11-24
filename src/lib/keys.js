/*
 * Extension keys.
 *
 * A key is the ONLY thing an extension needs to join: `relayUrl + key`. The
 * relay never stores the key itself, only sha256(key); the first 12 hex chars
 * of that digest are the `keyId`, the authentication namespace. Browsers in
 * that namespace identify their installation in hello; their reply address
 * is keyId.browserId. The browser ID is not a separate credential.
 *
 *   keys.json  { "<keyId>": { "sha256": "<64 hex>", "label": "bobo-mac", "createdAt": "..." } }
 *
 * Keys minted for a Workspace connection carry optional policy fields:
 *   connectionId    the Workspace connection the key belongs to (informational)
 *   ttlMs/expiresAt sliding expiry: the key stops verifying at expiresAt, and
 *                   every successful handshake pushes expiresAt to now + ttlMs
 *   singleBrowser   the first browser instance to complete hello is recorded
 *                   as boundBrowserId; any other instance is refused
 * Keys without these fields behave exactly as before.
 *
 * The file is re-read on every handshake so `key.js new` / `key.js revoke`
 * take effect without a restart.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const DEFAULT_KEYS_FILE = path.join(os.homedir(), 'zylos', 'components', 'browser-remote', 'keys.json');
const KEY_ID_LEN = 12;

function keysFile() {
  return process.env.BROWSER_REMOTE_KEYS_FILE || DEFAULT_KEYS_FILE;
}

function digest(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function keyIdOf(key) {
  return digest(key).slice(0, KEY_ID_LEN);
}

function loadKeys(file = keysFile()) {
  // BROWSER_REMOTE_KEY is the single-key shortcut for dev and tests.
  if (process.env.BROWSER_REMOTE_KEY) {
    const k = process.env.BROWSER_REMOTE_KEY.trim();
    return { [keyIdOf(k)]: { sha256: digest(k), label: 'env' } };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: expected an object keyed by keyId`);
  }
  return parsed;
}

function saveKeys(keys, file = keysFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Handshakes now write too (binding, expiry renewal), so a reader must never
  // see a half-written file: write a sibling and rename over the original.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isExpired(entry, now = Date.now()) {
  if (!entry || !entry.expiresAt) return false;
  const t = Date.parse(entry.expiresAt);
  return !Number.isFinite(t) || t <= now;
}

/**
 * Verify a presented key. Lookup is by keyId (derived from the presented key,
 * so an unknown key just misses); the full digest is then compared in constant
 * time so the 12-char prefix cannot be used as an oracle.
 * @returns {{keyId: string, label: string}|null}
 */
function verifyKey(presented, keys = loadKeys()) {
  if (typeof presented !== 'string' || presented.length < 16) return null;
  const keyId = keyIdOf(presented);
  const entry = keys[keyId];
  if (!entry || typeof entry.sha256 !== 'string' || entry.sha256.length !== 64) return null;
  const a = Buffer.from(entry.sha256, 'hex');
  const b = Buffer.from(digest(presented), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (isExpired(entry)) return null;
  return {
    keyId,
    label: entry.label || '',
    singleBrowser: entry.singleBrowser === true,
    connectionId: typeof entry.connectionId === 'string' ? entry.connectionId : null,
    boundBrowserId: entry.boundBrowserId || null,
  };
}

/** Mint a key. Returns the plaintext ONCE; only the digest is persisted. */
function newKey({ label = '', connectionId, ttlMs, singleBrowser = false, file = keysFile() } = {}) {
  const key = crypto.randomBytes(32).toString('hex');
  const keyId = keyIdOf(key);
  const keys = loadKeysFromFileOnly(file);
  const now = Date.now();
  const entry = { sha256: digest(key), label, createdAt: new Date(now).toISOString() };
  if (connectionId) entry.connectionId = String(connectionId);
  if (ttlMs) {
    entry.ttlMs = ttlMs;
    entry.expiresAt = new Date(now + ttlMs).toISOString();
  }
  if (singleBrowser) entry.singleBrowser = true;
  keys[keyId] = entry;
  saveKeys(keys, file);
  return { key, keyId, label, connectionId: entry.connectionId || null, expiresAt: entry.expiresAt || null };
}

// Renewal writes at most this often per key, so a reconnect loop cannot turn
// into a write per handshake.
const RENEW_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Called once a browser instance has passed hello. Records the binding of a
 * single-browser key and renews a sliding expiry. Reads the file fresh, so the
 * first of two racing instances wins and the second sees the binding.
 * @returns {{ok: true}|{ok: false, reason: 'bound'|'expired'}}
 */
function touchKey(keyId, browserId, { file = keysFile(), now = Date.now() } = {}) {
  const keys = loadKeysFromFileOnly(file);
  const entry = keys[keyId];
  // Not in the file: the env shortcut key (no policy), or a key revoked since
  // upgrade, which the next heartbeat closes. Policy keys always live here.
  if (!entry) return { ok: true };
  if (isExpired(entry, now)) return { ok: false, reason: 'expired' };
  let dirty = false;
  if (entry.singleBrowser) {
    if (!browserId) return { ok: false, reason: 'bound' };
    if (entry.boundBrowserId && entry.boundBrowserId !== browserId) return { ok: false, reason: 'bound' };
    if (!entry.boundBrowserId) {
      entry.boundBrowserId = browserId;
      entry.boundAt = new Date(now).toISOString();
      dirty = true;
    }
  }
  if (entry.ttlMs) {
    const next = now + entry.ttlMs;
    if (next - Date.parse(entry.expiresAt) >= RENEW_MIN_INTERVAL_MS) {
      entry.expiresAt = new Date(next).toISOString();
      dirty = true;
    }
  }
  if (dirty) saveKeys(keys, file);
  return { ok: true };
}

function revokeKey(keyId, file = keysFile()) {
  const keys = loadKeysFromFileOnly(file);
  if (!keys[keyId]) return false;
  delete keys[keyId];
  saveKeys(keys, file);
  return true;
}

function listKeys(file = keysFile()) {
  const keys = loadKeysFromFileOnly(file);
  return Object.entries(keys).map(([keyId, v]) => ({
    keyId,
    label: v.label || '',
    createdAt: v.createdAt || null,
    connectionId: v.connectionId || null,
    expiresAt: v.expiresAt || null,
    expired: isExpired(v),
    singleBrowser: v.singleBrowser === true,
    boundBrowserId: v.boundBrowserId || null,
  }));
}

// Management commands must not be fooled by the env shortcut.
function loadKeysFromFileOnly(file) {
  const saved = process.env.BROWSER_REMOTE_KEY;
  delete process.env.BROWSER_REMOTE_KEY;
  try {
    return loadKeys(file);
  } finally {
    if (saved !== undefined) process.env.BROWSER_REMOTE_KEY = saved;
  }
}

export {
  DEFAULT_KEYS_FILE,
  KEY_ID_LEN,
  keysFile,
  keyIdOf,
  digest,
  loadKeys,
  saveKeys,
  verifyKey,
  isExpired,
  newKey,
  touchKey,
  revokeKey,
  listKeys,
};