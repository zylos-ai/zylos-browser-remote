import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isValidSessionGroup, sessionGroupFromEndpoint } from "../src/lib/session-group.js";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/session-group.js");
const keyId = "0123456789ab";
const browserId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("accepts names Core accepts", () => {
  for (const name of ["dm-8101553026", "group-1001234567890:topic-42", "a", "A.b_c:d-e", "x".repeat(95)]) {
    assert.equal(isValidSessionGroup(name), true, name);
  }
});

test("rejects names Core rejects", () => {
  for (const name of ["", "-group", ":topic", "_a", "a b", "a/b", "dm-é", "x".repeat(96), null, 42]) {
    assert.equal(isValidSessionGroup(name), false, String(name));
  }
});

test("maps each browser connection to its own session group", () => {
  const table = [
    [`${keyId}.${browserId}`, `browser-${keyId}.${browserId}`], // browser instance
    [keyId, `browser-${keyId}`], // extension without browser instances
    // Final-reply addresses Core looks up for c4-send: same connection, same group.
    [`${keyId}.${browserId}|req:r1|status:done`, `browser-${keyId}.${browserId}`],
    [`${keyId}.${browserId}|req:r1|status:blocked|input:i-2`, `browser-${keyId}.${browserId}`],
  ];
  for (const [endpoint, group] of table) {
    assert.equal(sessionGroupFromEndpoint(endpoint), group);
    assert.ok(isValidSessionGroup(group));
    assert.equal(execFileSync(process.execPath, [script, endpoint], { encoding: "utf8" }), `${group}\n`);
  }
  // Distinct connections never share a group.
  const other = `${keyId}.aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff`;
  assert.notEqual(sessionGroupFromEndpoint(other), sessionGroupFromEndpoint(`${keyId}.${browserId}`));
});

test("invalid endpoints throw and never map to the overall group", () => {
  for (const endpoint of ["", "all", keyId.toUpperCase(), `${keyId}.not-a-uuid`, `${keyId}|req:`, `${keyId}|`, `${keyId}|req:a b`, `../${keyId}`, null]) {
    assert.throws(() => sessionGroupFromEndpoint(endpoint), String(endpoint));
  }
});

test("CLI requires exactly one endpoint argument", () => {
  for (const args of [[], ["a", "b"]]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], { stdio: "pipe" }),
      err => err.status === 1 && /Usage:/.test(err.stderr.toString()));
  }
});

test("CLI failure exits 1 with nothing on stdout, never as empty output", () => {
  for (const endpoint of ["", "bad"]) {
    assert.throws(() => execFileSync(process.execPath, [script, endpoint], { stdio: "pipe" }),
      err => err.status === 1 && err.stdout.toString() === "" && /Error:/.test(err.stderr.toString()));
  }
});
