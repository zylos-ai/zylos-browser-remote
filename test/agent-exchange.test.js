import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-exchange-attachments-"));
process.env.BROWSER_REMOTE_OBS_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AgentExchange } from "../src/lib/agent-exchange.js";
const file = {
  type: "file",
  id: "f1",
  name: "input.txt",
  mimeType: "text/plain",
  bytes: 2,
  data: "aGk=",
};
const message = (id, round = 1, taskId = "task") => ({
  endpointId: "aaaaaaaaaaaa",
  chatId: taskId,
  text: "owner request",
  request: {
    version: 2,
    id,
    taskId,
    round,
    message:
      round === 1
        ? {
            id: taskId,
            role: "user",
            content: [{ type: "text", text: "owner request" }],
          }
        : { id: taskId },
    context: { pages: [] },
    execution: { state: id },
  },
});
function setup(t) {
  const ext = new EventEmitter();
  const exchange = new AgentExchange(ext);
  t.after(() => exchange.close());
  exchange.ingest(message("r1"));
  return { ext, exchange };
}
test("a superseded final returns steering on the same task, materializes files and isolates endpoints", async (t) => {
  const { ext, exchange } = setup(t);
  const update = message("r2", 2);
  update.request.updates = [
    {
      message: {
        id: "update-1",
        role: "user",
        content: [{ type: "text", text: "Use these notes" }, file],
      },
      context: { pages: [{ tabId: 7 }] },
    },
  ];
  let forwarded = false;
  ext.request = async (endpoint) => {
    assert.equal(endpoint, "aaaaaaaaaaaa");
    if (!forwarded) {
      forwarded = true;
      exchange.ingest(update);
    }
    return { accepted: true };
  };
  const other = message("other-request");
  other.endpointId = "bbbbbbbbbbbb";
  exchange.ingest(other);
  const result = await exchange.respond("aaaaaaaaaaaa", "r1", {
    kind: "done",
    text: "Old answer",
  });
  assert.equal(result.finished, undefined);
  assert.equal(result.next.taskId, "task");
  assert.equal(result.next.updates[0].message.id, "update-1");
  const resource = result.next.updates[0].message.content[1];
  assert.equal(resource.data, undefined);
  assert.equal(fs.readFileSync(resource.path, "utf8"), "hi");
  assert.equal(exchange.states.get("bbbbbbbbbbbb").next.updates, undefined);
  const retry = await exchange.respond("aaaaaaaaaaaa", "r1", {
    kind: "done",
    text: "Old answer",
  });
  assert.equal(retry.replayed, true);
  ext.emit("agent-turn-end", {
    endpointId: "aaaaaaaaaaaa",
    taskId: "task",
    status: "done",
  });
  assert.equal(fs.existsSync(resource.path), false);
});
test("exchange arms before acknowledgement, returns fresh state, and preserves a retry receipt", async (t) => {
  const { ext, exchange } = setup(t);
  let calls = 0;
  ext.request = async () => {
    if (++calls === 1) exchange.ingest(message("r2", 2));
    return { accepted: true };
  };
  const first = await exchange.respond("aaaaaaaaaaaa", "r1", {
    anything: true,
  });
  assert.equal(first.next.id, "r2");
  const retry = await exchange.respond("aaaaaaaaaaaa", "r1", {
    anything: true,
  });
  assert.equal(retry.replayed, true);
  assert.equal(retry.next.id, "r2");
  ext.request = async () => {
    throw Object.assign(new Error("changed decision"), {
      code: "DECISION_CONFLICT",
    });
  };
  assert.equal(
    (await exchange.respond("aaaaaaaaaaaa", "r1", { changed: true })).code,
    "DECISION_CONFLICT",
  );
});
test("invalid decisions leave the request available for correction; completion waits for client end", async (t) => {
  const { ext, exchange } = setup(t);
  ext.request = async () => {
    throw Object.assign(new Error("schema"), { code: "BAD_DECISION" });
  };
  assert.equal(
    (await exchange.respond("aaaaaaaaaaaa", "r1", {})).code,
    "BAD_DECISION",
  );
  ext.request = async () => {
    ext.emit("agent-turn-end", {
      endpointId: "aaaaaaaaaaaa",
      taskId: "task",
      status: "done",
    });
  };
  assert.deepEqual(
    await exchange.respond("aaaaaaaaaaaa", "r1", { final: true }),
    { ok: true, accepted: true, finished: true, status: "done" },
  );
});
test("disconnect releases a blocked decision and no old receipt survives the connection", async (t) => {
  const { ext, exchange } = setup(t);
  ext.request = async () => ({ accepted: true });
  const pending = exchange.respond("aaaaaaaaaaaa", "r1", {});
  assert.equal(
    (await exchange.respond("aaaaaaaaaaaa", "r1", {})).code,
    "DECISION_BUSY",
  );
  ext.emit("disconnected", "aaaaaaaaaaaa");
  assert.equal((await pending).code, "EXT_OFFLINE");
  assert.equal(
    (await exchange.respond("aaaaaaaaaaaa", "r1", {})).code,
    "STALE_DECISION",
  );
});
test("a stopped task returns its terminal status and cannot leak the next task state", async (t) => {
  const { ext, exchange } = setup(t);
  ext.request = async () => ({ accepted: true });
  const pending = exchange.respond("aaaaaaaaaaaa", "r1", {});
  ext.emit("agent-turn-end", {
    endpointId: "aaaaaaaaaaaa",
    taskId: "task",
    status: "stopped",
  });
  assert.equal((await pending).status, "stopped");
  assert.equal(exchange.ingest(message("new", 1, "new-task")), false);
});

for (const outcome of ["next", "stopped", "disconnect", "replace", "shutdown"])
  test(`long-running decisions keep waiting and release on ${outcome}`, async (t) => {
    const { ext, exchange } = setup(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    ext.request = async () => {
      calls++;
      return { accepted: true };
    };
    let settled = false;
    const pending = exchange
      .respond("aaaaaaaaaaaa", "r1", {})
      .then((result) => {
        settled = true;
        return result;
      });
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.equal(calls, 1);
    assert.equal(
      (await exchange.respond("aaaaaaaaaaaa", "r1", {})).code,
      "DECISION_BUSY",
    );
    if (outcome === "next") exchange.ingest(message("r2", 2));
    else if (outcome === "stopped")
      ext.emit("agent-turn-end", {
        endpointId: "aaaaaaaaaaaa",
        taskId: "task",
        status: "stopped",
      });
    else if (outcome === "disconnect") ext.emit("disconnected", "aaaaaaaaaaaa");
    else if (outcome === "replace")
      exchange.ingest(message("new", 1, "new-task"));
    else exchange.close();
    const result = await pending;
    if (outcome === "next") assert.equal(result.next.id, "r2");
    else if (outcome === "stopped") assert.equal(result.status, "stopped");
    else
      assert.equal(
        result.code,
        outcome === "replace" ? "STALE_DECISION" : "EXT_OFFLINE",
      );
    assert.equal(calls, 1);
  });

for (const status of ["done", "blocked", "stopped", "interrupted"])
  test(`${status} releases every round's files but preserves another browser's task`, async (t) => {
    const { ext, exchange } = setup(t);
    const initial = exchange.attachmentsFor(message("r1")).materialize(file);
    const otherMessage = { ...message("other"), endpointId: "bbbbbbbbbbbb" };
    exchange.ingest(otherMessage);
    const other = exchange.attachmentsFor(otherMessage).materialize(file);
    ext.request = async () => {
      const next = message("r2", 2);
      next.request.execution = { screenshot: file };
      exchange.ingest(next);
    };
    const response = await exchange.respond("aaaaaaaaaaaa", "r1", {});
    const second = response.next.execution.screenshot;
    assert.ok(fs.existsSync(initial.path) && fs.existsSync(second.path));
    // A stale end event must not delete another task's files.
    ext.emit("agent-turn-end", {
      endpointId: "aaaaaaaaaaaa",
      taskId: "old-task",
      status,
    });
    assert.equal(fs.existsSync(initial.path), true);
    ext.emit("agent-turn-end", {
      endpointId: "aaaaaaaaaaaa",
      taskId: "task",
      status,
    });
    assert.equal(fs.existsSync(initial.path), false);
    assert.equal(fs.existsSync(second.path), false);
    assert.equal(fs.existsSync(other.path), true);
    ext.request = async () => ({ accepted: true });
    const retry = await exchange.respond("aaaaaaaaaaaa", "r1", {});
    assert.equal(
      retry.finished,
      true,
      "terminal retries cannot return deleted image paths",
    );
    assert.equal(retry.next, undefined);
  });

for (const action of ["disconnect", "replace", "shutdown"])
  test(`${action} cleans up files and prevents a pending intake from recreating them`, (t) => {
    const { ext, exchange } = setup(t);
    const scope = exchange.attachmentsFor(message("r1"));
    const saved = scope.materialize(file);
    if (action === "disconnect") ext.emit("disconnected", "aaaaaaaaaaaa");
    else if (action === "replace")
      exchange.ingest(message("new", 1, "new-task"));
    else exchange.close();
    assert.equal(fs.existsSync(saved.path), false);
    assert.throws(() => scope.materialize(file), /task has ended/);
  });
