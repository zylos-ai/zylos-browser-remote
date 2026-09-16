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
 *   browser.js describe
 *   browser.js <method> '{"parameter":"value"}'
 *
 * Output is one JSON document on stdout. Exit 0 on ok:true, 1 on ok:false or
 * relay error, 2 on usage error. Typed image attachments (base64 `data`) are
 * written on the agent's machine and replaced with `path` so the agent reads
 * the file with an image tool instead of getting megabytes on stdout. This
 * applies at any result depth, independently of the method name.
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

const OBS_DIR = path.resolve(process.env.BROWSER_REMOTE_OBS_DIR
  || path.join(os.homedir(), 'zylos', 'components', 'browser-remote', 'observations'));
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

function stashImage(result, created) {
  if (!result || typeof result.data !== 'string') throw new Error('Image data is missing');
  const image = Buffer.from(result.data, 'base64');
  // Older peers may return just {data} or format. Detect the bytes as a
  // fallback and check declared types.
  const detectedType = image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'image/png'
    : image.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg' : null;
  const mimeType = result.mimeType
    || ({ png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg' }[result.format])
    || detectedType;
  if (!detectedType || mimeType !== detectedType) throw new Error('Invalid or unsupported image');
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  fs.mkdirSync(OBS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(OBS_DIR, `shot-${Date.now()}-${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(file, image, { mode: 0o600, flag: 'wx' });
  created.add(path.basename(file));
  const { data, ...rest } = result;
  return { ...rest, mimeType, path: file, bytes: image.length, imageReadRequired: true };
}

function materializeImages(result) {
  const created = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 32) throw new Error('Result nesting exceeds the attachment limit');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    const prefix = typeof value.data === 'string' ? Buffer.from(value.data.slice(0, 16), 'base64') : Buffer.alloc(0);
    // MIME is the generic attachment contract. Magic/format keep older peers
    // readable without knowing which browser methods return images.
    const isImage = typeof value.data === 'string' && (
      typeof value.mimeType === 'string' && value.mimeType.startsWith('image/') ||
      ['png', 'jpeg', 'jpg'].includes(value.format) ||
      prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      prefix.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')));
    let mapped = value;
    if (isImage) {
      if (created.size >= OBS_KEEP) throw new Error('Too many image attachments in one result');
      mapped = stashImage(value, created);
    }
    return Object.fromEntries(Object.entries(mapped).map(([key, item]) => [key, visit(item, depth + 1)]));
  };
  const output = visit(result);
  if (created.size) {
    const previous = fs.readdirSync(OBS_DIR).filter(f => f.startsWith('shot-') && !created.has(f)).sort();
    for (const file of previous.slice(0, Math.max(0, previous.length + created.size - OBS_KEEP))) {
      try { fs.unlinkSync(path.join(OBS_DIR, file)); } catch { /* best effort */ }
    }
  }
  return output;
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
  if (body.ok) body.result = materializeImages(body.result);
  return print(body, body.ok ? 0 : 1);
})().catch((err) => {
  print({ ok: false, code: 'CLI_ERROR', message: err.message }, 1);
});
