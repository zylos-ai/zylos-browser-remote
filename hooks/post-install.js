#!/usr/bin/env node
/**
 * Post-install hook for zylos-browser-remote
 *
 * Called by zylos after installation completes.
 * CLI handles: file sync, npm install, manifest, PM2 registration.
 *
 * This hook only prepares the data directory. It deliberately does NOT
 * create a config.json: this component keeps no install-time settings.
 * Its only persistent state is keys.json, which is minted on demand by
 * scripts/key.js and must never be generated automatically — an
 * unrequested key is a credential nobody asked for.
 *
 * CommonJS on purpose: package.json declares "type": "commonjs".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), 'zylos/components/browser-remote');

// 0700 throughout: keys.json holds connection secrets and observations/
// holds page captures from the owner's browser. Neither is group-readable.
const DIRS = [DATA_DIR, path.join(DATA_DIR, 'logs'), path.join(DATA_DIR, 'observations')];

for (const dir of DIRS) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// A pre-existing directory keeps its old mode through mkdirSync, so tighten
// explicitly — an upgrade from a version that created these as 0755 would
// otherwise silently stay world-readable.
for (const dir of DIRS) {
  fs.chmodSync(dir, 0o700);
}

console.log('[post-install] Data directory ready:', DATA_DIR);
console.log('[post-install] Next: mint a connection key for the browser extension:');
console.log('[post-install]   node ~/zylos/.claude/skills/browser-remote/scripts/key.js new --label owner-browser');
console.log('[post-install] The full key is shown once and stored only as a sha256 digest.');
console.log('[post-install] Complete!');
