import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import http from "node:http";
import WebSocket from "ws";
import { ExtLane, SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { AgentLane } from "../src/lib/agent-lane.js";
import { digest, keyIdOf } from "../src/lib/keys.js";
import { createClient } from "../scripts/relay-client.js";
import { detailParams, detailResult, DETAIL_CAPABILITY, DETAIL_MAX_BYTES } from "../src/lib/detail-diagnostics.js";
import { fetchDetail, parseDetailArgs } from "../scripts/detail-diagnostics.js";
import { IncidentEvidence, bestEffortEvidence } from "../src/lib/incident-evidence.js";
import { incidentReport } from "../scripts/incident-report.js";

const key = "ab".repeat(32);
const browserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpoint = `${keyIdOf(key)}.${browserId}`;
const encode = text => ({ schemaVersion: 1, text, sha256: createHash("sha256").update(text).digest("hex") });
const snapshot = () => ({ schemaVersion: 1, enabled: true, expiresAt: 12345, count: 1,
  bytes: 100, dropped: 0, truncated: 0, runtimeEpoch: browserId, captureId: browserId,
  extensionVersion: "0.17.0", build: "test", exportedAt: "2026-10-20T00:00:00.000Z", partial: true,
  limits: { durationMs: 600000, bytes: 1048576, events: 1000, textChars: 16384 }, limitations: "Partial capture",
  records: [{ kind: "console", level: "log", at: 10, text: "private sentinel 测试", truncated: false, source: "background", sequence: 1 }] });
const sample = () => encode(JSON.stringify(snapshot(), null, 2));
const runtime = () => ({ connected: true, control: false, granted: true, scope: "borrowed", groupReference: "none" });
const bundle = () => ({ schemaVersion: 2, kind: "browser-incident-bundle", capture: snapshot(),
  clock: { epoch: "unix-ms", source: "extension-Date.now", remoteComparable: false },
  previewRuntime: runtime(),
  correlations: [{ taskId: browserId, actionId: `${browserId}:fill`, task: 1, operation: 2, method: "fill", startedAt: 31000, outcome: "running" }],
  incidents: [{ incidentId: browserId, taskId: browserId, actionId: `${browserId}:fill`, trigger: "debugger-detach", reason: "target_closed", triggeredAt: 32000,
    window: { from: 2000, to: 34000, through: 32000, complete: false, gaps: ["post-window-pending"] }, recordSequences: [],
    runtimeAtTrigger: runtime(), pageBefore: { status: "unavailable", observedAt: 31000 },
    pageState: { status: "unavailable", observedAt: 32000 } }], limitations: ["partial capture"] });

test("v2 preserves immutable bytes and rejects malformed incident boundaries", () => {
  const valid = encode(JSON.stringify(bundle()));
  assert.deepEqual(detailResult(valid), valid);
  for (const mutate of [b => b.extra = "secret", b => b.clock.remoteComparable = true,
    b => b.incidents[0].window.to += 1, b => b.incidents[0].window.complete = true,
    b => b.incidents[0].recordSequences = [99], b => b.capture.extra = "secret",
    b => b.correlations[0].params = { text: "secret" }, b => b.incidents[0].pageState.url = "secret",
    b => b.previewRuntime.scope = "secret", b => b.incidents[0].runtimeAtTrigger.groupReference = "secret",
    b => b.incidents[0].pageBefore.status = "captured", b => b.incidents[0].pageState.state = {},
    b => b.incidents[0].pageBefore.observedAt = -1]) {
    const bad = bundle(); mutate(bad);
    assert.throws(() => detailResult(encode(JSON.stringify(bad))));
  }
  assert.equal(incidentReport({ ok: true, ...valid }).report.cause, "undetermined");
  const operation = bundle(); operation.incidents[0].trigger = "operation-error";
  assert.doesNotThrow(() => detailResult(encode(JSON.stringify(operation))));
});

test("Remote companion is exact endpoint and task/action scoped, bounded and metadata only", () => {
  let now = 100;
  const evidence = new IncidentEvidence({ now: () => now, ttlMs: 1000, maxRecords: 3, maxEndpoints: 2 });
  evidence.connection(endpoint, true);
  evidence.connection("other", true);
  const event = { taskId: browserId, id: `${browserId}:fill`, method: "fill", phase: "start", params: { text: "SECRET" }, error: { message: "SECRET" } };
  evidence.record(endpoint, "action", event);
  evidence.record("other", "action", event);
  evidence.record(endpoint, "action", { ...event, id: "unrelated" });
  let result = evidence.snapshot(endpoint, bundle());
  assert.equal(result.records.length, 1);
  assert.equal(result.clockAligned, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|unrelated/);
  now += 1001;
  assert.equal(evidence.snapshot(endpoint, bundle()).records.length, 0);
  evidence.record(endpoint, "action", event);
  evidence.connection(endpoint, false);
  evidence.connection(endpoint, true);
  assert.equal(evidence.snapshot(endpoint, bundle()).records.length, 0);
  for (let i = 0; i < 10; i++) evidence.record(endpoint, "action", event);
  assert.equal(evidence.records.length, 3);
  evidence.connection("third", true); evidence.connection("fourth", true);
  assert.equal(evidence.connections.size, 2);
  assert.equal(evidence.snapshot(endpoint, bundle()).records.length, 0);
});

test("v2 CLI validates companion joins and never re-fetches", async () => {
  const valid = encode(JSON.stringify(bundle()));
  const evidence = new IncidentEvidence(); evidence.connection(endpoint, true);
  evidence.record(endpoint, "action", { taskId: browserId, id: `${browserId}:fill`, phase: "end", method: "fill" });
  const remoteEvidence = evidence.snapshot(endpoint, bundle());
  let calls = 0;
  const response = { ok: true, endpointId: endpoint, ...valid, remoteEvidence };
  const transport = { detailDiagnostics: async () => { calls++; return { body: response }; } };
  const accepted = await fetchDetail({ endpoint }, transport);
  assert.equal(accepted.text, valid.text);
  assert.deepEqual(accepted.remoteEvidence, remoteEvidence);
  remoteEvidence.endpointId = "other";
  assert.equal((await fetchDetail({ endpoint }, transport)).code, "BAD_DETAIL_RESPONSE");
  assert.equal(calls, 2);
  remoteEvidence.endpointId = endpoint;
  for (const mutate of [e => e.clockAligned = true, e => e.connection.secret = "secret",
    e => e.records[0].taskId = "unrelated", e => e.records[0].actionId = "unrelated",
    e => e.records[0].params = "secret", e => delete e.records[0].outcome,
    e => e.records[0].receivedAt = e.capturedAt + 1, e => e.raw = "secret"]) {
    const copy = structuredClone(remoteEvidence); mutate(copy); response.remoteEvidence = copy;
    assert.equal((await fetchDetail({ endpoint }, transport)).code, "BAD_DETAIL_RESPONSE");
  }
});

async function setup(t, handler, caps = [DETAIL_CAPABILITY]) {
  const logs = [];
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }), log: value => logs.push(value) });
  await ext.listen(0, "127.0.0.1");
  const incidentEvidence = new IncidentEvidence();
  ext.on("connected", endpoint => incidentEvidence.connection(endpoint, true));
  ext.on("disconnected", endpoint => incidentEvidence.connection(endpoint, false));
  const agent = new AgentLane({ extLane: ext, incidentEvidence, port: 0, log: value => logs.push(value) });
  await agent.listen();
  t.after(() => { agent.close(); ext.close(); });
  const client = createClient({ base: `http://127.0.0.1:${agent.server.address().port}` });
  const ws = new WebSocket(`ws://127.0.0.1:${ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
  await once(ws, "open");
  const frames = [];
  ws.on("message", raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== "req") return;
    frames.push(frame);
    const result = handler(frame, ws);
    if (result !== undefined) ws.send(JSON.stringify({ type: "resp", id: frame.id, result }));
  });
  const connected = once(ext, "connected");
  ws.send(JSON.stringify({ type: "hello", browserId, capabilities: ["agent-loop-v1", "browser-instance-v1", ...caps] }));
  await connected;
  return { client, frames, ws, ext, logs, agent, incidentEvidence };
}

test("v2 HTTP/WS fetch adds scoped companion outside immutable consent bytes", async t => {
  const expected = encode(JSON.stringify(bundle()));
  const { client, frames, incidentEvidence } = await setup(t, () => expected);
  incidentEvidence.record(endpoint, "action", { taskId: browserId, id: `${browserId}:fill`, phase: "end", method: "keypress" });
  incidentEvidence.record(endpoint, "action", { taskId: browserId, id: "unrelated", phase: "end", method: "fill" });
  const result = await fetchDetail({ endpoint }, client);
  assert.equal(result.ok, true);
  assert.equal(result.text, expected.text);
  assert.equal(result.sha256, expected.sha256);
  assert.equal(result.remoteEvidence.records.length, 1);
  assert.equal(result.remoteEvidence.records[0].method, "keypress");
  assert.equal(frames.length, 1);
});

test("Remote byte cap rejects oversized metadata and unknown method text", () => {
  const evidence = new IncidentEvidence({ maxBytes: 300 });
  evidence.connection(endpoint, true);
  for (let i = 0; i < 10; i++) evidence.record(endpoint, "action", {
    taskId: browserId, id: `${browserId}:fill`, method: "PRIVATE METHOD", phase: "start",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.records)) <= 300);
  assert.ok(evidence.dropped > 0);
  assert.doesNotMatch(JSON.stringify(evidence.snapshot(endpoint, bundle())), /PRIVATE METHOD/);
});

test("companion failures cannot discard the consumed immutable share", async t => {
  assert.doesNotThrow(() => bestEffortEvidence(() => { throw new Error("private failure"); }));
  const expected = encode(JSON.stringify(bundle()));
  const { client, frames, incidentEvidence } = await setup(t, () => expected);
  incidentEvidence.snapshot = () => { throw new Error("private failure"); };
  const result = incidentReport(await fetchDetail({ endpoint }, client));
  assert.equal(result.ok, true);
  assert.equal(result.text, expected.text);
  assert.equal(frames.length, 1);
  assert.ok(result.report.gaps.includes("No Remote companion evidence was available."));
  assert.doesNotMatch(JSON.stringify(result), /private failure/);
});

test("isolated HTTP/WS fetch preserves exact preview once, with no raw metadata or logs", async t => {
  let granted = true;
  const expected = sample();
  const { client, frames, logs, agent } = await setup(t, (frame, ws) => {
    if (!granted) { ws.send(JSON.stringify({ type: "error", id: frame.id, code: "DETAIL_SHARE_UNAVAILABLE", message: "secret error" })); return; }
    granted = false;
    return expected;
  });
  assert.equal(agent.server.address().address, "127.0.0.1");
  assert.deepEqual(await fetchDetail({ endpoint }, client), { ok: true, endpointId: endpoint, ...expected });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, "diagnostics.detail.fetch");
  assert.deepEqual(frames[0].params, {});
  assert.equal((await fetchDetail({ endpoint }, client)).code, "DETAIL_SHARE_UNAVAILABLE");
  assert.equal(frames.length, 2);
  assert.doesNotMatch(JSON.stringify(await client.status()), /private sentinel|secret error/);
  assert.doesNotMatch(JSON.stringify(logs), /private sentinel|secret error/);
});

test("strict endpoint params and unsupported capability never send RPC", async t => {
  const { client, frames } = await setup(t, sample, []);
  for (const body of [{}, { endpoint: keyIdOf(key) }, { endpoint, enable: true }, { endpoint, params: {} }, { endpoint: "all" }]) {
    assert.equal((await client.detailDiagnostics(body)).body.code, "BAD_REQUEST");
    assert.throws(() => detailParams(body));
  }
  assert.equal((await fetchDetail({ endpoint }, client)).code, "DETAIL_SHARE_UNSUPPORTED");
  assert.equal(frames.length, 0);
  assert.deepEqual(parseDetailArgs([endpoint]), { endpoint });
  for (const args of [[], [endpoint, "--enable"], ["--all"], [keyIdOf(key)]]) assert.throws(() => parseDetailArgs(args));
  await assert.rejects(createClient({ base: "http://example.com" }).detailDiagnostics({ endpoint }), /non-loopback/);
});

test("reject malformed, oversized, hash mismatch and extra fields", () => {
  const valid = sample();
  assert.deepEqual(detailResult(valid), valid);
  for (const bad of [null, [], { ...valid, extra: "secret" }, { ...valid, sha256: "0".repeat(64) },
    { ...valid, sha256: valid.sha256.toUpperCase() }, encode("{}"), encode("[]"), encode("null"), encode("not json"),
    encode("x".repeat(DETAIL_MAX_BYTES + 1)), encode("汉".repeat(Math.ceil(DETAIL_MAX_BYTES / 3))),
    encode(JSON.stringify({ ...snapshot(), consent: "private" })),
    encode(JSON.stringify({ ...snapshot(), count: 0 })),
    encode(JSON.stringify({ ...snapshot(), records: [{ ...snapshot().records[0], extra: "private" }] }))]) {
    assert.throws(() => detailResult(bad), /Invalid detailed diagnostics response/);
  }
});

test("relay rejects corrupt payload and hides arbitrary errors", async t => {
  let bad = true;
  const { client, frames } = await setup(t, (frame, ws) => {
    if (bad) return { ...sample(), sha256: "0".repeat(64) };
    ws.send(JSON.stringify({ type: "error", id: frame.id, code: "secret code", message: "private error", details: "private data" }));
  });
  assert.equal((await fetchDetail({ endpoint }, client)).code, "BAD_DETAIL_RESPONSE");
  bad = false;
  const result = await fetchDetail({ endpoint }, client);
  assert.equal(result.code, "DETAIL_SHARE_ERROR");
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  assert.equal(frames.length, 2);
});

test("disconnect fails once without replay or automatic retry", async t => {
  const { client, frames } = await setup(t, (_, ws) => { ws.close(); });
  assert.equal((await fetchDetail({ endpoint }, client)).code, "EXT_OFFLINE");
  assert.equal(frames.length, 1);
});

test("silent extension times out with exactly one request", async t => {
  const { client, frames } = await setup(t, () => undefined);
  const started = Date.now();
  assert.equal((await fetchDetail({ endpoint }, client)).code, "EXT_TIMEOUT");
  assert.equal(frames.length, 1);
  assert.ok(Date.now() - started < 8000);
});

test("CLI transport failure or hostile response never leaks raw errors or retries", async () => {
  let calls = 0;
  const transport = { detailDiagnostics: async () => { calls++; throw new Error("private exception"); } };
  assert.equal((await fetchDetail({ endpoint }, transport)).code, "DETAIL_SHARE_ERROR");
  assert.equal(calls, 1);
  transport.detailDiagnostics = async () => ({ body: { ok: false, code: "private code", message: "private message" } });
  assert.doesNotMatch(JSON.stringify(await fetchDetail({ endpoint }, transport)), /private/);
  transport.detailDiagnostics = async () => ({ body: { ok: true, endpointId: endpoint, ...sample(), extra: "private" } });
  assert.equal((await fetchDetail({ endpoint }, transport)).code, "BAD_DETAIL_RESPONSE");
});

test("HTTP chunk boundaries preserve UTF-8 preview and its hash", async t => {
  const expected = sample();
  const payload = Buffer.from(JSON.stringify({ ok: true, endpointId: endpoint, ...expected }));
  const split = payload.indexOf(Buffer.from("测试")) + 1;
  assert.ok(split > 1);
  const server = http.createServer((req, res) => {
    req.resume();
    res.write(payload.subarray(0, split));
    setImmediate(() => res.end(payload.subarray(split)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = createClient({ base: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual(await fetchDetail({ endpoint }, client), { ok: true, endpointId: endpoint, ...expected });
});
