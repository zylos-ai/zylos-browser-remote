import { randomUUID } from "node:crypto";

const id = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
export function bestEffortEvidence(operation) {
  try { return operation(); } catch { return undefined; }
}
// Names from extension utils/tool-catalog.ts. Unknown names never become free text.
export const INCIDENT_METHODS = new Set(["use-current-tab", "read-page", "wait-for-page", "record-findings", "read-findings", "open", "new-tab", "switch-tab", "tabs", "frames", "snapshot", "observe", "find", "inspect", "click", "hover", "double-click", "right-click", "drag", "fill", "type", "select", "check", "scroll", "keypress", "back", "forward", "reload", "dialog", "other"]);

export function validateIncidentEvidence(value, endpoint, bundle) {
  const keys = (v, names) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => names.includes(k));
  const natural = v => Number.isSafeInteger(v) && v >= 0;
  const uuid = v => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
  if (!keys(value, ["schemaVersion", "endpointId", "epoch", "clock", "clockAligned", "capturedAt", "startedAt", "retentionMs", "dropped", "connection", "records", "partial", "gaps"]) ||
      value.schemaVersion !== 1 || value.endpointId !== endpoint || !uuid(value.epoch) || value.clock !== "remote-Date.now-receipt" ||
      value.clockAligned !== false || value.partial !== true || !["capturedAt", "startedAt", "retentionMs", "dropped"].every(k => natural(value[k])) ||
      value.retentionMs > 120000 || value.startedAt > value.capturedAt ||
      !Array.isArray(value.gaps) || value.gaps.length > 16 || value.gaps.some(g => typeof g !== "string" || g.length > 1024) ||
      !Array.isArray(value.records) || value.records.length > 2000 || Buffer.byteLength(JSON.stringify(value.records)) > 512 * 1024 ||
      (value.connection !== null && (!keys(value.connection, ["connectedAt", "generation", "resumed"]) || typeof value.connection.resumed !== "boolean" ||
        !natural(value.connection.connectedAt) || value.connection.connectedAt > value.capturedAt || !uuid(value.connection.generation)))) return false;
  return value.records.every(record => {
    const fields = { action: ["actionId", "phase", "method", "outcome"], request: ["requestId"], delivery: ["requestId", "state"], terminal: ["status"], rejected: ["reason"] };
    if (!fields[record?.kind] || !keys(record, ["kind", "taskId", "receivedAt", ...fields[record.kind]]) || !id(record.taskId) || !natural(record.receivedAt) ||
        record.receivedAt > value.capturedAt || record.receivedAt < value.capturedAt - value.retentionMs ||
        !bundle.correlations.some(item => item.taskId === record.taskId && (record.kind !== "action" || item.actionId === record.actionId))) return false;
    if (record.kind === "action") return id(record.actionId) && INCIDENT_METHODS.has(record.method) &&
      (record.phase === "start" ? record.outcome === undefined : record.phase === "end" && ["error-reported", "result-reported"].includes(record.outcome));
    if (record.kind === "request") return id(record.requestId);
    if (record.kind === "rejected") return ["task-mismatch", "oversized", "malformed"].includes(record.reason);
    if (record.kind === "delivery") return (record.requestId === undefined || id(record.requestId)) && ["queued", "unknown", "failed"].includes(record.state);
    return ["done", "blocked", "interrupted", "stopped", "unknown"].includes(record.status);
  });
}

// This store contains transport metadata only. It never accepts page content,
// action parameters, error messages, connection keys, or raw Monitor records.
export class IncidentEvidence {
  constructor({ now = Date.now, ttlMs = 120000, maxRecords = 2000, maxEndpoints = 32, maxBytes = 512 * 1024 } = {}) {
    Object.assign(this, { now, ttlMs, maxRecords, maxEndpoints, maxBytes });
    this.epoch = randomUUID();
    this.records = [];
    this.dropped = 0;
    this.startedAt = now();
    this.connections = new Map();
  }
  prune() {
    const cutoff = this.now() - this.ttlMs;
    while (this.records.length && this.records[0].receivedAt < cutoff) { this.records.shift(); this.dropped++; }
    while (this.records.length > this.maxRecords || Buffer.byteLength(JSON.stringify(this.records)) > this.maxBytes) { this.records.shift(); this.dropped++; }
  }
  connection(endpoint, connected, verifiedResumeTaskId = null) {
    if (!connected) { this.connections.delete(endpoint); return; }
    // Only ExtLane's verified same-runtime/task resume may retain old records.
    this.prune();
    const resumed = id(verifiedResumeTaskId);
    this.records = this.records.filter(record => record.endpoint !== endpoint ||
      (resumed && record.taskId === verifiedResumeTaskId));
    this.connections.delete(endpoint);
    this.connections.set(endpoint, { connectedAt: this.now(), generation: randomUUID(), resumed });
    while (this.connections.size > this.maxEndpoints) {
      const oldest = this.connections.keys().next().value;
      this.connections.delete(oldest);
      this.records = this.records.filter(record => record.endpoint !== oldest);
      this.dropped++;
    }
  }
  record(endpoint, kind, event = {}) {
    this.prune();
    if (!this.connections.has(endpoint) || !id(event.taskId)) return;
    const record = { endpoint, kind, taskId: event.taskId, receivedAt: this.now() };
    if (kind === "action") {
      if (!id(event.id) || !["start", "end"].includes(event.phase)) return;
      Object.assign(record, { actionId: event.id, phase: event.phase, method: INCIDENT_METHODS.has(event.method) ? event.method : "other" });
      if (event.phase === "end") record.outcome = event.error ? "error-reported" : "result-reported";
    } else if (kind === "rejected") {
      if (!["task-mismatch", "oversized", "malformed"].includes(event.reason)) return;
      record.reason = event.reason;
    } else if (kind === "request") {
      if (!id(event.id)) return;
      record.requestId = event.id;
    } else if (kind === "delivery") {
      record.state = ["queued", "unknown", "failed"].includes(event.state) ? event.state : "unknown";
      if (id(event.id)) record.requestId = event.id;
    } else if (kind === "terminal") {
      record.status = ["done", "blocked", "interrupted", "stopped"].includes(event.status) ? event.status : "unknown";
    } else return;
    this.records.push(record);
    this.prune();
  }
  snapshot(endpoint, bundle) {
    this.prune();
    const mappings = bundle.correlations;
    const tasks = new Set(mappings.map(item => item.taskId));
    const actions = new Set(mappings.map(item => `${item.taskId}\0${item.actionId}`));
    const records = this.records.filter(record => record.endpoint === endpoint && tasks.has(record.taskId) &&
      (record.kind !== "action" || actions.has(`${record.taskId}\0${record.actionId}`)))
      .map(({ endpoint: _endpoint, ...record }) => ({ ...record }));
    return { schemaVersion: 1, endpointId: endpoint, epoch: this.epoch, clock: "remote-Date.now-receipt", clockAligned: false,
      capturedAt: this.now(), startedAt: this.startedAt, retentionMs: this.ttlMs, dropped: this.dropped,
      connection: this.connections.has(endpoint) ? structuredClone(this.connections.get(endpoint)) : null, records, partial: true,
      gaps: ["Raw Monitor history is not included.", "Receipt times do not establish browser execution times or cross-clock order.",
        "Only verified same-runtime/task resumes retain older records; fresh connections and endpoint eviction discard them.",
        ...(this.connections.get(endpoint)?.resumed ? ["Verified task resumed; events during transport interruption may be missing."] : []),
        "Retention drops are global across endpoints and do not count all connection discards.",
        "Rejected events use the connection's trusted active task, not the payload's claimed task; unscoped rejections are unavailable and retained counts are partial.",
        "Delivery queued is not proof of Agent execution.", "Only matching task/action IDs are included; request IDs are not inferred from action IDs.",
        ...(records.length ? [] : ["No retained Remote records match the bundle correlations."])] };
  }
}
