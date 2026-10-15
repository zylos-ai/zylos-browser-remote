export const DIAGNOSTICS_CAPABILITY = "diagnostics-v1";
export const DIAGNOSTICS_TIMEOUT_MS = 5000;
export const DIAGNOSTICS_MAX_BYTES = 64 * 1024;
const EVENTS = new Set(["enabled", "detach", "release", "invalidate", "stopped", "socket-close"]);
const REASONS = new Set(["other", "target_closed", "canceled_by_user", "control_changed",
  "operation_changed", "grant_changed", "debugger_detach", "task_complete", "panel_stop",
  "config_disabled", "target_unavailable", "target_refresh_failed", "tab_scope_changed",
  "tab_lost", "window_closed", "pause_timeout", "command_stop", "finalize", "navigation",
  "target_attach", "target_detach", "release", "remote_disconnect"]);

export function diagnosticParams(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["endpoint", "after", "limit"].includes(key)) ||
      (body.after !== undefined && (!Number.isSafeInteger(body.after) || body.after < 0)) ||
      (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200))) {
    throw new Error("Expected endpoint, optional nonnegative integer after, and limit 1..200");
  }
  return { after: body.after ?? 0, limit: body.limit ?? 100 };
}

export function diagnosticResult(value, limit) {
  if (!value || typeof value !== "object" ||
      Buffer.byteLength(JSON.stringify(value)) > DIAGNOSTICS_MAX_BYTES ||
      typeof value.enabled !== "boolean" || typeof value.version !== "string" ||
      !/^[0-9A-Za-z.+_-]{1,80}$/.test(value.version) ||
      !Number.isSafeInteger(value.nextCursor) || value.nextCursor < 0 ||
      !Number.isSafeInteger(value.dropped) || value.dropped < 0 ||
      !Array.isArray(value.events) || value.events.length > limit ||
      (!value.enabled && value.events.length > 0)) {
    throw new Error("Invalid diagnostics response");
  }
  const events = value.events.map((event) => {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
        !Number.isSafeInteger(event.at) || event.at < 0 ||
        !EVENTS.has(event.event) ||
        (event.reason !== undefined && !REASONS.has(event.reason))) {
      throw new Error("Invalid diagnostics event");
    }
    return { seq: event.seq, at: event.at, event: event.event,
      ...(event.reason === undefined ? {} : { reason: event.reason }) };
  });
  return { enabled: value.enabled, version: value.version, events,
    nextCursor: value.nextCursor, dropped: value.dropped };
}
