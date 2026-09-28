// Timeout behaviour of the private agent-lane HTTP client.
//
// The client is built by a factory that takes its http/timer seams as
// arguments, so these cases drive the module that actually ships. The previous
// CommonJS version re-evaluated the file's source text inside a `vm` sandbox
// with a fake `require`; that trick does not work on ESM source, and testing a
// re-evaluated copy was never as strong as testing the real export.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createClient } from "../scripts/relay-client.js";

function clientFixture() {
  const requests = [];
  const timers = new Map();
  const http = {
    request(_options, respond) {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = (error) => req.emit("error", error);
      req.respond = respond;
      requests.push(req);
      return req;
    },
  };
  const client = createClient({
    http,
    base: "http://127.0.0.1:3803",
    setTimeout: (callback, ms) => {
      const timer = { callback, ms };
      timers.set(timer, timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  return { client, requests, timers };
}

test("HTTP waits are bounded and an ambiguous timeout never resends the reply", async () => {
  const s = clientFixture();
  const pending = s.client.decision({
    endpoint: "a".repeat(12),
    id: "r1",
    decision: { kind: "done", text: "Result" },
  });
  const rejected = assert.rejects(
    pending,
    (e) => e.code === "RELAY_RESPONSE_TIMEOUT" && /unknown/.test(e.message),
  );
  const timer = [...s.timers.values()][0];
  assert.equal(timer.ms, 125000);
  timer.callback();
  await rejected;
  assert.equal(s.requests.length, 1);
  assert.equal(s.timers.size, 0);
});

test("Decision HTTP budget includes execution waiting and successful responses clear the timer", async () => {
  const s = clientFixture();
  const pending = s.client.decision({
    endpoint: "a".repeat(12),
    id: "r1",
    decision: {},
  });
  assert.equal([...s.timers.values()][0].ms, 125000);
  const response = new EventEmitter();
  response.statusCode = 200;
  s.requests[0].respond(response);
  response.emit("data", '{"ok":true,"result":{}}');
  response.emit("end");
  assert.equal((await pending).body.ok, true);
  assert.equal(s.timers.size, 0);
});
