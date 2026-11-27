#!/usr/bin/env node
"use strict";

// C4 calls channel send scripts with [endpoint, message]. No browser logic here.
import client from "./relay-client.js";
import { parseSendTarget } from "./reply-route.js";

async function main() {
  const [target, message, ...extra] = process.argv.slice(2);
  const route = parseSendTarget(target);
  if (
    extra.length ||
    typeof message !== "string" ||
    !message.trim() ||
    message.trim().length > 8000
  ) {
    throw new Error(
      route.kind === "append"
        ? "Follow-up must contain 1–8000 characters"
        : "Final reply must contain 1–8000 characters",
    );
  }
  if (route.kind === "append") {
    // A follow-up to an ended task: delivered only once the browser confirms it.
    // The same text on the same task is shown once (status existing on resend).
    const { body } = await client.taskAppend({
      endpoint: route.endpoint,
      taskId: route.taskId,
      text: message.trim(),
    });
    process.stdout.write(JSON.stringify(body) + "\n");
    if (!body.ok || body.delivered !== true) process.exitCode = 1;
    else if (body.status === "existing")
      console.error(
        "This follow-up text was already saved and shown on this task earlier; it was not shown again. Nothing more to send.",
      );
    return;
  }
  const { endpoint, id, status, inputId } = route;
  const { body } = await client.decision({
    endpoint,
    id,
    decision: { kind: status, text: message.trim() },
    ...(inputId ? { inputId } : {}),
  });
  process.stdout.write(JSON.stringify(body) + "\n");
  if (body.ok && body.next)
    console.error(
      "New owner input superseded this final reply. Nothing was finalized. Continue with next.replyCommands; do not retry the old final answer.",
    );
  // A transport acknowledgement alone must never be reported as delivered.
  if (!body.ok || !body.finished || body.status !== status)
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(`send.js: ${error.message}`);
  process.exitCode = 2;
});
