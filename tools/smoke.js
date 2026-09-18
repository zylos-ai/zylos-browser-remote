"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const WebSocket = require("ws");
const { start } = require("../relay/server");
const { keyIdOf, digest, verifyKey } = require("../relay/keys");
const key = "ab".repeat(32),
  endpoint = keyIdOf(key);
process.env.BROWSER_REMOTE_KEY = key;
const requests = [];
const relay = awaitStart();
async function awaitStart() {
  const server = await start({
    extPort: 0,
    agentPort: 0,
    onRequest: async (m) => {
      requests.push(m);
      return { ok: true };
    },
  });
  const sockets = [];
  const base = `http://127.0.0.1:${server.agent.server.address().port}`;
  const url = `ws://127.0.0.1:${server.ext.server.address().port}/ext`;
  const wait = async (predicate) => {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("missing event");
  };
  const connect = async (caps = ["agent-loop-v1"]) => {
    const ws = new WebSocket(url, ["zylos-browser-remote.v2", `key.${key}`]);
    sockets.push(ws);
    ws.frames = [];
    ws.on("message", (raw) => ws.frames.push(JSON.parse(raw)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", capabilities: caps }));
    return ws;
  };
  const post = async (route, body) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(verifyKey("bad"), null);
    assert.equal(
      verifyKey(key, { [endpoint]: { sha256: digest(key) } }).keyId,
      endpoint,
    );
    assert.equal(
      verifyKey(key, { [endpoint]: { sha256: "0".repeat(64) } }),
      null,
    );
    const bad = new WebSocket(url, [
      "zylos-browser-remote.v2",
      `key.${"cd".repeat(32)}`,
    ]);
    await new Promise((resolve) =>
      bad
        .on("unexpected-response", (_req, res) => {
          assert.equal(res.statusCode, 401);
          res.resume();
          bad.terminate();
          resolve();
        })
        .on("error", () => {}),
    );
    const mismatch = await connect([]);
    const [code] = await once(mismatch, "close");
    assert.equal(code, 4002);
    const ws = await connect();
    await wait(() => ws.frames.some((f) => f.type === "ready"));
    for (const route of ["/rpc", "/chat"])
      assert.equal((await post(route, {})).status, 404);
    ws.send(JSON.stringify({ type: "chat", text: "must not enqueue" }));
    ws.send(
      JSON.stringify({
        type: "agent-request",
        id: "bad",
        taskId: "task",
        round: 1,
        text: "hello",
        context: {},
        payload: {},
      }),
    );
    await wait(() => ws.frames.some((f) => f.requestId === "bad"));
    assert.equal(requests.length, 0);
    ws.send(
      JSON.stringify({
        type: "agent-request",
        id: "r1",
        taskId: "task",
        round: 1,
        text: "hello",
        context: "{}",
        payload: { futureContract: true },
      }),
    );
    await wait(() => ws.frames.some((f) => f.requestId === "r1"));
    assert.equal(requests.length, 1);
    const pending = post("/decision", {
      endpoint,
      id: "r1",
      decision: { kind: "done", text: "Hello" },
    });
    await wait(() => ws.frames.some((f) => f.type === "req"));
    const frame = ws.frames.find((f) => f.type === "req");
    assert.equal(frame.method, "agent-decision");
    ws.send(
      JSON.stringify({
        type: "resp",
        id: frame.id,
        result: { accepted: true },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "agent-turn-end",
        taskId: "task",
        status: "done",
        text: "Hello",
      }),
    );
    assert.equal((await (await pending).json()).finished, true);
    assert.equal(
      (
        await (
          await post("/decision", { endpoint, id: "bad", decision: [] })
        ).json()
      ).code,
      "BAD_REQUEST",
    );
    assert.equal(
      (await post("/decision", { endpoint: "invalid", id: "r", decision: {} }))
        .status,
      400,
    );
    const replacement = await connect();
    await wait(() => replacement.frames.some((f) => f.type === "ready"));
    assert.equal(
      (
        await (
          await post("/decision", { endpoint, id: "r1", decision: {} })
        ).json()
      ).code,
      "STALE_DECISION",
    );
    assert.equal(
      (await fetch(url.replace("ws:", "http:").replace("/ext", "/monitor/")))
        .status,
      426,
    );
    const status = await (await fetch(base + "/status")).json();
    assert.equal(status.extensions[endpoint].capabilities[0], "agent-loop-v1");
    console.log(
      "PASS authentication, required handshake, decision execution, removed routes, replacement isolation, private status",
    );
  } finally {
    sockets.forEach((ws) => ws.terminate());
    server.close();
  }
}
relay.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
