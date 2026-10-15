#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import client from "./relay-client.js";
import { diagnosticParams, diagnosticResult } from "../src/lib/diagnostics.js";

export function parseDiagnosticsArgs(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, tokens: true,
      options: { all: { type: "boolean" }, format: { type: "string" },
        after: { type: "string" }, limit: { type: "string" },
        level: { type: "string" }, source: { type: "string" }, task: { type: "string" } } });
  } catch { throw new Error("Invalid diagnostics options"); }
  if (parsed.positionals.length !== 1) throw new Error("Usage: diagnostics.js <endpointId> [--all] [--format json|ndjson] [--after N] [--limit N] [--level LEVEL] [--source SOURCE] [--task N]");
  const names = parsed.tokens.filter(t => t.kind === "option").map(t => t.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate diagnostics option");
  const { all = false, format = "json", ...values } = parsed.values;
  if (!["json", "ndjson"].includes(format)) throw new Error("format must be json or ndjson");
  for (const name of ["after", "limit", "task"]) {
    if (values[name] !== undefined) {
      if (!/^\d+$/.test(values[name])) throw new Error("Invalid numeric diagnostics option");
      values[name] = Number(values[name]);
    }
  }
  const endpoint = parsed.positionals[0];
  return { all, format, body: { endpoint, ...diagnosticParams({ endpoint, ...values }) } };
}

export async function exportDiagnostics(body, { all = false, client: transport = client } = {}) {
  const events = [];
  const started = Date.now();
  let snapshot, last, truncated = false, bytes = 0;
  let query = { ...body };
  for (let page = 0; page < 20; page++) {
    if (Date.now() - started > 30000) return incomplete("EXPORT_LIMIT");
    let response;
    try { response = await transport.diagnostics(query); }
    catch { return incomplete("EXPORT_TRANSPORT_ERROR"); }
    if (!response.body.ok) {
      const codes = ["EXT_OFFLINE", "EXT_TIMEOUT", "DIAGNOSTICS_RESET", "DIAGNOSTICS_UNSUPPORTED", "BAD_REQUEST", "BAD_PARAMS", "BAD_ENDPOINT", "UNKNOWN_ENDPOINT", "RELAY_DOWN", "BAD_DIAGNOSTICS_RESPONSE", "DIAGNOSTICS_ERROR"];
      return incomplete(codes.includes(response.body.code) ? response.body.code : "EXPORT_TRANSPORT_ERROR");
    }
    if (response.body.endpointId !== body.endpoint) return incomplete("EXPORT_INVALID_PAGE");
    let result;
    try { result = { ok: true, endpointId: body.endpoint, ...diagnosticResult(response.body, body.limit ?? 100) }; }
    catch { return incomplete("EXPORT_INVALID_PAGE"); }
    if (!snapshot) snapshot = { epoch: result.epoch, highWater: result.highWater, after: body.after ?? 0, dropped: result.dropped };
    if (result.epoch !== snapshot.epoch || result.highWater !== snapshot.highWater) return incomplete("DIAGNOSTICS_RESET");
    if (result.nextCursor < (query.after ?? 0) || result.nextCursor > snapshot.highWater ||
        result.events.some(event => event.seq <= (query.after ?? 0)) ||
        (result.hasMore && result.nextCursor <= (query.after ?? 0))) return incomplete("EXPORT_INVALID_PAGE");
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > 1024 * 1024 || events.length + result.events.length > 4000) return incomplete("EXPORT_LIMIT");
    truncated ||= result.truncated || result.dropped > 0 || !result.storageHealthy || result.restartCount > 0 || !result.enabled;
    events.push(...result.events);
    last = result;
    if (!all || !result.hasMore) return { ...last, events, snapshot, truncated, complete: !result.hasMore && !truncated };
    query = { ...body, after: result.nextCursor, epoch: snapshot.epoch, through: snapshot.highWater };
  }
  return incomplete("EXPORT_LIMIT");

  function incomplete(code) {
    return { ok: false, code, message: "Diagnostics export is incomplete", endpointId: body.endpoint,
      events, snapshot, complete: false, truncated: true, nextCursor: last?.nextCursor };
  }
}

export function formatDiagnostics(result, format) {
  if (format === "json") return JSON.stringify(result, null, 2);
  const { events = [], ...metadata } = result;
  return [JSON.stringify({ type: "metadata", ...metadata }),
    ...events.map(event => JSON.stringify({ type: "event", ...event }))].join("\n");
}

async function main() {
  try {
    const { all, format, body } = parseDiagnosticsArgs(process.argv.slice(2));
    const result = await exportDiagnostics(body, { all });
    console.log(formatDiagnostics(result, format));
    if (!result.ok || (all && !result.complete)) process.exitCode = 1;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, code: err.code || "DIAGNOSTICS_ERROR", message: err.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
