import { ENDPOINT_SOURCE, ENDPOINT_RE } from "../src/lib/endpoint.js";

// Transport addresses only: browser actions and completion remain extension-owned.
// direct: the task runs in a Core session that does not own this browser's
// address (an agent-started task on multi-session Core). Core refuses a c4-send
// from there (CROSS_SESSION_OUTBOUND), so the final reply is handed to the
// owning browser thread through Core's internal message (handoff-final.js),
// and that thread runs the ordinary c4-send.
function replyCommands(endpoint, id, inputId, { direct = false } = {}) {
  if (
    !ENDPOINT_RE.test(endpoint) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
    (inputId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(inputId))
  )
    throw new Error("Invalid reply route");
  const root = "~/zylos/.claude/skills";
  const final = (status) =>
    `node ${root}/${direct ? "browser-remote/scripts/handoff-final.js" : "comm-bridge/scripts/c4-send.js browser-remote"} '${endpoint}|req:${id}|status:${status}${inputId ? `|input:${inputId}` : ""}'`;
  return {
    actions: `node ${root}/browser-remote/scripts/decision.js ${endpoint} ${id}${inputId ? ` --input-id ${inputId}` : ""}`,
    done: final("done"),
    blocked: final("blocked"),
  };
}

function parseReplyEndpoint(value) {
  const match = new RegExp(
    `^(${ENDPOINT_SOURCE})\\|req:([A-Za-z0-9._:-]{1,128})\\|status:(done|blocked)(?:\\|input:([A-Za-z0-9._:-]{1,128}))?$`,
  ).exec(value || "");
  if (!match)
    throw new Error(
      "Expected <endpointId>|req:<requestId>|status:<done|blocked>; use the current request's reply command",
    );
  return {
    endpoint: match[1],
    id: match[2],
    status: match[3],
    ...(match[4] ? { inputId: match[4] } : {}),
  };
}

// Follow-up reply to a task that already ended (task append): an exact browser
// connection (keyId.browserId) and the task ID from that task's requests.
const APPEND_RE = new RegExp(
  `^(${ENDPOINT_SOURCE})\\|task:([A-Za-z0-9._:-]{1,128})\\|append$`,
);

/** Either a final reply route or a follow-up (append) route. */
function parseSendTarget(value) {
  const append = APPEND_RE.exec(value || "");
  if (append) {
    if (!append[1].includes("."))
      throw new Error("A follow-up needs the exact browser endpoint <keyId>.<browserId>");
    return { kind: "append", endpoint: append[1], taskId: append[2] };
  }
  if (/\|task:/.test(value || ""))
    throw new Error("Expected <keyId>.<browserId>|task:<taskId>|append");
  return { kind: "reply", ...parseReplyEndpoint(value) };
}

export { replyCommands, parseReplyEndpoint, parseSendTarget };