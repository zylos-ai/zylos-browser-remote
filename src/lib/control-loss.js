const METHODS = new Set(["open", "new-tab", "switch-tab", "tabs", "snapshot", "observe", "find", "inspect",
  "frames", "click", "hover", "double-click", "right-click", "drag", "select", "check", "back", "forward",
  "reload", "fill", "type", "scroll", "keypress", "wait-for-page", "dialog", "close-tab", "finalize",
  "read-page", "use-current-tab", "record-findings", "read-findings"]);
const OUTCOMES = new Set(["completed", "uncertain", "not-executed"]);

// Invalid evidence never prevents termination, but none of it is forwarded.
export function controlLossReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["reason", "results", "observation", "resume"].includes(key)) ||
      value.reason !== "CONTROL_LOST" || value.observation !== "unavailable" ||
      value.resume !== "new-user-message-required" || !Array.isArray(value.results) || value.results.length > 10 ||
      value.results.some(result => !result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).some(key => !["method", "outcome"].includes(key)) ||
        !METHODS.has(result.method) || !OUTCOMES.has(result.outcome))) return undefined;
  return { reason: "CONTROL_LOST", results: value.results.map(({ method, outcome }) => ({ method, outcome })),
    observation: "unavailable", resume: "new-user-message-required" };
}
