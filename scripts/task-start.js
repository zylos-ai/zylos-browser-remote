#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import client from "./relay-client.js";
import { taskStartParams, taskStartResult } from "../src/lib/task-start.js";

export function parseTaskStart(args, input) {
  if (args.length !== 2) throw new Error("Usage: task-start.js <endpoint> <requestId> < request.json");
  const payload = JSON.parse(input);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some(key => !["prompt", "url"].includes(key))) throw new Error("Expected prompt and url");
  const body = { endpoint: args[0], requestId: args[1], ...payload };
  taskStartParams(body);
  return body;
}

export async function startTask(body, transport = client) {
  taskStartParams(body);
  const response = await transport.taskStart(body);
  if (!response.body.ok) return response.body;
  if (response.body.endpointId !== body.endpoint) throw new Error("Task start endpoint mismatch; outcome unknown");
  const { ok, endpointId, ...result } = response.body;
  return { ok, endpointId, ...taskStartResult(result, body.requestId) };
}

async function main() {
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 128 * 1024) throw new Error("Task start input exceeds limit");
    }
    const result = await startTask(parseTaskStart(process.argv.slice(2), input));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, code: "TASK_START_ERROR", message: err.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
