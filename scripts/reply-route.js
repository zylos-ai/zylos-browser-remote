"use strict";

// Transport addresses only: browser actions and completion remain extension-owned.
function replyCommands(endpoint, id) {
  const root = "~/zylos/.claude/skills";
  const final = (status) =>
    `node ${root}/comm-bridge/scripts/c4-send.js browser-remote '${endpoint}|req:${id}|status:${status}'`;
  return {
    actions: `node ${root}/browser-remote/scripts/decision.js ${endpoint} ${id}`,
    done: final("done"),
    blocked: final("blocked"),
  };
}

function parseReplyEndpoint(value) {
  const match =
    /^([a-f0-9]{12})\|req:([A-Za-z0-9._:-]{1,128})\|status:(done|blocked)$/.exec(
      value || "",
    );
  if (!match)
    throw new Error(
      "Expected <keyId>|req:<requestId>|status:<done|blocked>; use the current request's reply command",
    );
  return { endpoint: match[1], id: match[2], status: match[3] };
}

module.exports = { replyCommands, parseReplyEndpoint };
