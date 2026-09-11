'use strict';
// GUARD-REVIEW.md F9: relay/guard.js and extension/guard.js are hand-synced copies
// (an MV3 service worker cannot import from the relay). Nothing asserted that they
// stayed identical, so drift between them was a silent class of bug: the relay could
// refuse a URL the extension happily executed, or vice versa.
//
// This compares the region between the SHARED GUARD BLOCK markers byte-for-byte.
// Offline, no deps. Exits 0 when in sync, 1 when not.

const fs = require('fs');
const path = require('path');

const START = '// --- SHARED GUARD BLOCK START ---';
const END = '// --- SHARED GUARD BLOCK END ---';

const ROOT = path.resolve(__dirname, '..');
const COPIES = ['relay/guard.js', 'extension/guard.js'];

function extractBlock(relPath) {
  const abs = path.join(ROOT, relPath);
  const src = fs.readFileSync(abs, 'utf8');
  const from = src.indexOf(START);
  const to = src.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${relPath}: SHARED GUARD BLOCK markers missing or out of order`);
  }
  return src.slice(from, to + END.length);
}

function firstDiffLine(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, a: la[i] ?? '<missing>', b: lb[i] ?? '<missing>' };
    }
  }
  return null;
}

let blocks;
try {
  blocks = COPIES.map(extractBlock);
} catch (err) {
  console.error(`guard-sync FAIL: ${err.message}`);
  process.exit(1);
}

const diff = firstDiffLine(blocks[0], blocks[1]);
if (diff) {
  console.error('guard-sync FAIL: the two guard copies have drifted.');
  console.error(`  first difference at shared-block line ${diff.line}`);
  console.error(`  ${COPIES[0]}: ${diff.a}`);
  console.error(`  ${COPIES[1]}: ${diff.b}`);
  process.exit(1);
}

console.log(`guard-sync OK: ${COPIES.join(' and ')} share an identical ${blocks[0].split('\n').length}-line block.`);
