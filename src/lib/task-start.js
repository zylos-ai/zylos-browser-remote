import { ENDPOINT_RE, BROWSER_ID_RE } from "./endpoint.js";
import { validFullGroup } from "./task-sessions.js";

export const TASK_START_CAPABILITY = "agent-task-start-v1";
// The extension opens the task tab and waits up to 10s for the page before it
// answers, so the default leaves room for a slow page on top of that.
export const TASK_START_TIMEOUT_MS = 20000;
export function taskStartParams(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["endpoint", "requestId", "prompt", "url", "sessionGroup"].includes(key)) ||
      (body.sessionGroup !== undefined && !validFullGroup(body.sessionGroup)) ||
      typeof body.endpoint !== "string" || !ENDPOINT_RE.test(body.endpoint) || !body.endpoint.includes(".") ||
      typeof body.requestId !== "string" || !BROWSER_ID_RE.test(body.requestId) ||
      typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 8000 ||
      typeof body.url !== "string" || body.url.length > 4096 || !/^https?:\/\//.test(body.url) ||
      /[\u0000-\u0020\u007f]/.test(body.url)) throw new Error("Invalid task start request");
  let url;
  try { url = new URL(body.url); } catch { throw new Error("Invalid task start URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Invalid task start URL");
  }
  // sessionGroup is relay-local routing (the starting Core session); it is
  // never forwarded to the extension.
  return { requestId: body.requestId, prompt: body.prompt, url: body.url };
}

export function taskStartResult(result, requestId) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).some(key => !["requestId", "taskId", "status"].includes(key)) ||
      result.requestId !== requestId || typeof result.taskId !== "string" || !BROWSER_ID_RE.test(result.taskId) ||
      !["started", "existing"].includes(result.status)) throw new Error("Invalid task start response");
  return { requestId: result.requestId, taskId: result.taskId, status: result.status };
}
