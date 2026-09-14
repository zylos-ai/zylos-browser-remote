#!/usr/bin/env node
'use strict';
/*
 * C4 outbound adapter: comm-bridge runs `node send.js <endpoint> <message>`
 * for `c4-send.js browser-remote <keyId>`. The endpoint is the keyId of the
 * owner's extension; the message becomes a chat bubble in their side panel.
 *
 * Exit 0 on delivery, non-zero otherwise (comm-bridge logs the code).
 */

const client = require('./relay-client');

const [endpoint, ...msgParts] = process.argv.slice(2);
const text = msgParts.join(' ');

if (!endpoint || !/^[a-f0-9]{12}$/.test(endpoint)) {
  console.error(`send.js: endpoint must be a 12-hex keyId (got ${JSON.stringify(endpoint)})`);
  process.exit(2);
}
if (!text.trim()) {
  console.error('send.js: empty message');
  process.exit(2);
}

client.chat({ endpoint, text }).then(({ status, body }) => {
  if (body.ok) {
    process.exit(0);
  }
  console.error(`send.js: ${body.code || status}: ${body.message || 'delivery failed'}`);
  process.exit(body.code === 'EXT_OFFLINE' || body.code === 'RELAY_DOWN' ? 3 : 1);
}).catch((err) => {
  console.error(`send.js: ${err.message}`);
  process.exit(1);
});
