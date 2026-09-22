# Browser Remote protocol

Remote transports an extension-owned decision loop. All browser operation
schemas, execution rules and final-answer semantics are supplied by the extension.

## Connections

One Node.js process binds two loopback listeners:

- `127.0.0.1:3802/ext`: authenticated WebSocket, exposed through the deployment's
  TLS reverse proxy as `/browser-remote/ext`.
- `127.0.0.1:3803`: Agent-host HTTP. `POST /decision`, `GET /status` and optionally
  read-only `/monitor/` and `/monitor/api`. Never publicly proxy this listener.

The browser offers WebSocket subprotocols `zylos-browser-remote.v3` and
`key.<full-key>`. Remote verifies SHA-256 against its key registry and selects
only the transport subprotocol. `keyId` is the first 12 hex characters of the
digest; it identifies the credential, not an individual browser.

The plugin generates a lowercase UUID v4 `browserId` once per installation and
persists it in `chrome.storage.local` (not sync). It survives browser/worker
restart, disconnect, configuration changes and chat clearing. Different Chrome
profiles have different IDs; windows in the same profile share one instance.
Clearing extension storage or reinstalling creates a new identity.

Both peers require `agent-loop-v1` and `browser-instance-v1`. Remote validates
hello before registering `endpointId = keyId.browserId`, returning that address
in ready. The plugin verifies the exact address before enabling chat. Identity
is immutable for the lifetime of a socket. Client-supplied routing metadata in
later events is ignored; Remote uses the authenticated socket's identity.

Up to 32 instances may share a Key. Different IDs coexist. Reconnecting the same
ID replaces only that instance and discards its in-flight exchange and receipts.
Code 4001 means this same instance was replaced, 4002 an incompatible handshake,
and 4003 the per-Key connection limit. Hello must arrive within 10 seconds.
Reconnection never resumes an unfinished turn automatically.

Upgrade Remote before the plugin. The server also accepts v2 clients in the
separate bare-keyId route during rollout; they cannot replace v3 instances.
New plugins offer only v3 and require `agent-message-v2` in ready. A server
without this capability cannot enable chat. There is no automatic downgrade. This feature isolates
browser routing, not the Agent's conversation context or memory.

## WebSocket messages

| Direction          | Frame                                                                                                      | Meaning                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Extension → Remote | `{type:"hello",version,browserId,capabilities:["agent-loop-v1","browser-instance-v1","agent-message-v2"]}` | Declare supported protocol               |
| Remote → Extension | `{type:"ready",endpointId,capabilities:["agent-loop-v1","browser-instance-v1","agent-message-v2"]}`        | Handshake complete                       |
| Remote → Extension | `{type:"ping",ts}`                                                                                         | Heartbeat, every 17 seconds              |
| Extension → Remote | `{type:"pong",ts}`                                                                                         | Liveness response                        |
| Extension → Remote | `{type:"agent-request",version:2,id,taskId,round,message,context,execution}`                               | Request one decision                     |
| Remote → Extension | `{type:"agent-status",requestId,state,code?}`                                                              | Intake result: queued, failed or unknown |
| Remote → Extension | `{type:"req",id,method:"agent-decision",params:{id,decision},deadline}`                                    | Correlated opaque decision               |
| Extension → Remote | `{type:"resp",id,result}` or `{type:"error",id,code,message,details?}`                                     | Decision acceptance or rejection         |
| Extension → Remote | `{type:"agent-event",taskId,id,phase,method,params?,result?,error?}`                                       | Optional diagnostic metadata             |
| Extension → Remote | `{type:"agent-turn-end",taskId,status,text?}`                                                              | Durable completion or interruption       |

The numeric `req.id` correlates socket responses. `params.id` is the pending
Agent request ID. `taskId` groups all rounds from one user message. These are
separate from the connection's `endpointId`.

Requests use three sections. `message` contains the owner input, `context`
contains captured environment data, and `execution` carries the extension's
instructions, tools, mode, memory, current observations and action results.
The first request supplies `message: {id,role:"user",content:[...]}` and
`context: {pages:[...]}`. Content blocks are text, quote, image or file.
Following rounds send `message: {id}` and `context: {pages:[]}` to refer to the
original input, while `execution.observation/results` carries fresh evidence.
Empty pages means no additional initial context; it does not clear the task.
The consumer retains the original owner input throughout the task.

Remote bounds IDs to 128 characters, combined user text to 8,000 characters,
context JSON to 18,000 characters, and rounds to 1–30. Owner messages support
up to eight attachments. Continuation references must match the active task and
rounds must progress in order. Execution and decision semantics remain opaque;
the extension validates the browser contract before any action executes.

New plugins require `agent-message-v2` in ready. Update Remote first. Existing
plugins remain supported through a small ingress adapter which immediately
normalizes their requests to the same version 2 structure. Downstream exchange,
C4 delivery and Agent instructions use only the canonical structure.

## First request and continuation

The first request invokes `c4-receive.js` with channel `browser-remote`, endpoint
`endpointId`, priority 2, `--json` and `--no-reply`. Its content contains the user
request as one JSON object, plus `replyCommands` for actions, done and blocked.
The user text and page body are not separately concatenated into the prompt.
The actions command is:

```sh
node ~/zylos/.claude/skills/browser-remote/scripts/decision.js <endpointId> <requestId>
```

C4 records the incoming request in its SQLite conversation queue. With
`--no-reply`, `endpoint_id` is null; the decision route remains in the content.
C4 intake success is distinct from Agent execution or task completion. The fixed
C4 reply suffix is suppressed because the final answer must target the latest
request ID; final outgoing answers still use C4 sending, as described below.

`decision.js` reads JSON from stdin and posts:

```json
{
  "endpoint": "abc123def456.12345678-1234-4567-89ab-123456789abc",
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
    "version": 2,
    "message": { "id": "task-1" },
    "context": { "pages": [] },
    "execution": { "observation": {}, "results": [] },
    "replyCommands": {
      "actions": "node ~/zylos/.claude/skills/browser-remote/scripts/decision.js abc123def456.12345678-1234-4567-89ab-123456789abc request-2",
      "done": "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote 'abc123def456.12345678-1234-4567-89ab-123456789abc|req:request-2|status:done'",
      "blocked": "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote 'abc123def456.12345678-1234-4567-89ab-123456789abc|req:request-2|status:blocked'"
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
metadata including keyId/browserId/endpointId, outstanding socket requests and the active task ID. The extensions object is keyed by endpointId. Next-round responses also include endpointId.

## Final answers through C4

The Agent pipes final answer text into the current `replyCommands.done` or
`replyCommands.blocked`. C4 audits the outgoing text, then executes this channel's
`scripts/send.js <endpoint> <message>`. Endpoints are strictly:
`<endpointId>|req:<requestId>|status:<done|blocked>`.

The adapter accepts 1–8,000 trimmed characters and posts the terminal decision
`{endpoint:endpointId,id:requestId,decision:{kind:status,text:message}}` to the existing
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

Every decision requires its explicit endpoint and request ID; omitted or offline targets never fall back to another browser. The exchange permits one waiting decision per endpoint. Decision acceptance has
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

`ready.capabilities` includes `attachments-v1`. Owner attachments arrive in
`message.content` on the first request; browser-generated screenshots remain
in their operation results. Quotes (`type: "quote"`) pass through as page data.
Images/files use `{id,type,name,mimeType,bytes,data}` with base64 data. Remote also
accepts older nested `{mimeType,data}` screenshots. Image MIME must match PNG,
JPEG, WebP or GIF bytes. Other files use `type: "file"`; filenames are labels,
not caller-supplied filesystem paths. Remote never fetches arbitrary file URLs.

Before exposing a request to the Agent, Remote validates the entire payload and
writes private files on the Agent host. It replaces `data` with `path`, `bytes`
and `imageReadRequired:true` or `fileReadRequired:true`. This applies to both the
first C4 request and subsequent decision responses. At most 12 binaries and
5,250,000 decoded bytes are allowed per payload. Failed writes roll back newly
created files. No attachment Base64 enters the Agent prompt or CLI stdout;
Monitor redacts binary data even when the encoding is short.

`BROWSER_REMOTE_OBS_DIR` selects the existing observations directory. Files older
than 24 hours are removed on the next write, and a 128 MiB store limit refuses new
files instead of deleting active-task attachments. Generated paths are internal
to the Agent host, never Chrome paths or public download URLs. File transport
does not imply the Agent has a reader for every document format.

Monitor is opt-in, private, and read-only. `agent-event` records actual extension
steps; optional Agent trace collection records model tool invocations separately.
A diagnostic event cannot trigger a browser action or determine its outcome.
