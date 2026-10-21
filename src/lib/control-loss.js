import { diagnosticIdentifier } from "./diagnostics.js";
const OUTCOMES = new Set(["completed", "uncertain", "not-executed"]);

// Invalid evidence never prevents termination, but none of it is forwarded.
export function controlLossReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["reason", "results", "observation", "resume", "recoveryOutcome", "recoveryRemoval"].includes(key)) ||
      (value.recoveryOutcome !== undefined && !["expired", "failed", "revoked"].includes(value.recoveryOutcome)) ||
      (value.recoveryRemoval !== undefined && (!value.recoveryRemoval || typeof value.recoveryRemoval !== "object" ||
        Array.isArray(value.recoveryRemoval) || Object.keys(value.recoveryRemoval).some(key => !["requested", "outcome"].includes(key)) ||
        !Number.isSafeInteger(value.recoveryRemoval.requested) || value.recoveryRemoval.requested < 1 || value.recoveryRemoval.requested > 16 ||
        value.recoveryRemoval.outcome !== "unknown")) ||
      value.reason !== "CONTROL_LOST" || value.observation !== "unavailable" ||
      value.resume !== "new-user-message-required" || !Array.isArray(value.results) || value.results.length > 10 ||
      value.results.some(result => !result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).some(key => !["method", "outcome"].includes(key)) ||
        !diagnosticIdentifier(result.method) || !OUTCOMES.has(result.outcome))) return undefined;
  return { reason: "CONTROL_LOST", results: value.results.map(({ method, outcome }) => ({ method, outcome })),
    observation: "unavailable", resume: "new-user-message-required",
    ...(value.recoveryOutcome !== undefined ? { recoveryOutcome: value.recoveryOutcome } : {}),
    ...(value.recoveryRemoval !== undefined ? { recoveryRemoval: { requested: value.recoveryRemoval.requested, outcome: "unknown" } } : {}) };
}
