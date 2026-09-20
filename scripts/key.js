#!/usr/bin/env node
'use strict';
/*
 * Extension key management. The plaintext is printed ONCE at `new`; only the
 * sha256 digest is kept in keys.json. Hand the owner `relayUrl + key`; the
 * keyId shown next to it is the C4 endpoint their side-panel messages arrive on.
 *
 *   node scripts/key.js new --label bobo-mac
 *   node scripts/key.js list
 *   node scripts/key.js revoke <keyId>
 */

const { newKey, listKeys, revokeKey, keysFile } = require('../src/lib/keys');

const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
}

switch (cmd) {
  case 'new': {
    const label = flag('--label') || '';
    const { key, keyId } = newKey({ label });
    console.log(`keyId:  ${keyId}${label ? `  (${label})` : ''}`);
    console.log(`key:    ${key}`);
    console.log(`stored: ${keysFile()}  (digest only -- this is the only time the key is shown)`);
    break;
  }
  case 'list': {
    const keys = listKeys();
    if (!keys.length) console.log(`no keys in ${keysFile()}`);
    for (const k of keys) console.log(`${k.keyId}  ${k.label || '-'}  ${k.createdAt || ''}`);
    break;
  }
  case 'revoke': {
    const id = rest[0];
    if (!id) { console.error('usage: key.js revoke <keyId>'); process.exit(2); }
    console.log(revokeKey(id) ? `revoked ${id}` : `no such key ${id}`);
    break;
  }
  default:
    console.error('usage: key.js new [--label <who>] | list | revoke <keyId>');
    process.exit(2);
}
