#!/usr/bin/env node
// Final reply from a thread that does not own the browser address (a task an
// agent started from another session on multi-session Core). Core refuses
// c4-send there (CROSS_SESSION_OUTBOUND), so this hands the reply to the owning
// browser thread with Core's documented internal message; that thread runs the
// exact c4-send command below.
// Usage: handoff-final.js '<endpoint>|req:<id>|status:<done|blocked>[|input:<id>]' < reply.txt
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseReplyEndpoint } from "./reply-route.js";
import { sessionGroupFromEndpoint } from "../src/lib/session-group.js";
import { C4_CHANNEL } from "../src/lib/c4.js";

function scriptsDir(env = process.env) {
  return env.ZYLOS_C4_SCRIPTS ||
    path.join(env.ZYLOS_DIR || path.join(os.homedir(), "zylos"), ".claude/skills/comm-bridge/scripts");
}

/** Full Core group of the thread that owns this browser address. */
export function owningGroup(endpoint, run = execFileSync, env = process.env) {
  const name = sessionGroupFromEndpoint(endpoint);
  const out = run(process.execPath, [path.join(scriptsDir(env), "c4-db.js"), "session-group", C4_CHANNEL,
    "--session-group", name, "--json"], { encoding: "utf8", timeout: 5000, env });
  const parsed = JSON.parse(String(out).trim());
  const group = parsed?.ok === true ? parsed.data : parsed;
  if (typeof group !== "string" || !group.endsWith(`:${name}`)) throw new Error("Core did not resolve the owning browser group");
  return group;
}

/** The internal message: the owning thread can act on it without other context. */
export function handoffMessage(target, text, { sender, delimiter = `EOF_FINAL_${randomBytes(4).toString("hex")}` } = {}) {
  const { endpoint, id, status, inputId } = parseReplyEndpoint(target);
  while (text.includes(delimiter)) delimiter += "_X";
  return [
    `Please deliver to ${C4_CHANNEL} ${target}: the final ${status} reply of browser request ${id} (text below).`,
    `Why: thread ${sender || "(unknown)"} started this browser task on ${endpoint} and is answering request ${id}` +
      `${inputId ? ` (acknowledging owner input ${inputId})` : ""}; only this thread may send to that browser address.`,
    "Run exactly this command once, unchanged; do not edit the text, do not run any browser decision yourself:",
    "",
    `cat <<'${delimiter}' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js ${C4_CHANNEL} '${target}'`,
    text,
    delimiter,
    "",
    `If it fails, tell thread ${sender || "(unknown)"} through its internal reply command and do not retry another way.`,
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: handoff-final.js '<endpoint>|req:<id>|status:<done|blocked>' < reply.txt");
  parseReplyEndpoint(args[0]);
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Final reply exceeds limit");
  }
  text = text.replace(/\s+$/, "");
  if (!text.trim() || text.trim().length > 8000) throw new Error("Final reply must contain 1–8000 characters");
  const group = owningGroup(args[0].split("|")[0]);
  const message = handoffMessage(args[0], text, { sender: process.env.ZYLOS_SESSION_GROUP });
  const out = execFileSync(process.execPath, [path.join(scriptsDir(), "c4-send.js"), "internal", group],
    { input: message, encoding: "utf8", timeout: 30000 });
  process.stdout.write(out);
  console.error(`Handed to the owning browser thread ${group}. The browser task ends when that thread runs the reply; ` +
    "do not send it again through another route.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((err) => {
    console.error(`handoff-final.js: ${err.stderr?.toString().trim() || err.message}`);
    process.exitCode = 2;
  });
