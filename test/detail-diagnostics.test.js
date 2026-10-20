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

async function setup(t, handler, caps = [DETAIL_CAPABILITY]) {
  const logs = [];
  const ext = new ExtLane({ loadKeys: () => ({ [keyIdOf(key)]: { sha256: digest(key) } }), log: value => logs.push(value) });
  await ext.listen(0, "127.0.0.1");
  const agent = new AgentLane({ extLane: ext, port: 0, log: value => logs.push(value) });
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
  return { client, frames, ws, ext, logs, agent };
}

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
