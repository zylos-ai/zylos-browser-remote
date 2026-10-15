export const DIAGNOSTICS_CAPABILITY = "diagnostics-v2";
export const DIAGNOSTICS_TIMEOUT_MS = 5000;
export const DIAGNOSTICS_MAX_BYTES = 256 * 1024;
const EVENTS = new Set(["enabled", "detach", "release", "invalidate", "stopped", "socket-close",
  "runtime-error", "unhandled-rejection", "console", "task-start", "task-end", "task-cancel",
  "operation-start", "operation-result", "operation-error", "transport-connect", "transport-open",
  "transport-ready", "transport-error", "request", "response", "storage-error", "worker-start", "capture-overflow"]);
const SOURCES = new Set(["background", "sidepanel", "executor"]);
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const ERROR_KINDS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AggregateError", "Other"]);
const METHODS = new Set(["open", "new-tab", "switch-tab", "tabs", "snapshot", "observe", "find", "inspect",
  "frames", "click", "hover", "double-click", "right-click", "drag", "select", "check", "back", "forward",
  "reload", "fill", "type", "scroll", "keypress", "wait-for-page", "dialog", "close-tab", "finalize",
  "read-page", "use-current-tab", "record-findings", "read-findings", "agent-decision", "diagnostics.get", "other"]);
const CODES = new Set(["OTHER", "STORAGE_READ_FAILED", "STORAGE_WRITE_FAILED", "BAD_PARAMS", "UNKNOWN_METHOD",
  "PROTOCOL_MISMATCH", "SOCKET_ERROR", "INVALID_RELAY", "STOPPED", "PAGE_CHANGED", "COMMAND_EXPIRED",
  "CONTROL_NOT_GRANTED", "NO_CONTROLLABLE_TAB", "TASK_TAB_UNAVAILABLE", "TAB_NOT_GRANTED", "DEBUGGER_DETACH_FAILED",
  "EXT_ERROR", "BAD_DECISION", "DIAGNOSTICS_RESET", "BLOCKED_URL", "DIALOG_OPEN", "FRAME_UNAVAILABLE",
  "INVALID_TASK_SOURCE", "INVALID_URL", "NO_DIALOG", "NO_HISTORY_ENTRY", "OBSERVATION_UNAVAILABLE", "PAGE_LOADING",
  "SCREENSHOT_TOO_LARGE", "STALE_TASK", "TAB_UNAVAILABLE", "TASK_TAB_LIMIT", "UNSUPPORTED_PAGE", "UNSUPPORTED_WINDOW",
  "NO_WINDOW", "SENSITIVE_INPUT", "REQUEST_ID_CONFLICT", "PAGE_CONTENT_CHANGED"]);
const STATUSES = new Set(["success", "error", "cancelled", "done", "blocked", "stopped", "interrupted"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const REASONS = new Set(["other", "target_closed", "canceled_by_user", "control_changed",
  "operation_changed", "grant_changed", "debugger_detach", "task_complete", "panel_stop",
  "config_disabled", "target_unavailable", "target_refresh_failed", "tab_scope_changed",
  "tab_lost", "window_closed", "pause_timeout", "command_stop", "finalize", "navigation",
  "target_attach", "target_detach", "release", "remote_disconnect"]);

export function diagnosticParams(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["endpoint", "after", "limit", "epoch", "through", "level", "source", "task"].includes(key)) ||
      (body.after !== undefined && (!Number.isSafeInteger(body.after) || body.after < 0)) ||
      (body.epoch !== undefined && (typeof body.epoch !== "string" || !UUID.test(body.epoch))) ||
      (body.through !== undefined && (!integer(body.through) || body.through < (body.after ?? 0))) ||
      (body.task !== undefined && !integer(body.task)) ||
      (body.level !== undefined && !LEVELS.has(body.level)) ||
      (body.source !== undefined && !SOURCES.has(body.source)) ||
      (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200))) {
    throw new Error("Expected endpoint, optional nonnegative integer after, and limit 1..200");
  }
  const result = { after: body.after ?? 0, limit: body.limit ?? 100 };
  for (const name of ["epoch", "through", "level", "source", "task"]) {
    if (body[name] !== undefined) result[name] = body[name];
  }
  return result;
}

export function diagnosticResult(value, limit) {
  if (!value || typeof value !== "object" ||
      Buffer.byteLength(JSON.stringify(value)) > DIAGNOSTICS_MAX_BYTES ||
      value.schemaVersion !== 2 || typeof value.epoch !== "string" || !UUID.test(value.epoch) ||
      !integer(value.highWater) || !integer(value.oldestCursor) || !integer(value.restartCount) ||
      typeof value.hasMore !== "boolean" || typeof value.truncated !== "boolean" || typeof value.storageHealthy !== "boolean" ||
      typeof value.enabled !== "boolean" || typeof value.version !== "string" ||
      !/^[0-9A-Za-z.+_-]{1,80}$/.test(value.version) ||
      !Number.isSafeInteger(value.nextCursor) || value.nextCursor < 0 ||
      !Number.isSafeInteger(value.dropped) || value.dropped < 0 ||
      value.nextCursor > value.highWater ||
      !Array.isArray(value.events) || value.events.length > limit ||
      (!value.enabled && value.events.length > 0)) {
    throw new Error("Invalid diagnostics response");
  }
  let previous = 0;
  const events = value.events.map((event) => {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
        !Number.isSafeInteger(event.at) || event.at < 0 ||
        event.seq <= previous || event.seq > value.nextCursor ||
        !EVENTS.has(event.event) || !SOURCES.has(event.source) || !LEVELS.has(event.level) ||
        (event.task !== undefined && !integer(event.task)) ||
        (event.op !== undefined && !integer(event.op)) ||
        (event.argCount !== undefined && (!integer(event.argCount) || event.argCount > 50)) ||
        (event.count !== undefined && (!integer(event.count) || event.count < 1 || event.count > 1000000)) ||
        (event.closeCode !== undefined && (!integer(event.closeCode) || event.closeCode < 1000 || event.closeCode > 4999)) ||
        (event.errorKind !== undefined && !ERROR_KINDS.has(event.errorKind)) ||
        (event.method !== undefined && !METHODS.has(event.method)) ||
        (event.code !== undefined && !CODES.has(event.code)) ||
        (event.status !== undefined && !STATUSES.has(event.status)) ||
        (event.reason !== undefined && !REASONS.has(event.reason))) {
      throw new Error("Invalid diagnostics event");
    }
    previous = event.seq;
    const projected = { seq: event.seq, at: event.at, event: event.event, source: event.source, level: event.level };
    for (const name of ["reason", "task", "op", "argCount", "closeCode", "errorKind", "method", "code", "status", "count"]) {
      if (event[name] !== undefined) projected[name] = event[name];
    }
    return projected;
  });
  return { enabled: value.enabled, version: value.version, events,
    nextCursor: value.nextCursor, dropped: value.dropped, schemaVersion: 2, epoch: value.epoch,
    highWater: value.highWater, oldestCursor: value.oldestCursor, hasMore: value.hasMore,
    truncated: value.truncated, storageHealthy: value.storageHealthy, restartCount: value.restartCount };
}
