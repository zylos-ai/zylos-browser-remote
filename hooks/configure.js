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
 * spec conformance and as the correct landing spot if a required setting is
 * ever added. It still writes nothing when handed empty input: config.json is
 * optional, and src/lib/config.js falls back to built-in defaults when the
 * file is absent, so an empty one would only be noise.
 *
 * Optional settings ARE read at runtime -- see src/lib/config.js for the
 * accepted keys (activityEnabled, monitor, monitorFile, agentMonitorDir) and
 * for why ports are environment-only. Those are owner-edited, not collected
 * here, because zylos only prompts for `config.required` items.
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
