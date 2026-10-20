import { createHash } from "node:crypto";
import { ENDPOINT_RE } from "./endpoint.js";

export const DETAIL_CAPABILITY = "diagnostics-detail-share-v1";
export const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
const natural = v => Number.isSafeInteger(v) && v >= 0;
const uuid = v => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const bounded = (v, max) => typeof v === "string" && v.length <= max;

export function detailParams(body) {
  if (!keys(body, ["endpoint"]) || typeof body.endpoint !== "string" ||
      !ENDPOINT_RE.test(body.endpoint) || !body.endpoint.includes(".")) {
    throw new Error("An exact browser endpoint is required");
  }
  return {};
}

// Validate the received representation without rewriting the owner-previewed text.
export function detailResult(value) {
  const invalid = () => { throw new Error("Invalid detailed diagnostics response"); };
  if (!keys(value, ["schemaVersion", "text", "sha256"]) || value.schemaVersion !== 1 ||
      typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > DETAIL_MAX_BYTES ||
      typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      createHash("sha256").update(value.text, "utf8").digest("hex") !== value.sha256) invalid();
  let snapshot;
  try { snapshot = JSON.parse(value.text); } catch { invalid(); }
  if (!keys(snapshot, ["schemaVersion", "enabled", "expiresAt", "count", "bytes", "dropped", "truncated",
    "runtimeEpoch", "captureId", "extensionVersion", "build", "exportedAt", "partial", "limits", "limitations", "records"]) ||
      snapshot.schemaVersion !== 1 || snapshot.enabled !== true || snapshot.partial !== true ||
      !["expiresAt", "count", "bytes", "dropped", "truncated"].every(k => natural(snapshot[k])) ||
      !uuid(snapshot.runtimeEpoch) || !uuid(snapshot.captureId) ||
      !bounded(snapshot.extensionVersion, 80) || !bounded(snapshot.build, 200) ||
      !bounded(snapshot.exportedAt, 40) || !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
      !bounded(snapshot.limitations, 4096) ||
      !keys(snapshot.limits, ["durationMs", "bytes", "events", "textChars"]) ||
      !["durationMs", "bytes", "events", "textChars"].every(k => natural(snapshot.limits[k])) ||
      !Array.isArray(snapshot.records) || snapshot.records.length > 1000 || snapshot.count !== snapshot.records.length) invalid();
  let previous = 0;
  for (const record of snapshot.records) {
    if (!keys(record, ["kind", "level", "at", "text", "truncated", "lost", "source", "sequence", "task", "operation"]) ||
        !["console", "error", "unhandledrejection", "panel-loss"].includes(record.kind) ||
        !["debug", "log", "info", "warn", "error"].includes(record.level) ||
        !Number.isFinite(record.at) || !bounded(record.text, 16384) || typeof record.truncated !== "boolean" ||
        !["background", "sidepanel"].includes(record.source) || !natural(record.sequence) || record.sequence <= previous ||
        ["lost", "task", "operation"].some(k => record[k] !== undefined && !natural(record[k]))) invalid();
    previous = record.sequence;
  }
  return { schemaVersion: 1, text: value.text, sha256: value.sha256 };
}
