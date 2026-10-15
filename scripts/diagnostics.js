#!/usr/bin/env node
import client from "./relay-client.js";

const [endpoint, ...args] = process.argv.slice(2);
try {
  if (!endpoint || args.length % 2) throw new Error("Usage: diagnostics.js <endpointId> [--after N] [--limit N]");
  const body = { endpoint };
  for (let i = 0; i < args.length; i += 2) {
    if (!["--after", "--limit"].includes(args[i]) || !/^\d+$/.test(args[i + 1])) throw new Error("Invalid diagnostics option");
    const key = args[i].slice(2);
    if (key in body) throw new Error("Duplicate diagnostics option");
    body[key] = Number(args[i + 1]);
  }
  const response = await client.diagnostics(body);
  console.log(JSON.stringify(response.body, null, 2));
  if (!response.body.ok) process.exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ ok: false, code: err.code || "DIAGNOSTICS_ERROR", message: err.message }));
  process.exitCode = 1;
}
