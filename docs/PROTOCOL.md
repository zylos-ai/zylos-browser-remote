# Browser Remote protocol

## Detailed diagnostic snapshot sharing

Capability `diagnostics-detail-share-v1` enables the fixed RPC
`diagnostics.detail.fetch` with exactly empty params. It requires a current
extension-UI sharing grant for the immutable preview on this WSS connection;
the Agent cannot create a grant. Extension failures use `DETAIL_SHARE_UNAVAILABLE`
for absent, revoked, expired or invalid requests. The successful result is exactly
`{schemaVersion:1,text,sha256}`, where text is the exact preview JSON (at most
2 MiB UTF-8) and sha256 is its lowercase hexadecimal SHA-256. The relay validates
the envelope, hash and expected detailed-capture schema, and never adds raw
content to general metadata or logs. Fetch consumes the grant before send.
Do not automatically retry, resume or replay this method. See
[sharing and privacy boundaries](diagnostics.md#one-time-detailed-sharing).

Remote transports an extension-owned decision loop. All browser operation
schemas, execution rules and final-answer semantics are supplied by the extension.

## Connections

### Agent-Control Recovery Negotiation

Instance peers advertise `recovery-judgment-v1` in hello and ready. Recovery
requests additionally require `task-resume-v1`. The extension may send a normal
next-round request with `execution.mode: "recovery"` and
`execution.recovery: {recoveryId, expiresAt, reason: "target_closed", cause: "unknown"}`.
The recovery ID is a UUID; expiry is a positive safe-integer millisecond value
on the extension clock. Remote validates the metadata without inferring clock
alignment or changing action results. Context and message remain continuation
references. Wire resume phase remains `waiting`, not a new recovery phase.

The extension owns eligibility, one attempt, the absolute 120-second deadline,
and its bounded attach/observation operation. Only its recovery-only contract
is actionable. Neither prior input nor a new ordinary action is replayed.
Expiry and refusal use existing terminal delivery, releasing any exchange
waiter. A late response to a terminal recovery request returns `RECOVERY_CLOSED`
without forwarding a new action. Prior action receipt behavior remains unchanged.
Normal task execution remains unbounded by Remote; 10-second decision RPC
acknowledgement and 120-second socket resume windows are separate limits.

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
ID replaces only that instance. Without negotiated `task-resume-v1`, it discards
the in-flight exchange and receipts.
Code 4001 means this same instance was replaced, 4002 an incompatible handshake,
and 4003 the per-Key connection limit. Hello must arrive within 10 seconds.
Negotiated recovery is limited to the same live extension runtime and live
Remote process, as described below.

### Bounded transport recovery

Hello may include optional `build:{id,commit?,dirty?,builtAt?}`. `id` is a UUID,
`commit` is a 40- or 64-digit hexadecimal revision, `dirty` is boolean, and
`builtAt` is a valid canonical UTC ISO timestamp with milliseconds. Unknown
fields or malformed values discard the entire build claim without rejecting
the connection. Ordinary `/status` exposes `build` or `null` when unavailable;
this needs no detailed diagnostics grant. These are client-reported artifact
identifiers, not a cryptographic attestation. Older clients remain supported.

Both peers advertise `task-resume-v1`. Hello includes a `runtimeEpoch` generated
once per extension background lifetime. Reconnecting hello includes
`resume:{taskId,requestId?,round?,phase:"waiting"|"executing"|"terminal"}`. Ready returns
top-level `runtimeEpoch`, `recoveryWindowMs:120000`, and
`resume:{status:"fresh"|"resumed"|"rejected",reason?,category?}`. Rejection keeps
`reason:"RESUME_STATE_MISMATCH"` for older peers. Optional `category` is one of
`state_missing`, `capability_missing`, `runtime_changed`, `invalid_resume`,
`task_mismatch`, `state_expired`, or `request_mismatch`. It is diagnostic only
and does not alter recovery eligibility. Missing state may reflect prior expiry
or a Remote restart; the server records actual retention expiry separately.
Heartbeat logs include scheduled/actual firing times and frame ages when a beat
is delayed or missed. These wall-clock observations do not prove OS sleep.
An unknown or conflicting
runtime/task rejects recovery. A retained runtime that has not yet accepted its
first request can accept that request after recovery. Process restarts cannot
recover tasks. Older peers retain the existing disconnect behavior.
A runtime with a completed prior task may similarly reconcile a previously
unseen task's first round; an active task is never replaced by this path.
Waiting/executing descriptors must match the last accepted request and round;
waiting may instead name exactly the next round, whose request frame can still
be in the client's outbox. Terminal descriptors need no request ID or round.
The descriptor establishes transport continuity, not proof of browser results.
An advertised next round does not advance Remote's round or replace the current
decision: only the validated outbox request does. Any pending older decision is
still retransmitted unchanged for the extension's signature/receipt check.

Transport loss retains the logical endpoint, exchange, attachments, HTTP waiter,
request/steering watermarks and decision RPCs for at most 120 seconds. Normal
Agent thinking and browser execution have no recovery timer. Same-runtime socket
replacement transfers this state and fences the old socket before accepting
frames. Recovery sends pending decision RPCs with identical decision/request
contents; the extension must validate its retained signature and return its
receipt without repeating an already claimed action. Diagnostics RPCs are not
replayed. Agent decisions submitted while offline wait inside the same recovery
window. `/status` exposes `recovery:{state:"reconnecting",expiresAt}`.

Recoverable `agent-request`, `agent-input` and `agent-turn-end` frames carry
`deliveryId` and `runtimeEpoch`. Remote sends
`{type:"task-ack",deliveryId,runtimeEpoch}` after handling the frame. Request and
input intake status is sent before that ACK and retained for same-ID replay. The client
retains unacknowledged frames in a bounded outbox. Remote keeps up to 256 hashed
delivery receipts, rejects changed contents under one ID, and never repeats
first C4 delivery or steering intake on same-ID replay. Acknowledged receipts
can be evicted; task rounds, input sequence and active task checks still reject
stale replay. Exhaustion of unacknowledged receipts fails closed.
An additional bounded set of 1024 admitted task IDs prevents an older completed
task from becoming a new intake after receipt eviction; exhaustion fails closed
with `TASK_HISTORY_FULL`, requiring a fresh connection before a new task.
Attachments stay scoped to the existing exchange until terminal completion or recovery loss.

User stop, a new task, credential revocation, configuration changes and actual
browser control loss remain terminal. Offline terminal frames can be delivered
after reconnect; a previously accepted terminal frame is acknowledged without
repeating terminal effects. Recovery expiry or mismatch releases the exchange
and waiter with an offline failure; the client surfaces its own bounded recovery
failure even when no Agent waiter exists. Recovery never grants browser control.

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
| Extension → Remote | `{type:"agent-turn-end",taskId,status,text?,interruption?}`                                                | Durable completion or interruption       |

The numeric `req.id` correlates socket responses. `params.id` is the pending
Agent request ID. `taskId` groups all rounds from one user message. These are
separate from the connection's `endpointId`.

### Optional interruption evidence

For `status:"interrupted"`, an extension may include
`interruption:{reason:"CONTROL_LOST",results:[{method,outcome}],observation:"unavailable",resume:"new-user-message-required"}`.
At most ten results are accepted. Outcome is `completed`, `uncertain`, or
`not-executed`. Methods are extension-defined identifiers, not relay-owned tools.
The relay bounds identifier syntax to `[A-Za-z][A-Za-z0-9_.:-]{0,63}` and validates
the structure without interpreting which actions are permitted. Unknown fields
invalidate this optional evidence, never prevent terminal handling.

The pending `/decision` response retains this evidence with `finished:true`;
it does not create a new decision request. Retried decisions still pass through
extension validation: identical decision/inputId returns the retained receipt,
different contents return `DECISION_CONFLICT`. Validation RPCs are not action
replays. The relay stores no additional decision signature or browser policy.
Old extensions may omit the field; old relays ignore it and still terminate.
This additive field does not require a new mandatory handshake capability.
These are terminal receipts. A negotiated recovery judgment is a preceding
nonterminal request, not revival after an `agent-turn-end`. Once its terminal
event arrives, a late response to the recovery request returns `RECOVERY_CLOSED`
without forwarding an RPC.

### Opt-in diagnostic pulls

The extension advertises `diagnostics-v2` in hello. Only then may the loopback
`POST /diagnostics` route send a correlated `req` with method `diagnostics.get`.
The HTTP body names an exact `endpoint` and accepts `after`, `limit` (1..200),
`epoch`, `through`, `level`, `source`, and local numeric `task` filters. The WS
params omit `endpoint`. This read requires no active task/control grant and may
not enable collection or execute a browser action. WS timeout is five seconds.

The response is `{schemaVersion:2,enabled,version,epoch,events,nextCursor,highWater,
oldestCursor,dropped,hasMore,truncated,storageHealthy,restartCount,partialCapture}`.
Epoch is a UUID. Counts/cursors are nonnegative safe integers. Partial capture
means collection began after a task started; absent metadata is conservatively
treated as partial. Source is `background|sidepanel|executor` and level is
`debug|info|warn|error`. Each event carries `seq,at,event,source,level`; optional
fields are `reason,task,op,argCount,closeCode,errorKind,method,code,status,count`.
The extension owns the semantic/privacy allowlists for identifier fields; the
relay checks bounded syntax, types and size, projects known fields, and rejects
raw message/stack/argument containers from its output. Syntax validation cannot
prove that an identifier contains no private data; the extension is responsible
for generating classifications rather than copying user-controlled values.

Pages are bounded to 200 events/256 KiB. Events increase strictly in sequence.
For `hasMore:false`, `nextCursor` must equal `highWater`; for `hasMore:true`,
it must be smaller and advance past the input cursor. A frozen export keeps
the same epoch and high-water (`through`) across pages. Filters scan past
nonmatching events. Reset returns `DIAGNOSTICS_RESET`, unsupported capability
returns `DIAGNOSTICS_UNSUPPORTED`; disconnect/timeout remain distinct errors.
The relay never persists diagnostic pages. CLI export bounds and JSON/NDJSON
format are specified in [diagnostics](diagnostics.md).

Upgrade Remote before the extension when new diagnostic/evidence delivery is
required. Unsupported diagnostics are explicit; an older relay may omit new
optional evidence. Never silently change an existing capability's meaning.

An `agent-request` id must be unique **within its task**, not across the whole
connection: the relay dedupes on `taskId` + `id` and releases a task's ids once
that task ends, so a client that restarts its counter cannot have a legitimate
request swallowed by an earlier task. A replayed id is never enqueued twice and
always answers `{type:"agent-status",requestId,state:"failed",code:"DUPLICATE_REQUEST"}`
— intake never fails silently.

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
context JSON to 18,000 characters. Rounds are sequential positive safe integers,
without a task round-count cap. Owner messages support
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
a 10-second transport budget. Execution/continuation waits have no deadline;
the next client request, task end, replacement or disconnect releases the waiter.
The CLI bounds connection/request delivery to 10 seconds, then waits on the same
HTTP request without an execution timeout. Status requests retain a 10-second
response deadline. A transport timeout does not prove an action failed.

The extension has no total task duration, decision-wait, round-count or
consecutive-failure cap. Individual browser operations retain their own deadlines
and return failures as evidence for the next decision. Tasks still end on
completion, an explicit blocked decision, owner stop or connection interruption.

`BAD_DECISION` permits correction of the pending request. `DECISION_CONFLICT`
rejects different contents for an already accepted ID. `STALE_DECISION` rejects
ended requests. `DECISION_BUSY` rejects concurrent submissions. Identical
accepted retries can return a saved receipt marked `replayed:true`; the extension
also checks the decision identity. Receipts are bounded to 32 on the Relay and
are discarded when the connection ends.

Stopping, disconnecting or replacing the browser releases waiting commands.
No browser actions are persisted for automatic replay.

`ready.capabilities` advertises `agent-interrupt-v1` on instance-aware connections.
An explicit owner Stop sends `{type:"agent-turn-end",taskId,status:"stopped",interrupt:true}`.
The relay accepts it once, only for that connection's current task. It releases
waiting decision commands immediately, then enqueues `[KEYSTROKE]Escape` through
Core's existing `c4-control.js` with priority 0, bypass-state, no ack suffix and a
5-second expiry. This interrupts the runtime's current foreground turn; it is not
task-scoped cancellation across Channels. No Core source change is required.

The relay replies `{type:"agent-stop-result",taskId,ok,code?}` after polling the
control receipt. `ok:true` means the key was delivered, not that all subprocesses
have exited. Failure uses `AGENT_INTERRUPT_UNCONFIRMED`; uncertain interrupts are
never retried. The connection refuses new requests with `AGENT_STOPPING` while
delivery is pending, and the extension keeps its composer locked while waiting
(at most 11 seconds). Ordinary completion, disconnect, worker reload and legacy
end frames without `interrupt:true` never enqueue runtime keys.

## Attachments and diagnostics

`ready.capabilities` includes `attachments-v1`. Owner attachments arrive in
`message.content` on the first request; browser-generated screenshots remain
in their operation results. Quotes (`type: "quote"`) pass through as page data.
Images/files use `{id,type,name,mimeType,bytes,data}` with base64 data. Remote also
accepts older nested `{mimeType,data}` screenshots. Image MIME must match PNG,
JPEG, WebP or GIF bytes. Other files, including non-previewable images such as
SVG/HEIC, use `type: "file"`; filenames are labels,
not caller-supplied filesystem paths. Remote never fetches arbitrary file URLs.

Before exposing a request to the Agent, Remote validates the entire payload and
writes private files on the Agent host. It replaces `data` with `path`, `bytes`
and `imageReadRequired:true` or `fileReadRequired:true`. This applies to both the
first C4 request and subsequent decision responses. At most 12 binaries and
5,250,000 decoded bytes are allowed per payload. Failed writes roll back newly
created files. Safe original file suffixes are preserved for document readers;
storage basenames are generated by Remote. No attachment Base64 enters the Agent prompt or CLI stdout;
Monitor redacts binary data even when the encoding is short.

`BROWSER_REMOTE_OBS_DIR` selects the temporary observations directory. Files belong
to one browser endpoint and task across all rounds. Completion (done/blocked),
stop, interruption, disconnect, replacement and orderly shutdown delete that
task's files. Confirmed intake failure also releases them; uncertain delivery
keeps them until the task ends. Closed tasks cannot create late files. A later
task that needs an original image must upload it again.
There is no startup, scheduled or age-based cleanup; new writes only check capacity.
A 128 MiB store limit refuses new files instead of deleting active-task
attachments. Generated paths are internal
to the Agent host, never Chrome paths or public download URLs. File transport
does not imply the Agent has a reader for every document format.

Monitor is opt-in, private, and read-only. `agent-event` records actual extension
steps; optional Agent trace collection records model tool invocations separately.
A diagnostic event cannot trigger a browser action or determine its outcome.
