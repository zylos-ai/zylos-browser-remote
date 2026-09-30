import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAgentRequest,
  messageText,
} from "../src/lib/agent-message.js";
const request = () => ({
  type: "agent-request",
  version: 2,
  id: "r1",
  taskId: "t1",
  round: 1,
  message: {
    id: "t1",
    role: "user",
    content: [
      { type: "text", text: "Explain this" },
      {
        type: "quote",
        id: "q1",
        text: "Quoted evidence",
        truncated: false,
        source: { contextId: "t1", url: "https://example.com" },
      },
    ],
  },
  context: { pages: [{ contextId: "t1", text: "PAGE_CONTENT_ONCE" }] },
  execution: {
    protocol: "browser-decision-v1",
    mode: "reading",
    tools: [{ name: "opaque-tool" }],
  },
});
test("steering preserves ordered owner messages without changing the task or routing", () => {
  const update = {
    message: { ...request().message, id: "u1" },
    context: request().context,
  };
  const continuation = {
    ...request(),
    id: "r2",
    round: 2,
    message: { id: "t1" },
    context: { pages: [] },
    updates: [update],
  };
  const result = normalizeAgentRequest(continuation);
  assert.equal(result.taskId, "t1");
  assert.deepEqual(result.updates, [update]);
  for (const updates of [
    [],
    [update, update],
    [{ ...update, endpointId: "another-browser" }],
    [{ ...update, message: { ...update.message, role: "system" } }],
    [{ ...update, message: { ...update.message, id: "t1" } }],
    [{ ...update, context: { pages: [{ text: "x".repeat(18001) }] } }],
    Array.from({ length: 9 }, (_, i) => ({
      ...update,
      message: { ...update.message, id: `u${i}` },
    })),
  ])
    assert.throws(() => normalizeAgentRequest({ ...continuation, updates }));
  assert.throws(() =>
    normalizeAgentRequest({ ...request(), updates: [update] }),
  );
});
test("v2 carries one source of each input and strips caller-supplied routing fields", () => {
  const normalized = normalizeAgentRequest({
    ...request(),
    endpointId: "wrong-browser",
  });
  assert.equal(normalized.endpointId, undefined);
  assert.equal(normalized.payload, undefined);
  assert.equal(normalized.text, undefined);
  assert.equal(messageText(normalized.message), "Explain this");
  assert.equal(JSON.stringify(normalized).split("PAGE_CONTENT_ONCE").length, 2);
  const next = normalizeAgentRequest({
    ...request(),
    id: "r2",
    round: 2,
    message: { id: "t1" },
    context: { pages: [] },
    execution: { observation: { text: "fresh" } },
  });
  assert.deepEqual(next.message, { id: "t1" });
  assert.deepEqual(next.execution.observation, { text: "fresh" });
});
test("ambiguous layouts, cross-message references, repeated bodies and oversized content are rejected", () => {
  for (const invalid of [
    { version: 3 },
    { payload: {} },
    { text: "duplicate owner text" },
    { context: "{}" },
    { message: { ...request().message, id: "other-task" } },
    { message: { id: "t1" } },
    { round: 2 },
    { context: { pages: [{ text: "x".repeat(18000) }] } },
    {
      message: {
        id: "t1",
        role: "user",
        content: [{ type: "text", text: "x".repeat(8001) }],
      },
    },
    {
      message: {
        ...request().message,
        content: [...request().message.content, request().message.content[1]],
      },
    },
    {
      message: {
        id: "t1",
        role: "user",
        content: [{ type: "html", text: "not supported" }],
      },
    },
  ])
    assert.throws(() => normalizeAgentRequest({ ...request(), ...invalid }));
});
test("continuation rounds have no task cap but must be positive safe integers", () => {
  const continuation = {
    ...request(),
    message: { id: "t1" },
    context: { pages: [] },
  };
  for (const round of [30, 31, 1000, Number.MAX_SAFE_INTEGER])
    assert.equal(
      normalizeAgentRequest({ ...continuation, round }).round,
      round,
    );
  for (const round of [
    0,
    -1,
    1.5,
    "31",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => normalizeAgentRequest({ ...continuation, round }));
});
test("older clients are normalized once at ingress including their selected passage", () => {
  const legacy = {
    id: "r1",
    taskId: "t1",
    round: 1,
    text: "Explain",
    context: "{}",
    payload: {
      initialPage: {
        contextId: "t1",
        text: "Page",
        selection: { text: "Quote" },
      },
      tools: [{ name: "read-page" }],
    },
  };
  const normalized = normalizeAgentRequest(legacy);
  assert.equal(normalized.version, 2);
  assert.equal(normalized.message.content[1].text, "Quote");
  assert.equal(normalized.context.pages[0].selection, undefined);
  assert.equal(normalized.execution.initialPage, undefined);
  assert.deepEqual(normalized.execution.tools, legacy.payload.tools);
  assert.deepEqual(
    normalizeAgentRequest({ ...legacy, id: "r2", round: 2 }).message,
    { id: "t1" },
  );
});
