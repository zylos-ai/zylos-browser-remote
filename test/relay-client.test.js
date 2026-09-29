"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

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
  const sandbox = {
    require: (name) => {
      assert.equal(name, "http");
      return http;
    },
    module: { exports: {} },
    process: { env: {} },
    URL,
    Buffer,
    setTimeout: (callback, ms) => {
      const timer = { callback, ms };
      timers.set(timer, timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../scripts/relay-client.js"), "utf8"),
    sandbox,
  );
  return { client: sandbox.module.exports, requests, timers };
}

test("decision connection/delivery is bounded and an ambiguous timeout never resends the reply", async () => {
  const s = clientFixture();
  const pending = s.client.decision({
    endpoint: "a".repeat(12),
    id: "r1",
    decision: { kind: "done", text: "Result" },
  });
  const rejected = assert.rejects(
    pending,
    (e) => e.code === "RELAY_REQUEST_TIMEOUT" && /unknown/.test(e.message),
  );
  const timer = [...s.timers.values()][0];
  assert.equal(timer.ms, 10000);
  timer.callback();
  await rejected;
  assert.equal(s.requests.length, 1);
  assert.equal(s.timers.size, 0);
});

test("a sent decision waits without a deadline on the same HTTP request", async () => {
  const s = clientFixture();
  const pending = s.client.decision({
    endpoint: "a".repeat(12),
    id: "r1",
    decision: {},
  });
  assert.equal([...s.timers.values()][0].ms, 10000);
  s.requests[0].emit("finish");
  assert.equal(s.timers.size, 0);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(s.requests.length, 1);
  const response = new EventEmitter();
  response.statusCode = 200;
  s.requests[0].respond(response);
  response.emit("data", '{"ok":true,"result":{}}');
  response.emit("end");
  assert.equal((await pending).body.ok, true);
  assert.equal(s.timers.size, 0);
});

test("status requests still time out after sending", async () => {
  const s = clientFixture();
  const pending = s.client.status();
  const rejected = assert.rejects(
    pending,
    (e) => e.code === "RELAY_RESPONSE_TIMEOUT",
  );
  s.requests[0].emit("finish");
  const timer = [...s.timers.values()][0];
  assert.equal(timer.ms, 10000);
  timer.callback();
  await rejected;
  assert.equal(s.requests.length, 1);
  assert.equal(s.timers.size, 0);
});

test("a disconnected decision response rejects without submitting the decision again", async () => {
  const s = clientFixture();
  const pending = s.client.decision({
    endpoint: "a".repeat(12),
    id: "r1",
    decision: {},
  });
  const rejected = assert.rejects(pending, (e) => e.code === "ECONNRESET");
  s.requests[0].emit("finish");
  const response = new EventEmitter();
  s.requests[0].respond(response);
  response.emit(
    "error",
    Object.assign(new Error("Connection closed"), { code: "ECONNRESET" }),
  );
  await rejected;
  assert.equal(s.requests.length, 1);
  assert.equal(s.timers.size, 0);
});
