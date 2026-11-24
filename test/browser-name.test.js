import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start } from "../src/index.js";
import { newKey } from "../src/lib/keys.js";
import { SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { INSTANCE_CAPABILITY } from "../src/lib/endpoint.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-name-"));
  const saved = process.env.BROWSER_REMOTE_KEYS_FILE;
  process.env.BROWSER_REMOTE_KEYS_FILE = path.join(dir, "keys.json");
  const relay = await start({ extPort: 0, agentPort: 0, onRequest: async () => ({ ok: true }) });
  t.after(() => {
    relay.close();
    if (saved === undefined) delete process.env.BROWSER_REMOTE_KEYS_FILE;
    else process.env.BROWSER_REMOTE_KEYS_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return relay;
}

function dial(relay, key, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
    ws.on("open", () => ws.send(JSON.stringify({
      type: "hello", version: "fixture", browserId: A, capabilities: ["agent-loop-v1", INSTANCE_CAPABILITY], ...extra,
    })));
    ws.on("message", (raw) => { if (JSON.parse(raw).type === "ready") resolve(ws); });
    ws.on("close", (code) => reject(new Error(`closed ${code}`)));
    ws.on("error", () => {});
  });
}

const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

test("Workspace browser name shows in status as 'name · id8' and follows renames", async (t) => {
  const relay = await setup(t);
  const conn = "c0ffee12-3456-4789-8abc-def012345678";
  const { key, keyId } = newKey({ label: `openmax:${conn}`, connectionId: conn, singleBrowser: true });
  const ws = await dial(relay, key, { browserName: "  Work\nLaptop  " });
  t.after(() => ws.close());
  const ep = `${keyId}.${A}`;
  let s = relay.ext.status()[ep];
  assert.equal(s.browserName, "Work Laptop");
  assert.equal(s.displayName, "Work Laptop · c0ffee12");
  assert.equal(s.connectionId, conn);
  assert.equal(s.label, `openmax:${conn}`);

  ws.send(JSON.stringify({ type: "browser-name", browserName: "Home Mac" }));
  await until(() => relay.ext.status()[ep].browserName === "Home Mac");
  s = relay.ext.status()[ep];
  assert.equal(s.displayName, "Home Mac · c0ffee12");

  ws.send(JSON.stringify({ type: "browser-name", browserName: "x".repeat(500) }));
  await until(() => relay.ext.status()[ep].browserName?.length === 100);
  assert.equal(relay.ext.status()[ep].browserName.length, 100);
});

test("an extension without a name keeps the old status (label or id)", async (t) => {
  const relay = await setup(t);
  const { key, keyId } = newKey({ label: "manual" });
  const ws = await dial(relay, key, { browserName: 42 });
  t.after(() => ws.close());
  const s = relay.ext.status()[`${keyId}.${A}`];
  assert.equal(s.browserName, null);
  assert.equal(s.displayName, "manual");
  assert.equal(s.connectionId, null);
});
