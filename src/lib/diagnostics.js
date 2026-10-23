export const DIAGNOSTICS_CAPABILITY = "diagnostics-v2";
export const DIAGNOSTICS_TIMEOUT_MS = 5000;
export const DIAGNOSTICS_MAX_BYTES = 256 * 1024;
const SOURCES = new Set(["background", "sidepanel", "executor"]);
const LEVELS = new Set(["debug", "info", "warn", "error"]);
// Syntax is a transport bound, not a browser tool or error registry. The
// extension owns semantic classification and must remove private values.
export const diagnosticIdentifier = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const TIMING_FIELDS = ["generation", "scheduledAt", "firedAt", "delayMs", "inboundAgeMs", "outboundAgeMs", "workerUptimeMs"];
const LIFECYCLE_FIELDS = {
  timer: ["freshness", "connect", "reconnect", "handshake", "recovery"],
  phase: ["disconnected", "reconnecting", "restored", "failed", "cleared", "scheduled"],
  visibility: ["visible", "hidden"],
  resumeCategory: ["state_missing", "capability_missing", "runtime_changed", "task_mismatch", "invalid_resume", "request_mismatch", "state_expired"],
};

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
      (value.partialCapture !== undefined && typeof value.partialCapture !== "boolean") ||
      typeof value.enabled !== "boolean" || typeof value.version !== "string" ||
      !/^[0-9A-Za-z.+_-]{1,80}$/.test(value.version) ||
      !Number.isSafeInteger(value.nextCursor) || value.nextCursor < 0 ||
      !Number.isSafeInteger(value.dropped) || value.dropped < 0 ||
      value.nextCursor > value.highWater ||
      (value.hasMore ? value.nextCursor >= value.highWater : value.nextCursor !== value.highWater) ||
      !Array.isArray(value.events) || value.events.length > limit ||
      (!value.enabled && value.events.length > 0)) {
    throw new Error("Invalid diagnostics response");
  }
  let previous = 0;
  const events = value.events.map((event) => {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
        !Number.isSafeInteger(event.at) || event.at < 0 ||
        event.seq <= previous || event.seq > value.nextCursor ||
        !diagnosticIdentifier(event.event) || !SOURCES.has(event.source) || !LEVELS.has(event.level) ||
        (event.task !== undefined && !integer(event.task)) ||
        (event.op !== undefined && !integer(event.op)) ||
        (event.argCount !== undefined && (!integer(event.argCount) || event.argCount > 50)) ||
        (event.count !== undefined && (!integer(event.count) || event.count < 1 || event.count > 1000000)) ||
        (event.closeCode !== undefined && (!integer(event.closeCode) || event.closeCode < 1000 || event.closeCode > 4999)) ||
        TIMING_FIELDS.some(name => event[name] !== undefined && !integer(event[name])) ||
        Object.entries(LIFECYCLE_FIELDS).some(([name, values]) => event[name] !== undefined && !values.includes(event[name])) ||
        ["errorKind", "method", "code", "status", "reason"].some(name => event[name] !== undefined && !diagnosticIdentifier(event[name]))) {
      throw new Error("Invalid diagnostics event");
    }
    previous = event.seq;
    const projected = { seq: event.seq, at: event.at, event: event.event, source: event.source, level: event.level };
    for (const name of ["reason", "task", "op", "argCount", "closeCode", "errorKind", "method", "code", "status", "count", ...TIMING_FIELDS, ...Object.keys(LIFECYCLE_FIELDS)]) {
      if (event[name] !== undefined) projected[name] = event[name];
    }
    return projected;
  });
  return { enabled: value.enabled, version: value.version, events,
    nextCursor: value.nextCursor, dropped: value.dropped, schemaVersion: 2, epoch: value.epoch,
    highWater: value.highWater, oldestCursor: value.oldestCursor, hasMore: value.hasMore,
    truncated: value.truncated, storageHealthy: value.storageHealthy, restartCount: value.restartCount,
    partialCapture: value.partialCapture ?? true };
}
