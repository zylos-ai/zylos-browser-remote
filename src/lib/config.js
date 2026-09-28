"use strict";
// Component configuration: ~/zylos/components/browser-remote/config.json
//
// Resolution order for every setting, highest first:
//   1. an explicit argument passed by the caller (tests, embedders)
//   2. the environment variable, parsed exactly as it always has been
//   3. config.json in the component data directory
//   4. the built-in default
//
// Environment keeps precedence on purpose: pm2/ecosystem and one-off shell
// runs must stay able to override a file they cannot see. A component with no
// config.json therefore behaves exactly as it did before this file existed.
//
// Ports are deliberately NOT settable here -- see PORTS_ARE_ENV_ONLY below.
//
// CommonJS on purpose: package.json declares "type": "commonjs".

const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = path.join(
  os.homedir(),
  "zylos",
  "components",
  "browser-remote",
);
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

// The extension port is baked into SKILL.md `http_routes` (Caddy proxies to
// 127.0.0.1:3802) and the agent port is baked into every CLI client in
// scripts/. A config.json that moved either one would leave those pointing at
// the old port and break the component silently, so both stay environment-only
// where a single export reaches the service and its clients together.
const PORTS_ARE_ENV_ONLY = true;

// Built-in defaults. Keys absent here are rejected when read from config.json,
// so a typo cannot silently do nothing.
const DEFAULT_CONFIG = {
  // Stream agent activity to connected panels. Off means panels still work,
  // they just stop receiving the live run feed.
  activityEnabled: true,
  // Structured run trace, for debugging only.
  monitor: false,
  // Where the trace is written. null = the Monitor default.
  monitorFile: null,
  // Directory the trace watches for agent-side sessions. null = disabled.
  agentMonitorDir: null,
};

const SETTINGS = {
  activityEnabled: {
    env: "BROWSER_REMOTE_ACTIVITY",
    // Historical semantics: any value other than "0" enables.
    parseEnv: (raw) => raw !== "0",
    valid: (value) => typeof value === "boolean",
    expected: "a boolean",
  },
  monitor: {
    env: "BROWSER_REMOTE_MONITOR",
    // Historical semantics: only "1" enables.
    parseEnv: (raw) => raw === "1",
    valid: (value) => typeof value === "boolean",
    expected: "a boolean",
  },
  monitorFile: {
    env: "BROWSER_REMOTE_MONITOR_FILE",
    parseEnv: (raw) => raw,
    valid: (value) => value === null || (typeof value === "string" && value !== ""),
    expected: "a non-empty string or null",
  },
  agentMonitorDir: {
    env: "BROWSER_REMOTE_MONITOR_AGENT_DIR",
    parseEnv: (raw) => raw,
    valid: (value) => value === null || (typeof value === "string" && value !== ""),
    expected: "a non-empty string or null",
  },
};

let cached = null;

function warn(message) {
  console.warn(`[browser-remote] config: ${message}`);
}

/**
 * Read and validate config.json. A missing file is the normal case, not an
 * error. A malformed file is loud but never fatal: the service must still come
 * up on defaults rather than leave the owner with no transport at all.
 *
 * @returns {Object} validated settings, defaults filled in
 */
function loadConfig() {
  const config = { ...DEFAULT_CONFIG };
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      warn(`cannot read ${CONFIG_PATH} (${err.message}); using defaults`);
    }
    cached = config;
    return cached;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`${CONFIG_PATH} is not valid JSON (${err.message}); using defaults`);
    cached = config;
    return cached;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`${CONFIG_PATH} must contain a JSON object; using defaults`);
    cached = config;
    return cached;
  }

  for (const [key, value] of Object.entries(parsed)) {
    const spec = SETTINGS[key];
    // `enabled` is written by hooks/configure.js as a marker; other unknown
    // keys are almost always typos. Neither is silently honoured.
    if (!spec) continue;
    if (!spec.valid(value)) {
      warn(`ignoring ${key}: expected ${spec.expected}`);
      continue;
    }
    config[key] = value;
  }

  cached = config;
  return cached;
}

/**
 * @returns {Object} the cached configuration, loading it on first use
 */
function getConfig() {
  return cached || loadConfig();
}

/** Drop the cache so the next read hits disk again. Used by tests. */
function resetConfigCache() {
  cached = null;
}

/**
 * Resolve one setting across environment, config.json and the built-in
 * default, in that order.
 *
 * @param {string} name key of SETTINGS
 * @returns {*} the resolved value
 */
function setting(name) {
  const spec = SETTINGS[name];
  if (!spec) throw new Error(`unknown setting ${name}`);
  const raw = process.env[spec.env];
  if (raw !== undefined) return spec.parseEnv(raw);
  return getConfig()[name];
}

module.exports = {
  DATA_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  SETTINGS,
  PORTS_ARE_ENV_ONLY,
  loadConfig,
  getConfig,
  resetConfigCache,
  setting,
};
