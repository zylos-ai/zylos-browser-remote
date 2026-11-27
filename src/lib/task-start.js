import { ENDPOINT_RE, BROWSER_ID_RE } from "./endpoint.js";
import { validFullGroup } from "./task-sessions.js";

export const TASK_START_CAPABILITY = "agent-task-start-v1";
// Advertised by extensions that can start a task on the browser user's current
// tab (`target: "current-tab"`) instead of opening a new tab at `url`.
export const TASK_START_CURRENT_TAB_CAPABILITY = "agent-task-current-tab-v1";
export const CURRENT_TAB_TARGET = "current-tab";
// The extension opens the task tab and waits up to 10s for the page before it
// answers, so the default leaves room for a slow page on top of that.
export const TASK_START_TIMEOUT_MS = 20000;

// Definite refusals: the extension took no page control and created no task.
// Each says why, so the Agent can tell the user without guessing.
export const TASK_START_NOT_STARTED = {
  TASK_START_PAGE_TIMEOUT: "the start page did not load and its tab was closed",
  PAGE_UNAVAILABLE: "the start page did not load and its tab was closed",
  TASK_START_NO_TAB: "the browser has no focused normal window with an active tab",
  TASK_START_PAGE_RESTRICTED: "the current tab is a browser, private or protected page that the extension cannot operate",
  TASK_START_SITE_DENIED: "the browser owner's site access rules deny the current tab's site",
  TASK_START_PAGE_NOT_READY: "the current tab is still loading or could not be read yet",
  TASK_START_TAB_CLOSED: "the current tab was closed before the task started",
  TASK_START_PAGE_CHANGED: "the current tab navigated, reloaded or moved before the task started",
};

export function taskStartParams(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["endpoint", "requestId", "prompt", "url", "target", "sessionGroup"].includes(key)) ||
      (body.sessionGroup !== undefined && !validFullGroup(body.sessionGroup)) ||
      typeof body.endpoint !== "string" || !ENDPOINT_RE.test(body.endpoint) || !body.endpoint.includes(".") ||
      typeof body.requestId !== "string" || !BROWSER_ID_RE.test(body.requestId) ||
      typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 8000 ||
      // Exactly one target: a URL for a new task tab, or the user's current tab.
      (body.url === undefined) === (body.target === undefined)) throw new Error("Invalid task start request");
  // sessionGroup is relay-local routing (the starting Core session); it is
  // never forwarded to the extension.
  if (body.target !== undefined) {
    if (body.target !== CURRENT_TAB_TARGET) throw new Error("Invalid task start target");
    return { requestId: body.requestId, prompt: body.prompt, target: CURRENT_TAB_TARGET };
  }
  if (typeof body.url !== "string" || body.url.length > 4096 || !/^https?:\/\//.test(body.url) ||
      /[\u0000-\u0020\u007f]/.test(body.url)) throw new Error("Invalid task start request");
  let url;
  try { url = new URL(body.url); } catch { throw new Error("Invalid task start URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Invalid task start URL");
  }
  return { requestId: body.requestId, prompt: body.prompt, url: body.url };
}

export function taskStartResult(result, requestId) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).some(key => !["requestId", "taskId", "status"].includes(key)) ||
      result.requestId !== requestId || typeof result.taskId !== "string" || !BROWSER_ID_RE.test(result.taskId) ||
      !["started", "existing"].includes(result.status)) throw new Error("Invalid task start response");
  return { requestId: result.requestId, taskId: result.taskId, status: result.status };
}
