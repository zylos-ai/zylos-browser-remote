#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import client from "./relay-client.js";
import { detailParams, detailResult } from "../src/lib/detail-diagnostics.js";

export function parseDetailArgs(args) {
  if (args.length !== 1) throw new Error("Usage: detail-diagnostics.js <exact-endpointId>");
  const body = { endpoint: args[0] };
  detailParams(body);
  return body;
}

export async function fetchDetail(body, transport = client) {
  const failed = code => ({ ok: false, code, message: "Detailed diagnostics unavailable; do not retry automatically" });
  try {
    detailParams(body);
    const response = await transport.detailDiagnostics(body);
    const value = response.body;
    if (value?.ok !== true) {
      const known = ["EXT_OFFLINE", "EXT_TIMEOUT", "DETAIL_SHARE_UNAVAILABLE", "DETAIL_SHARE_UNSUPPORTED", "BAD_REQUEST",
        "BAD_ENDPOINT", "UNKNOWN_ENDPOINT", "BAD_DETAIL_RESPONSE", "DETAIL_SHARE_ERROR", "RELAY_DOWN"];
      return failed(known.includes(value?.code) ? value.code : "DETAIL_SHARE_ERROR");
    }
    if (value.endpointId !== body.endpoint || Object.keys(value).some(k => !["ok", "endpointId", "schemaVersion", "text", "sha256"].includes(k))) return failed("BAD_DETAIL_RESPONSE");
    const { schemaVersion, text, sha256 } = value;
    return { ok: true, endpointId: body.endpoint, ...detailResult({ schemaVersion, text, sha256 }) };
  } catch { return failed("DETAIL_SHARE_ERROR"); }
}

async function main() {
  try {
    const body = parseDetailArgs(process.argv.slice(2));
    const result = await fetchDetail(body);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ ok: false, code: "BAD_REQUEST", message: "Usage: detail-diagnostics.js <exact-endpointId>" }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
