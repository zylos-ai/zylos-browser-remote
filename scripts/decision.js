#!/usr/bin/env node
'use strict';
// Opaque, correlated Agent response. Browser action schemas live in the extension.
const client = require('./relay-client');
const [endpoint, id] = process.argv.slice(2);
if (!/^[a-f0-9]{12}$/.test(endpoint || '') || !/^[A-Za-z0-9._:-]{1,128}$/.test(id || '')) {
  console.error('usage: decision.js <endpoint> <request-id> < response.json');
  process.exit(2);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 128 * 1024) { console.error('Decision exceeds 128 KiB'); process.exit(2); }
});
process.stdin.on('end', async () => {
  try {
    const decision = JSON.parse(input);
    const { body } = await client.decision({ endpoint, id, decision });
    process.stdout.write(JSON.stringify(body) + '\n');
    process.exitCode = body.ok ? 0 : 1;
  } catch (error) {
    console.error(`decision.js: ${error.message}`); process.exitCode = 2;
  }
});
