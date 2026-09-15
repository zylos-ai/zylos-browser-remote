#!/usr/bin/env node
'use strict';
/*
 * C4 outbound adapter: comm-bridge runs `node send.js <endpoint> <message>`
 * for `c4-send.js browser-remote <keyId>`. The endpoint is the keyId of the
 * owner's extension; the message becomes a chat bubble in their side panel.
 * Normal replies end the browser turn. For an intermediate update, use
 * `node send.js --progress <endpoint> <message>` instead.
 *
 * Exit 0 when accepted by the channel (final replies are persisted for delivery).
 */

const client = require('./relay-client');

const args = process.argv.slice(2);
const progress = args[0] === '--progress';
if (progress) args.shift();
const [endpoint, ...msgParts] = args;
const text = msgParts.join(' ');

if (!endpoint || !/^[a-f0-9]{12}$/.test(endpoint)) {
  console.error(`send.js: endpoint must be a 12-hex keyId (got ${JSON.stringify(endpoint)})`);
  process.exit(2);
}
if (!text.trim()) {
  console.error('send.js: empty message');
  process.exit(2);
}

client.chat({ endpoint, text, final: !progress }).then(({ status, body }) => {
  if (body.ok) {
    if (body.queued) console.log(`[browser-remote] Reply saved (${body.messageId}); the panel will acknowledge it after connecting.`);
    process.exit(0);
  }
  console.error(`send.js: ${body.code || status}: ${body.message || 'delivery failed'}`);
  process.exit(body.code === 'EXT_OFFLINE' || body.code === 'RELAY_DOWN' ? 3 : 1);
}).catch((err) => {
  console.error(`send.js: ${err.message}`);
  process.exit(1);
});
