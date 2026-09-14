#!/usr/bin/env node
'use strict';
/*
 * The agent's CLI for driving the owner's browser through the relay.
 *
 *   node scripts/browser.js status
 *   node scripts/browser.js [--endpoint <keyId>] [--timeout <ms>] <method> [params]
 *   node scripts/browser.js [--endpoint <keyId>] chat <text>
 *
 * `params` is either one JSON object argument or key=value pairs (values that
 * parse as JSON are parsed, otherwise kept as strings):
 *
 *   browser.js navigate url=https://example.com
 *   browser.js click '{"ref":"e12"}'
 *   browser.js fill ref=e7 text="hello world"
 *
 * Output is one JSON document on stdout. Exit 0 on ok:true, 1 on ok:false or
 * relay error, 2 on usage error. Screenshot payloads (base64 `data`) are
 * written to the observations dir and replaced with `path` so the agent reads
 * the file with an image tool instead of getting megabytes on stdout.
 *
 * Every call carries a fresh requestId; the extension uses it to make retried
 * mutating commands idempotent. The relay itself does not know which methods
 * mutate -- it forwards the id untouched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const client = require('./relay-client');

const OBS_DIR = process.env.BROWSER_REMOTE_OBS_DIR
  || path.join(os.homedir(), 'zylos', 'components', 'browser-remote', 'observations');
const OBS_KEEP = 12;

function usage(code = 2) {
  console.error('usage: browser.js status | [--endpoint <keyId>] [--timeout <ms>] <method> [json | k=v ...] | chat <text>');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--endpoint' || a === '--timeout') {
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--endpoint=') || a.startsWith('--timeout=')) {
      const [k, v] = a.split('=', 2);
      opts[k.slice(2)] = v;
    } else {
      rest.push(a);
    }
  }
  return { opts, rest };
}

function parseParams(args) {
  if (!args.length) return {};
  if (args.length === 1 && /^\s*\{/.test(args[0])) {
    try { return JSON.parse(args[0]); } catch (err) { console.error(`browser.js: bad JSON params: ${err.message}`); usage(); }
  }
  const out = {};
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq <= 0) { console.error(`browser.js: expected key=value, got ${JSON.stringify(a)}`); usage(); }
    const k = a.slice(0, eq);
    const raw = a.slice(eq + 1);
    try { out[k] = JSON.parse(raw); } catch { out[k] = raw; }
  }
  return out;
}

function stashScreenshot(result) {
  if (!result || typeof result.data !== 'string' || result.data.length < 256) return result;
  const ext = result.format === 'png' ? 'png' : 'jpg';
  fs.mkdirSync(OBS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(OBS_DIR, `shot-${Date.now()}.${ext}`);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'), { mode: 0o600 });
  const old = fs.readdirSync(OBS_DIR).filter((f) => f.startsWith('shot-')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - OBS_KEEP))) {
    try { fs.unlinkSync(path.join(OBS_DIR, f)); } catch { /* best effort */ }
  }
  const { data, ...rest } = result;
  return { ...rest, path: file, bytes: rest.bytes ?? Buffer.byteLength(data, 'base64'), imageReadRequired: true };
}

function print(obj, exit) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(exit);
}

(async () => {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const [method, ...paramArgs] = rest;
  if (!method) usage();

  if (method === 'status') {
    const { body } = await client.status();
    return print(body, body.ok ? 0 : 1);
  }

  if (method === 'chat') {
    const text = paramArgs.join(' ');
    if (!text.trim()) usage();
    const { body } = await client.chat({ endpoint: opts.endpoint, text });
    return print(body, body.ok ? 0 : 1);
  }

  const req = {
    method,
    params: parseParams(paramArgs),
    requestId: crypto.randomUUID(),
  };
  if (opts.endpoint) req.endpoint = opts.endpoint;
  if (opts.timeout) req.timeoutMs = Number(opts.timeout);

  const { body } = await client.rpc(req);
  if (body.ok && method === 'screenshot') body.result = stashScreenshot(body.result);
  return print(body, body.ok ? 0 : 1);
})().catch((err) => {
  print({ ok: false, code: 'CLI_ERROR', message: err.message }, 1);
});
