#!/usr/bin/env node
/**
 * Pre-upgrade hook for zylos-browser-remote
 *
 * Called by zylos BEFORE the upgrade steps run.
 * Exit non-zero to abort the upgrade.
 *
 * Backs up keys.json, the one file whose loss cannot be undone: keys are
 * stored as sha256 digests, so a lost keys.json cannot be reconstructed
 * and every connected extension must be re-paired by hand.
 *
 * CommonJS on purpose: package.json declares "type": "commonjs".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), 'zylos/components/browser-remote');
const keysPath = path.join(DATA_DIR, 'keys.json');

console.log('[pre-upgrade] Running browser-remote pre-upgrade checks...');

if (fs.existsSync(keysPath)) {
  const backupPath = keysPath + '.backup';
  fs.copyFileSync(keysPath, backupPath);
  // copyFileSync does not carry the source mode across, and this file is
  // a credential store.
  fs.chmodSync(backupPath, 0o600);
  console.log('[pre-upgrade] Connection keys backed up to:', backupPath);
} else {
  console.log('[pre-upgrade] No keys.json yet, nothing to back up.');
}

console.log('[pre-upgrade] Checks passed, proceeding with upgrade.');
