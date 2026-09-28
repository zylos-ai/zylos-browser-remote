#!/usr/bin/env node
"use strict";

// C4 calls channel send scripts with [endpoint, message]. No browser logic here.
import client from "./relay-client.js";
import { parseReplyEndpoint } from "./reply-route.js";

async function main() {
  const [target, message, ...extra] = process.argv.slice(2);
  const { endpoint, id, status } = parseReplyEndpoint(target);
  if (
    extra.length ||
    typeof message !== "string" ||
    !message.trim() ||
    message.trim().length > 8000
  ) {
    throw new Error("Final reply must contain 1–8000 characters");
  }
  const { body } = await client.decision({
    endpoint,
    id,
    decision: { kind: status, text: message.trim() },
  });
  process.stdout.write(JSON.stringify(body) + "\n");
  // A transport acknowledgement alone must never be reported as delivered.
  if (!body.ok || !body.finished || body.status !== status)
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(`send.js: ${error.message}`);
  process.exitCode = 2;
});
