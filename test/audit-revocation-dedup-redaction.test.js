"use strict";

// Regressions for the 2026-09-23 read-only audit. Each test reproduces the
// reported failure first, so a revert of the fix fails here rather than in
// production.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ExtLane } = require("../src/lib/ext-lane");
const { summarize } = require("../src/lib/monitor");

// A socket stand-in: records close/terminate instead of moving real bytes.
function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    closed: null,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
    close(code, reason) {
      this.closed = { code, reason: String(reason) };
      this.readyState = 3;
    },
    terminate() {
      this.closed = this.closed || { code: 0, reason: "terminated" };
      this.readyState = 3;
    },
  };
}

function laneWith(keys) {
  const lane = new ExtLane({ loadKeys: () => keys });
  lane.close(); // stop the real heartbeat timer; tests drive _beat() directly
  return lane;
}

function attach(lane, ws, keyId) {
  const conn = {
    keyId,
    label: "test",
    ws,
    endpointId: `${keyId}.browser`,
    browserId: "browser",
    alive: true,
    ready: true,
    nextId: 1,
    pending: new Map(),
    superseded: false,
  };
  lane.conns.set(conn.endpointId, conn);
  return conn;
}

test("revoking a key closes the sockets already authenticated with it", () => {
  const keys = { live: { sha256: "a".repeat(64) }, doomed: { sha256: "b".repeat(64) } };
  const lane = laneWith(keys);
  const keptWs = fakeSocket();
  const revokedWs = fakeSocket();
  const kept = attach(lane, keptWs, "live");
  const revoked = attach(lane, revokedWs, "doomed");

  lane._beat();
  assert.equal(revokedWs.closed, null, "nothing revoked yet, both stay up");
  assert.equal(keptWs.closed, null);

  // Stand in for the pong both browsers would have sent, so the second beat
  // tests revocation rather than a missed heartbeat.
  kept.alive = true;
  revoked.alive = true;
  delete keys.doomed; // what `key.js revoke` does to the registry
  lane._beat();

  assert.deepEqual(
    revokedWs.closed,
    { code: 4004, reason: "key revoked" },
    "the revoked credential's live socket must be dropped, not left running",
  );
  assert.equal(keptWs.closed, null, "an unrelated key keeps its connection");
});

test("an unreadable key registry never disconnects working browsers", () => {
  const lane = new ExtLane({
    loadKeys: () => {
      throw new Error("EIO");
    },
  });
  lane.close();
  const ws = fakeSocket();
  attach(lane, ws, "live");

  lane._beat();

  assert.equal(ws.closed, null, "a transient read error must fail open");
});

test("a request id may be reused by a later task, and duplicates get a status", () => {
  const lane = laneWith({ live: { sha256: "a".repeat(64) } });
  const ws = fakeSocket();
  const conn = attach(lane, ws, "live");
  const seen = [];
  lane.on("agent-request", (event) => seen.push(event.request.taskId));

  const frame = (taskId) => ({
    type: "agent-request",
    version: 2,
    id: "reused",
    taskId,
    round: 1,
    message: { id: taskId, role: "user", content: [{ type: "text", text: "hi" }] },
    context: { pages: [] },
    execution: {},
  });

  lane._onAgentRequest(conn, frame("task-one"));
  assert.deepEqual(seen, ["task-one"]);

  // Same task, same id: still deduped, but no longer silently.
  ws.sent.length = 0;
  lane._onAgentRequest(conn, frame("task-one"));
  assert.deepEqual(seen, ["task-one"], "a true duplicate is never enqueued twice");
  assert.deepEqual(
    ws.sent.map((m) => [m.type, m.requestId, m.code]),
    [["agent-status", "reused", "DUPLICATE_REQUEST"]],
    "the client must be told, or its composer waits forever",
  );

  // Finish the turn, then reuse the id under a different task.
  lane._onMessage(conn, JSON.stringify({ type: "agent-turn-end", taskId: "task-one", status: "done" }));
  lane._onAgentRequest(conn, frame("task-two"));

  assert.deepEqual(
    seen,
    ["task-one", "task-two"],
    "a legitimate later task reusing the id must not be swallowed",
  );
});

test("monitor redaction covers punctuated credential field names", () => {
  const masked = "[内容未记录]";
  const out = summarize({
    access_token: "secret-1",
    api_key: "secret-2",
    headers: { "X-API-Key": "secret-3", authorization: "Bearer x" },
    result: { accessToken: "secret-4" },
    key: "Enter",
    url: "https://example.com/p?q=1",
  });

  assert.equal(out.access_token, masked);
  assert.equal(out.api_key, masked);
  assert.equal(out.headers["X-API-Key"], masked);
  assert.equal(out.headers.authorization, masked);
  assert.equal(out.result.accessToken, masked);
  // A browser keyboard action carries {key:"Enter"}; masking it would blind the
  // trace without hiding anything secret.
  assert.equal(out.key, "Enter");
  assert.equal(out.url, "https://example.com/p");
});
