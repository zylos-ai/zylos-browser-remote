// Append one Agent follow-up reply to a browser task that has already ended
// (the task-append feature: `<keyId>.<browserId>|task:<taskId>|append`).
// The relay validates and correlates; the extension owns the task history and
// decides whether the task may still receive a follow-up (it ended with the
// Agent's done/blocked reply, at most 24 hours ago, fewer than 20 follow-ups).
import { createHash } from "node:crypto";
import { ENDPOINT_RE } from "./endpoint.js";

export const TASK_APPEND_CAPABILITY = "agent-task-append-v1";
export const TASK_APPEND_TIMEOUT_MS = 10000;
export const TASK_APPEND_MAX_TEXT = 8000;
// Mirrors of the extension's limits, for documentation and error text only;
// the extension enforces them against its own persisted history.
export const TASK_APPEND_WINDOW_HOURS = 24;
export const TASK_APPEND_LIMIT = 20;
const TASK_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// Error codes the extension may return, passed through to the Agent.
export const TASK_APPEND_ERRORS = {
  BAD_PARAMS: [400, "Invalid task append request"],
  TASK_UNKNOWN: [404, "This browser has no such task in its history (never existed, cleared by the owner, or too old to be kept)"],
  TASK_ACTIVE: [409, "The task is still running; answer it through its open reply commands instead"],
  TASK_NOT_APPENDABLE: [409, "The task did not end with an Agent done/blocked reply (for example the owner stopped it); do not append"],
  TASK_TOO_OLD: [410, `The task ended more than ${TASK_APPEND_WINDOW_HOURS} hours ago; follow-ups are no longer accepted`],
  TASK_APPEND_LIMIT: [429, `The task already has ${TASK_APPEND_LIMIT} follow-up replies; no more are accepted`],
  TASK_APPEND_CONFLICT: [409, "A different follow-up already uses this append ID"],
  TASK_APPEND_UNSUPPORTED: [409, "This browser does not support follow-up replies (agent-task-append-v1); upgrade Zylos Browser"],
  TASK_APPEND_FAILED: [502, "The browser could not save the follow-up; it was not shown"],
};

/** Validates the agent-lane body; returns the trimmed text. Throws on any defect. */
export function taskAppendParams(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["endpoint", "taskId", "text"].includes(key)) ||
      typeof body.endpoint !== "string" || !ENDPOINT_RE.test(body.endpoint) || !body.endpoint.includes(".") ||
      typeof body.taskId !== "string" || !TASK_ID_RE.test(body.taskId) ||
      typeof body.text !== "string") throw new Error("Invalid task append request");
  const text = body.text.trim();
  if (!text || text.length > TASK_APPEND_MAX_TEXT) throw new Error("Follow-up must contain 1–8000 characters");
  return { endpoint: body.endpoint, taskId: body.taskId, text };
}

/**
 * Content-derived ID: an uncertain delivery can be retried with the same text
 * and the extension shows it once. Sending identical text twice is a no-op.
 */
export function appendIdFor(endpoint, taskId, text) {
  return createHash("sha256").update(`${endpoint}\n${taskId}\n${text}`).digest("hex").slice(0, 32);
}

export function taskAppendResult(result, { taskId, appendId }) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).some((key) => !["taskId", "appendId", "status", "count", "limit"].includes(key)) ||
      result.taskId !== taskId || result.appendId !== appendId ||
      !["appended", "existing"].includes(result.status) ||
      !Number.isSafeInteger(result.count) || result.count < 1 ||
      !Number.isSafeInteger(result.limit) || result.limit < result.count) throw new Error("Invalid task append response");
  return { taskId, appendId, status: result.status, count: result.count, limit: result.limit };
}
