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
  if (snapshot?.schemaVersion === 2) {
    validateIncidentBundle(snapshot, invalid);
    snapshot = snapshot.capture;
  }
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

function validateIncidentBundle(bundle, invalid) {
  const action = value => bounded(value, 200) && /^[0-9a-f-]{36}(?::[a-zA-Z0-9_-]{1,32}){0,5}$/.test(value);
  const finite = value => Number.isFinite(value) && value >= 0;
  const strings = (value, count, length) => Array.isArray(value) && value.length <= count && value.every(item => bounded(item, length));
  const runtime = value => keys(value, ["connected", "control", "granted", "scope", "groupReference"]) &&
    ["connected", "control", "granted"].every(key => typeof value[key] === "boolean") &&
    ["none", "borrowed", "owned"].includes(value.scope) && ["none", "assigned"].includes(value.groupReference);
  const page = value => keys(value, ["status", "observedAt", "state"]) && finite(value.observedAt) &&
    ["captured", "unavailable", "stale", "pending"].includes(value.status) &&
    (value.status === "captured" ? validState(value.state) : value.state === undefined);
  const validState = state => keys(state, ["visibility", "readyState", "scheme", "iframeCount", "iframeCountCapped", "focusedElement", "inputFocused", "inputDisabled", "inputReadOnly"]) &&
    ["visible", "hidden", "other"].includes(state.visibility) && ["loading", "interactive", "complete"].includes(state.readyState) &&
    ["http", "https"].includes(state.scheme) && ["input", "textarea", "select", "button", "other", "none"].includes(state.focusedElement) &&
    natural(state.iframeCount) && state.iframeCount <= 512 &&
    ["iframeCountCapped", "inputFocused", "inputDisabled", "inputReadOnly"].every(key => typeof state[key] === "boolean");
  if (!keys(bundle, ["schemaVersion", "kind", "capture", "clock", "previewRuntime", "correlations", "incidents", "limitations"]) ||
      bundle.kind !== "browser-incident-bundle" ||
      !keys(bundle.clock, ["epoch", "source", "remoteComparable"]) || bundle.clock.epoch !== "unix-ms" ||
      bundle.clock.source !== "extension-Date.now" || bundle.clock.remoteComparable !== false ||
      !runtime(bundle.previewRuntime) ||
      !strings(bundle.limitations, 32, 4096) || !Array.isArray(bundle.correlations) || bundle.correlations.length > 256 ||
      !Array.isArray(bundle.incidents) || bundle.incidents.length > 8) invalid();
  for (const item of bundle.correlations) {
    if (!keys(item, ["taskId", "actionId", "task", "operation", "method", "startedAt", "endedAt", "outcome"]) ||
        !uuid(item.taskId) || !action(item.actionId) || !bounded(item.method, 40) || !/^[a-z-]+$/.test(item.method) ||
        !finite(item.startedAt) || (item.endedAt !== undefined && (!finite(item.endedAt) || item.endedAt < item.startedAt)) ||
        !["running", "completed", "error"].includes(item.outcome) ||
        ["task", "operation"].some(key => item[key] !== undefined && !natural(item[key]))) invalid();
  }
  for (const item of bundle.incidents) {
    if (!keys(item, ["incidentId", "taskId", "actionId", "task", "operation", "trigger", "reason", "triggeredAt", "window", "recordSequences", "runtimeAtTrigger", "pageBefore", "pageState"]) ||
        !uuid(item.incidentId) || (item.taskId !== undefined && !uuid(item.taskId)) || (item.actionId !== undefined && !action(item.actionId)) ||
        ((item.taskId === undefined) !== (item.actionId === undefined)) ||
        ["task", "operation"].some(key => item[key] !== undefined && !natural(item[key])) ||
        !runtime(item.runtimeAtTrigger) || !page(item.pageBefore) || !page(item.pageState) ||
        !["debugger-detach", "control-lost", "operation-error"].includes(item.trigger) || !["target_closed", "canceled_by_user", "other"].includes(item.reason) ||
        !finite(item.triggeredAt) || !keys(item.window, ["from", "to", "through", "complete", "gaps"]) ||
        !["from", "to", "through"].every(key => finite(item.window[key])) ||
        item.window.from > item.triggeredAt || item.window.to < item.triggeredAt ||
        item.triggeredAt - item.window.from > 30000 || item.window.to - item.triggeredAt > 2000 ||
        item.window.through < item.window.from || item.window.through > item.window.to || item.window.complete !== false ||
        !strings(item.window.gaps, 32, 1024) || !Array.isArray(item.recordSequences) || item.recordSequences.length > 1000 ||
        !item.recordSequences.every(sequence => natural(sequence) && bundle.capture?.records?.some(record => record.sequence === sequence &&
          record.at >= item.window.from && record.at <= item.window.to && (item.task === undefined || record.task === item.task)))) invalid();
    const correlation = bundle.correlations.find(c => c.taskId === item.taskId && c.actionId === item.actionId);
    if (correlation && ["task", "operation"].some(key => item[key] !== undefined && correlation[key] !== item[key])) invalid();
  }
}
