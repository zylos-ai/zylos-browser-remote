# Browser Remote protocol

Remote transports an extension-owned decision loop. All browser operation
schemas, execution rules and final-answer semantics are supplied by the extension.

## Connections

One Node.js process binds two loopback listeners:

- `127.0.0.1:3802/ext`: authenticated WebSocket, exposed through the deployment's
  TLS reverse proxy as `/browser-remote/ext`.
- `127.0.0.1:3803`: Agent-host HTTP. `POST /decision`, `GET /status` and optionally
  read-only `/monitor/` and `/monitor/api`. Never publicly proxy this listener.

The browser offers WebSocket subprotocols `zylos-browser-remote.v2` and
`key.<full-key>`. Remote verifies SHA-256 against its key registry and selects
only the transport subprotocol in its response. `keyId` is the first 12 hex
characters of the digest. A new connection for the same key replaces the current
one and invalidates its in-flight exchange.

Both peers require `agent-loop-v1`. An incompatible peer is closed with code 4002.
Code 4001 means another connection took ownership. Reconnection never resumes
an unfinished turn automatically.

## WebSocket messages

| Direction          | Frame                                                                   | Meaning                                  |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------- |
| Extension → Remote | `{type:"hello",version,capabilities:["agent-loop-v1"]}`                 | Declare supported protocol               |
| Remote → Extension | `{type:"ready",capabilities:["agent-loop-v1"]}`                         | Handshake complete                       |
| Remote → Extension | `{type:"ping",ts}`                                                      | Heartbeat, every 17 seconds              |
| Extension → Remote | `{type:"pong",ts}`                                                      | Liveness response                        |
| Extension → Remote | `{type:"agent-request",id,taskId,round,text,context,payload}`           | Request one decision                     |
| Remote → Extension | `{type:"agent-status",requestId,state,code?}`                           | Intake result: queued, failed or unknown |
| Remote → Extension | `{type:"req",id,method:"agent-decision",params:{id,decision},deadline}` | Correlated opaque decision               |
| Extension → Remote | `{type:"resp",id,result}` or `{type:"error",id,code,message,details?}`  | Decision acceptance or rejection         |
| Extension → Remote | `{type:"agent-event",taskId,id,phase,method,params?,result?,error?}`    | Optional diagnostic metadata             |
| Extension → Remote | `{type:"agent-turn-end",taskId,status,text?}`                           | Durable completion or interruption       |

The numeric `req.id` correlates socket responses. `params.id` is the pending
Agent request ID. `taskId` groups all rounds from one user message. These are
separate from the connection's `keyId`.

Remote bounds IDs to 128 characters, user text to 8,000 characters, context to
16,000 characters, and rounds to 1–30. Payload and decision objects are opaque.
The extension validates their browser contract before any action executes.

## First request and continuation

The first request invokes `c4-receive.js` with channel `browser-remote`, endpoint
`keyId`, priority 2, `--json` and `--no-reply`. Its content contains the user
request, extension contract and `replyCommands` for actions, done and blocked.
The actions command is:

```sh
node ~/zylos/.claude/skills/browser-remote/scripts/decision.js <keyId> <requestId>
```

C4 records the incoming request in its SQLite conversation queue. With
`--no-reply`, `endpoint_id` is null; the decision route remains in the content.
C4 intake success is distinct from Agent execution or task completion. The fixed
C4 reply suffix is suppressed because the final answer must target the latest
request ID; final outgoing answers still use C4 sending, as described below.

`decision.js` reads JSON from stdin and posts:

```json
{
  "endpoint": "abc123def456",
  "id": "request-1",
  "decision": {
    "kind": "actions",
    "actions": [
      { "method": "open", "params": { "url": "https://example.com" } }
    ]
  }
}
```

The decision object above is an example of the extension contract, not a schema
maintained by Remote. The HTTP request waits for a new extension request or
completion, returning:

```json
{
  "ok": true,
  "accepted": true,
  "next": {
    "id": "request-2",
    "taskId": "task-1",
    "round": 2,
    "text": "User request",
    "payload": {},
    "replyCommands": {
      "actions": "node ~/zylos/.claude/skills/browser-remote/scripts/decision.js abc123def456 request-2",
      "done": "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote 'abc123def456|req:request-2|status:done'",
      "blocked": "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote 'abc123def456|req:request-2|status:blocked'"
    }
  }
}
```

or:

```json
{ "ok": true, "accepted": true, "finished": true, "status": "done" }
```

Next-round observations return directly to the waiting command, without C4
re-enqueueing. `GET /status` returns `{ok:true,extensions:{...}}` with connection
metadata, outstanding socket requests and the active task ID.

## Final answers through C4

The Agent pipes final answer text into the current `replyCommands.done` or
`replyCommands.blocked`. C4 audits the outgoing text, then executes this channel's
`scripts/send.js <endpoint> <message>`. Endpoints are strictly:
`<12-hex-keyId>|req:<requestId>|status:<done|blocked>`.

The adapter accepts 1–8,000 trimmed characters and posts the terminal decision
`{endpoint:keyId,id:requestId,decision:{kind:status,text:message}}` to the existing
`/decision` endpoint. No additional HTTP or WebSocket route is needed. The plugin
validates the ID and payload, persists the reply, and ends the task using its
existing completion logic. The sender succeeds only on `finished:true` and the
matching status. Plain messages cannot implicitly finish an unrelated task.

Do not send a final decision separately after the C4 reply. Same-ID identical
retries reuse the receipt, while conflicting contents and stale requests fail.
C4 records every attempt before dispatch, so failed and duplicate attempts can
have outgoing audit rows even though the plugin displays only one final reply.
Unsolicited notifications and nonterminal progress messages are not supported
by this final-answer endpoint.

## Errors and retries

The exchange permits one waiting decision per endpoint. Decision acceptance has
a 10-second transport budget; execution/continuation waits up to 120 seconds,
with a 125-second CLI HTTP deadline. A timeout does not prove an action failed.

`BAD_DECISION` permits correction of the pending request. `DECISION_CONFLICT`
rejects different contents for an already accepted ID. `STALE_DECISION` rejects
ended requests. `DECISION_BUSY` rejects concurrent submissions. Identical
accepted retries can return a saved receipt marked `replayed:true`; the extension
also checks the decision identity. Receipts are bounded to 32 on the Relay and
are discarded when the connection ends.

Stopping, disconnecting or replacing the browser releases waiting commands.
No browser actions are persisted for automatic replay.

## Attachments and diagnostics

Images use `{mimeType,data}` on the wire. Before exposing a request to the Agent,
Remote validates PNG/JPEG bytes and writes private files on the Agent host.
The object retains metadata and replaces `data` with `path`, `bytes`, and
`imageReadRequired:true`. This applies to nested results in both the first C4
request and subsequent decision responses. At most 12 images are materialized
per payload, with the latest 12 retained. No screenshot Base64 enters CLI stdout.

Monitor is opt-in, private, and read-only. `agent-event` records actual extension
steps; optional Agent trace collection records model tool invocations separately.
A diagnostic event cannot trigger a browser action or determine its outcome.
