import { ENDPOINT_SOURCE, ENDPOINT_RE } from "../src/lib/endpoint.js";

// Transport addresses only: browser actions and completion remain extension-owned.
function replyCommands(endpoint, id, inputId) {
  if (
    !ENDPOINT_RE.test(endpoint) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
    (inputId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(inputId))
  )
    throw new Error("Invalid reply route");
  const root = "~/zylos/.claude/skills";
  const final = (status) =>
    `node ${root}/comm-bridge/scripts/c4-send.js browser-remote '${endpoint}|req:${id}|status:${status}${inputId ? `|input:${inputId}` : ""}'`;
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

export { replyCommands, parseReplyEndpoint };