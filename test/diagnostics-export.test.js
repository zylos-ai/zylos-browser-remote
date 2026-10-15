import { test } from "node:test";
import assert from "node:assert/strict";
import { exportDiagnostics, formatDiagnostics, parseDiagnosticsArgs } from "../scripts/diagnostics.js";
import { diagnosticResult } from "../src/lib/diagnostics.js";

const epoch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpoint = "aaaaaaaaaaaa.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const event = seq => ({ seq, at: seq * 1000, source: "executor", level: "info", event: "operation-start", task: 1, op: seq });
const page = (events, extra = {}) => ({ ok: true, endpointId: endpoint, schemaVersion: 2, enabled: true,
  version: "0.17.0", epoch, highWater: 2, oldestCursor: 1, nextCursor: 2, events,
  dropped: 0, hasMore: false, truncated: false, storageHealthy: true, restartCount: 0, ...extra });

test("export freezes epoch/high-water and carries filters across pages", async () => {
  const requests = [];
  const result = await exportDiagnostics({ endpoint, limit: 1, source: "executor", task: 1 }, { all: true,
    client: { diagnostics: async query => {
      requests.push(query);
      return { body: requests.length === 1 ? page([event(1)], { nextCursor: 1, hasMore: true }) : page([event(2)]) };
    } } });
  assert.equal(result.complete, true);
  assert.deepEqual(result.events.map(e => e.seq), [1, 2]);
  assert.deepEqual(requests[1], { endpoint, limit: 1, source: "executor", task: 1, after: 1, epoch, through: 2 });
  const lines = formatDiagnostics(result, "ndjson").split("\n").map(JSON.parse);
  assert.equal(lines[0].type, "metadata");
  assert.equal(lines[0].snapshot.highWater, 2);
  assert.equal(lines[1].type, "event");
});

test("export never claims completeness for ring loss, disabled collection, resets or restart gaps", async () => {
  for (const extra of [{ dropped: 1 }, { truncated: true }, { storageHealthy: false }, { restartCount: 1 }, { enabled: false }]) {
    const result = await exportDiagnostics({ endpoint }, { all: true, client: { diagnostics: async () => ({ body: page([], extra) }) } });
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
  }
  for (const second of [page([], { epoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), page([], { highWater: 3 }),
    { ok: false, code: "DIAGNOSTICS_RESET", message: "SECRET" }]) {
    let calls = 0;
    const result = await exportDiagnostics({ endpoint }, { all: true, client: { diagnostics: async () => ({ body: ++calls === 1 ? page([event(1)], { nextCursor: 1, hasMore: true }) : second }) } });
    assert.equal(result.complete, false);
    assert.equal(result.events.length, 1);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});

test("untrusted rich fields are rejected or omitted and exports cannot loop", async () => {
  for (const extra of [{ level: "secret" }, { source: "url-secret" }, { task: "secret" }, { errorKind: "secret" }, { argCount: 51 }, { closeCode: 999 }, { code: "SECRET" }, { method: "SECRET" }, { status: "SECRET" }]) {
    assert.throws(() => diagnosticResult(page([{ ...event(1), ...extra }]), 100));
  }
  const result = diagnosticResult(page([{ ...event(1), message: "SECRET", stack: "SECRET", args: ["SECRET"], url: "SECRET" }]), 100);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  let calls = 0;
  const stalled = await exportDiagnostics({ endpoint }, { all: true, client: { diagnostics: async () => {
    calls++; return { body: page([], { nextCursor: 0, hasMore: true }) };
  } } });
  assert.equal(stalled.code, "EXPORT_INVALID_PAGE");
  assert.equal(calls, 1);
});

test("CLI options remain typed, bounded and do not echo rejected inputs", () => {
  assert.deepEqual(parseDiagnosticsArgs([endpoint, "--all", "--format", "ndjson", "--task", "3", "--level", "error"]).body,
    { endpoint, after: 0, limit: 100, level: "error", task: 3 });
  for (const args of [["--source", "SECRET"], ["--task", "-1"], ["--limit", "201"], ["--level", "warn", "--level", "error"], ["--secret", "SECRET"]]) {
    assert.throws(() => parseDiagnosticsArgs([endpoint, ...args]), error => !error.message.includes("SECRET"));
  }
});

test("export retains partial evidence on bounded page count, transport failure and ring loss between pages", async () => {
  let calls = 0;
  const limited = await exportDiagnostics({ endpoint, limit: 1 }, { all: true, client: { diagnostics: async () => {
    calls++;
    return { body: page([event(calls)], { highWater: 30, nextCursor: calls, hasMore: true }) };
  } } });
  assert.equal(calls, 20);
  assert.equal(limited.code, "EXPORT_LIMIT");
  assert.equal(limited.events.length, 20);
  calls = 0;
  const failed = await exportDiagnostics({ endpoint }, { all: true, client: { diagnostics: async () => {
    if (++calls === 2) throw new Error("SECRET");
    return { body: page([event(1)], { nextCursor: 1, hasMore: true }) };
  } } });
  assert.equal(failed.code, "EXPORT_TRANSPORT_ERROR");
  assert.equal(failed.events.length, 1);
  assert.ok(!JSON.stringify(failed).includes("SECRET"));
  calls = 0;
  const dropped = await exportDiagnostics({ endpoint }, { all: true, client: { diagnostics: async () => ({ body:
    ++calls === 1 ? page([event(1)], { nextCursor: 1, hasMore: true }) : page([], { dropped: 1, oldestCursor: 3, truncated: true }) }) } });
  assert.equal(dropped.complete, false);
  assert.equal(dropped.events.length, 1);
});

test("rich operation metadata survives projection without raw context", () => {
  const row = { ...event(1), event: "operation-error", method: "snapshot", code: "STOPPED", status: "error", errorKind: "Error", message: "SECRET" };
  const projected = diagnosticResult(page([row]), 100).events[0];
  assert.equal(projected.method, "snapshot");
  assert.equal(projected.code, "STOPPED");
  assert.equal(projected.status, "error");
  assert.equal(projected.message, undefined);
  assert.throws(() => diagnosticResult(page([{ ...event(1), count: 1000001 }]), 100));
});
