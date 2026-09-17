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

const crypto = require('crypto');
const client = require('./relay-client');
const { materializeImages } = require('./attachments');

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
