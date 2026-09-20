'use strict';
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
 * The file is re-read on every handshake so `key.js new` / `key.js revoke`
 * take effect without a restart.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
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
  return { keyId, label: entry.label || '' };
}

/** Mint a key. Returns the plaintext ONCE; only the digest is persisted. */
function newKey({ label = '', file = keysFile() } = {}) {
  const key = crypto.randomBytes(32).toString('hex');
  const keyId = keyIdOf(key);
  const keys = loadKeysFromFileOnly(file);
  keys[keyId] = { sha256: digest(key), label, createdAt: new Date().toISOString() };
  saveKeys(keys, file);
  return { key, keyId, label };
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
  return Object.entries(keys).map(([keyId, v]) => ({ keyId, label: v.label || '', createdAt: v.createdAt || null }));
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

module.exports = {
  DEFAULT_KEYS_FILE, KEY_ID_LEN, keysFile, keyIdOf, digest,
  loadKeys, saveKeys, verifyKey, newKey, revokeKey, listKeys,
};
