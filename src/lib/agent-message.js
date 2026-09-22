"use strict";

const AGENT_MESSAGE_CAPABILITY = "agent-message-v2";
const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const validId = (v) =>
  typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
function messageText(message) {
  return (message.content || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// Rollout adapter at ingress only. Everything after this boundary uses v2.
function upgradeLegacy(msg) {
  if (
    typeof msg.text !== "string" ||
    !msg.text.trim() ||
    msg.text.length > 8000 ||
    typeof msg.context !== "string" ||
    msg.context.length > 16000 ||
    !record(msg.payload)
  )
    throw new Error("Invalid legacy request");
  const { initialPage, attachments = [], ...execution } = msg.payload;
  const first = msg.round === 1;
  let page = initialPage;
  if (first && !record(page)) {
    page = JSON.parse(msg.context);
    if (!record(page)) throw new Error("Invalid page context");
  }
  const parts = [{ type: "text", text: msg.text }, ...attachments];
  if (first && page.selection) {
    const { selection, ...rest } = page;
    page = rest;
    parts.push({
      id: msg.taskId.slice(0, 100) + "-quote",
      type: "quote",
      text: selection.text,
      truncated: !!selection.truncated,
      source: { contextId: page.contextId, url: page.url, title: page.title },
    });
  }
  return {
    type: "agent-request",
    version: 2,
    id: msg.id,
    taskId: msg.taskId,
    round: msg.round,
    message: first
      ? { id: msg.taskId, role: "user", content: parts }
      : { id: msg.taskId },
    context: { pages: first ? [page] : [] },
    execution,
  };
}

function normalizeAgentRequest(input) {
  if (
    !validId(input.id) ||
    !validId(input.taskId) ||
    !Number.isInteger(input.round) ||
    input.round < 1 ||
    input.round > 30
  )
    throw new Error("Invalid request identity");
  const msg = input.version === undefined ? upgradeLegacy(input) : input;
  if (
    msg.version !== 2 ||
    "text" in msg ||
    "payload" in msg ||
    !record(msg.message) ||
    msg.message.id !== msg.taskId ||
    !record(msg.context) ||
    Object.keys(msg.context).some((k) => k !== "pages") ||
    !Array.isArray(msg.context.pages) ||
    msg.context.pages.length > 8 ||
    !msg.context.pages.every(record) ||
    JSON.stringify(msg.context).length > 18000 ||
    !record(msg.execution)
  )
    throw new Error("Invalid message envelope");
  if (msg.round === 1) {
    const message = msg.message;
    if (
      message.role !== "user" ||
      Object.keys(message).some(
        (k) => !["id", "role", "content"].includes(k),
      ) ||
      !Array.isArray(message.content) ||
      !message.content.length ||
      message.content.length > 16
    )
      throw new Error("Missing owner message");
    const ids = new Set();
    let attachments = 0;
    for (const part of message.content) {
      if (
        !record(part) ||
        !["text", "quote", "image", "file"].includes(part.type)
      )
        throw new Error("Invalid message content");
      if (part.type === "text") {
        if (
          typeof part.text !== "string" ||
          part.text.length > 8000 ||
          Object.keys(part).some((k) => !["type", "text"].includes(k))
        )
          throw new Error("Invalid message text");
      } else {
        if (++attachments > 8 || !validId(part.id) || ids.has(part.id))
          throw new Error("Invalid attachment identity");
        ids.add(part.id);
        if (
          part.type === "quote" &&
          (typeof part.text !== "string" ||
            !part.text.trim() ||
            part.text.length > 4000 ||
            !record(part.source))
        )
          throw new Error("Invalid quote");
        // Binary validation/materialization happens before Agent delivery.
        if (
          ["image", "file"].includes(part.type) &&
          (typeof part.data !== "string" || typeof part.mimeType !== "string")
        )
          throw new Error("Invalid binary attachment");
      }
    }
    const text = messageText(message);
    if (!text.trim() || text.length > 8000)
      throw new Error("Invalid owner text");
  } else if (
    Object.keys(msg.message).length !== 1 ||
    msg.context.pages.length
  ) {
    throw new Error("Continuation must reference the original message");
  }
  // Do not trust endpoint/routing fields supplied by a client.
  return {
    version: 2,
    id: msg.id,
    taskId: msg.taskId,
    round: msg.round,
    message: msg.message,
    context: msg.context,
    execution: msg.execution,
  };
}
module.exports = {
  AGENT_MESSAGE_CAPABILITY,
  normalizeAgentRequest,
  messageText,
};
