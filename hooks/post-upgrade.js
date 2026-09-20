#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-browser-remote
 *
 * Called by zylos after the upgrade completes. Service restart is handled
 * by zylos after this hook returns.
 *
 * Migrations handled here:
 *  - logs/ was only created implicitly by PM2 before 0.4.0; ecosystem.config.cjs
 *    points error_file/out_file inside it, so an install upgraded from an
 *    older version can be missing it.
 *  - Data directories created by older versions may be 0755. keys.json holds
 *    connection secrets and observations/ holds captured page content, so
 *    tighten anything left permissive.
 *
 * CommonJS on purpose: package.json declares "type": "commonjs".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), 'zylos/components/browser-remote');
const DIRS = [DATA_DIR, path.join(DATA_DIR, 'logs'), path.join(DATA_DIR, 'observations')];

let migrated = false;

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    console.log('[post-upgrade] Created missing directory:', dir);
    migrated = true;
    continue;
  }
  const mode = fs.statSync(dir).mode & 0o777;
  if (mode !== 0o700) {
    fs.chmodSync(dir, 0o700);
    console.log(`[post-upgrade] Tightened ${dir} from ${mode.toString(8)} to 700`);
    migrated = true;
  }
}

// Same reasoning for the credential file itself.
const keysPath = path.join(DATA_DIR, 'keys.json');
if (fs.existsSync(keysPath)) {
  const mode = fs.statSync(keysPath).mode & 0o777;
  if (mode !== 0o600) {
    fs.chmodSync(keysPath, 0o600);
    console.log(`[post-upgrade] Tightened keys.json from ${mode.toString(8)} to 600`);
    migrated = true;
  }
}

if (!migrated) {
  console.log('[post-upgrade] Nothing to migrate.');
}

console.log('[post-upgrade] Complete!');
