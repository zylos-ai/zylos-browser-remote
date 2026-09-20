#!/usr/bin/env node
/**
 * Configure hook for zylos-browser-remote
 *
 * Contract (COMPONENT-SPEC §5.2): reads a JSON object on stdin keyed by the
 * SKILL.md `config.required` item names, non-interactive, component owns
 * storage.
 *
 * NOTE: browser-remote declares no `config.required` items today, so zylos
 * has nothing to collect and this hook is a no-op in practice. It exists for
 * spec conformance and as the correct landing spot if a setting is ever
 * added. It is deliberately written to do nothing visible when handed empty
 * input rather than leaving an empty config.json that no code reads.
 *
 * Connection keys are NOT configuration: they are minted on demand by
 * scripts/key.js and stored as sha256 digests in keys.json.
 *
 * CommonJS on purpose: package.json declares "type": "commonjs".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), 'zylos/components/browser-remote/config.json');

function readStdin() {
  return new Promise((resolve, reject) => {
    // No piped stdin at all (hook run by hand): treat as empty, not an error.
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

(async () => {
  const raw = (await readStdin()).trim();

  if (!raw) {
    console.log('[configure] No configuration to store.');
    return;
  }

  let collected;
  try {
    collected = JSON.parse(raw);
  } catch (err) {
    // Exit non-zero on invalid input, per spec.
    console.error('[configure] Invalid JSON on stdin:', err.message);
    process.exit(1);
  }

  if (!collected || typeof collected !== 'object' || Array.isArray(collected)) {
    console.error('[configure] Expected a JSON object on stdin.');
    process.exit(1);
  }

  const keys = Object.keys(collected);
  if (keys.length === 0) {
    console.log('[configure] No configuration to store.');
    return;
  }

  const config = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : { enabled: true };

  for (const [key, value] of Object.entries(collected)) {
    config[key.toLowerCase()] = value;
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  // Names only — a value could be a secret.
  console.log(`[configure] Stored ${keys.length} setting(s): ${keys.join(', ')}`);
  console.log('[configure] Complete!');
})().catch((err) => {
  console.error('[configure] Failed:', err.message);
  process.exit(1);
});
