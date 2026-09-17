# zylos-browser-remote — protocol (v2)

Two surfaces and one hop. The relay owns the surfaces; it does **not** own the
meaning of anything that crosses them.

## Extension-owned decision exchange (agent-loop-v1)

This additive mode is negotiated by the extension's hello capability and the
relay's `{type:"ready",capabilities:["agent-loop-v1"]}`. Older peers keep the
direct RPC/chat flow documented below.

The client sends `{type:"agent-request",id,taskId,round,text,context,payload}`.
IDs are bounded identifiers; round is 1–30; text/context retain their existing
limits; the WebSocket message cap is 8 MiB. Payload semantics, operation schemas,
page state, decisions and task limits belong to the extension. The first request
is delivered through C4 with `--no-reply` (no legacy reply suffix); the message
includes the correlated CLI response route. Later rounds return directly to that
CLI rather than creating new C4 conversations.

`POST /decision {endpoint?,id,decision}` on loopback forwards an `agent-decision`
request to the client and waits up to 120 seconds for its next request or terminal
event. It returns `{ok:true,accepted:true,next:{id,taskId,round,text,payload}}` or
`{ok:true,accepted:true,finished:true,status}`. Read stdout and submit the next
decision ID until finished. The relay does not interpret the decision body.
`scripts/decision.js <endpoint> <requestId>` reads that body from stdin.

Images are materialized on the Agent host before either C4 or CLI output, using
the same attachment adapter as browser.js. Only metadata/path, never Base64,
reaches stdout. One exchange may be pending per endpoint. Receipts are bounded
to 32 per connected turn; a duplicate still goes to the client for content/ID
validation, then returns its previous exchange result. A wait timeout leaves the
outcome uncertain: only retry the same ID/body. Disconnect discards the exchange;
the extension rejects stale decisions and never automatically replays input.

`agent-status` correlates intake errors by requestId. `agent-turn-end` correlates
final/stopped/interrupted state by taskId. While a client-owned turn is active,
POST /chat returns DECISION_REQUIRED; the extension gates concurrent direct
browser RPCs. It sends bounded `agent-event` start/end records for diagnostics,
so Monitor can show locally executed operations without scheduling them. The
Agent trace also recognizes the initial decision header within C4's preview.

---

```
agent (scripts/browser.js)          relay                          owner's Chrome
──────────────────────────          ─────                          ──────────────
  A. loopback HTTP  ──▶  :3803 agent lane   (127.0.0.1 only)
                                │  forward verbatim
                          :3802 ext lane    ──▶ wss://<domain>/browser-remote/ext
                                                   B. extension wire protocol
  C. C4 hop: owner chat ──▶ c4-receive.js --channel browser-remote --endpoint <keyId>
             agent reply ◀── c4-send.js browser-remote <keyId> → scripts/send.js → POST /chat
```

Everything the earlier design put in the relay — CDP façade, leases, method
allowlist, URL guard, idempotency — now lives in the extension
(`zylos-browser-extension`, `remote` build). The relay is trusted with exactly
one thing: knowing which key is which browser.

Optional development diagnostics (`BROWSER_REMOTE_MONITOR=1`) add read-only
`GET /monitor/`, its static assets, and `GET /monitor/api` to the loopback agent
lane only. The public extension lane is unchanged. These routes require a local
Host header and reject cross-origin browser reads; they expose bounded summaries,
not screenshot data or a browser-command endpoint. The API uses a revision token
for lightweight polling. Diagnostics observe existing chat/RPC/reply events and
do not add fields to extension messages or modify command execution policy.
With `BROWSER_REMOTE_MONITOR_AGENT_DIR` set to the Zylos runtime directory, an
optional read-only Codex CLI rollout adapter adds `kind: "agent"` steps. Browser
RPC steps keep `kind: "command"`. The API exposes `agentSource` availability and
per-run `toolCounts.browser` / `toolCounts.agent` arrays of `{name, count}`.
The adapter scopes sessions by exact working directory and CLI source, associates
calls through the C4 reply-routing suffix, and omits ambiguous mixed-message
calls. It persists tool names, bounded input metadata, return byte counts and
timestamps; never raw Agent tool output or reasoning. `exec_command` steps also
include `invocation: {json, originalBytes, redacted, truncated}`: a display copy
of the invocation arguments (including `cmd` and `workdir` when present), with
recognized credentials/encoded images removed and a 16 KiB size limit. C4 user
messages observed in the rollout use `kind: "agent-input"` and the same display
envelope; these are message steps, not tool calls. Retained legacy steps may be
enriched only by exact session/call-ID matches in the currently scanned rollouts.
`returned` means a return was observed without an explicit success/failure signal.
Tool counts can exceed retained timeline length; nested Agent/browser calls are
separate layers, not a unique-operation total. This adds no wire-protocol fields.
There is no additional listener: the existing agent-lane HTTP server routes
`/monitor/*` only when enabled. The production PM2 config explicitly disables
monitoring; with it disabled no rollout reader, persistence timer or monitor
route is started.

---

## Identity: keys and keyIds

A browser joins with `relayUrl + key`. The relay stores `sha256(key)` only
(`~/zylos/components/browser-remote/keys.json`, managed by `scripts/key.js`), and
`keyId = sha256(key)[0:12]`. The keyId is:

- the map key for the extension's live connection,
- the `endpoint` the agent passes to `/rpc` and `/chat`,
- the C4 `--endpoint` on incoming chat and the `<endpoint>` of `c4-send.js`.

One key, one browser, one endpoint. Revoking the key removes all three at the
next handshake; the file is re-read on every connect.

---

## A. Agent lane — `127.0.0.1:3803`

No auth: the loopback bind is the auth. Bind address is not configurable.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/status` | – | `{ok, extensions:{<keyId>:{connected, label, since, version, capabilities, lastSeenMsAgo, pending}}, pendingReplies:{<keyId>:count}}` |
| POST | `/rpc` | `{endpoint?, method, params?, requestId?, timeoutMs?}` | see below |
| POST | `/chat` | `{endpoint?, text, final?}` | final: `202 {ok:true, endpoint, queued:true, delivered:false, messageId}`; progress: `200 {ok:true, endpoint, delivered:true}` |

`/rpc` responses:

| status | body | meaning |
|---|---|---|
| 200 | `{ok:true, endpoint, result}` | extension answered |
| 200 | `{ok:false, endpoint, code, message, details?}` | extension refused (its code, e.g. `BLOCKED_URL`, `STALE_ELEMENT`) |
| 400 | `{ok:false, code:'BAD_REQUEST'\|'BAD_ENDPOINT'\|'AMBIGUOUS_ENDPOINT'}` | malformed, or several browsers and no `endpoint` |
| 404 | `{ok:false, code:'UNKNOWN_ENDPOINT'}` | no such key |
| 503 | `{ok:false, code:'EXT_OFFLINE'\|'CHAT_PENDING'}` | browser disconnected, or an earlier final reply still awaits acknowledgement |
| 504 | `{ok:false, code:'EXT_TIMEOUT'}` | no answer within `timeoutMs` (default 30 s, max 120 s) |

Relay-side validation is shape only: `method` matches `[A-Za-z][A-Za-z0-9_.:-]{0,127}`,
`params` is an object if present, `requestId` matches `[A-Za-z0-9._:-]{1,128}`,
body ≤ 256 KiB. The relay does not know which methods exist.

`endpoint` may be omitted when exactly one browser is connected.
`final` is a boolean, defaulting to `true`. Ordinary replies end the browser turn;
an intermediate progress message must explicitly set `final:false`. Final replies
are persisted before acceptance, even while the explicitly named, known endpoint is
offline. Progress messages require a live connection and are not queued.
`queued:true` means durably accepted by the relay, not yet confirmed by the browser.
The bounded outbox holds at most 100 replies; `OUTBOX_FULL` or `OUTBOX_WRITE_FAILED`
returns HTTP 503 without accepting the new reply. RPCs remain live-only and return
`CHAT_PENDING` (HTTP 503) while earlier final replies await acknowledgement. This
preserves ordering so an old final reply cannot tear down newly started work.

---

## B. Extension wire protocol — `wss://<domain>/browser-remote/ext`

Path `/ext` only; every other path on :3802 → 404 on upgrade, 426 on plain HTTP.
A leaked public URL lets someone offer to **be** a browser (with a key), never
drive one.

**Handshake:** `Sec-WebSocket-Protocol: zylos-browser-remote.v2, key.<hex>`.
An MV3 service worker cannot set custom headers on a WebSocket, and a
subprotocol — unlike `?key=` — is not written to proxy access logs. Verified as
`sha256(key)` in constant time. Bad or missing key → `401`. A second connection
with the same key supersedes the first (close `4001`); anything in flight on the
old socket fails immediately with `EXT_OFFLINE` rather than after 30 s.

| Direction | Frame | Notes |
|---|---|---|
| ext → relay | `{type:'hello', version, capabilities[]}` | first frame; shown in `/status` |
| relay → ext | `{type:'ping', ts}` / ext → relay `{type:'pong', ts}` | 17 s heartbeat; missed pong → terminate. Doubles as the MV3 service-worker keepalive |
| relay → ext | `{id, type:'req', method, params, requestId?, deadline}` | verbatim from `/rpc`; `deadline` = epoch ms |
| ext → relay | `{id, type:'resp', result}` | |
| ext → relay | `{id, type:'error', code, message, details?}` | `code` is the extension's string code; missing → `EXT_ERROR` |
| ext → relay | `{type:'chat', id?, text, ts, context?}` | owner typed in the side panel; `id` correlates the intake receipt; text ≤ 8000 chars; optional opaque context string ≤ 16000 chars |
| relay → ext | `{type:'chat', id?, role:'assistant', text, ts, final}` | final replies carry a stable UUID `id`; progress has no delivery ID |
| ext → relay | `{type:'chat-ack', id}` | acknowledge a final reply after local persistence and handling |
| relay → ext | `{type:'chat-status', chatId?, state, code?, error?, ts}` | C4 intake receipt: `queued`, `failed`, or `unknown`; `chatId` echoes the user message `id` |

Chat receipts describe transport intake, not Agent thinking or task completion.
`queued` requires a successful C4 JSON queue receipt. `failed` includes rejected messages,
`C4_DELIVERY_FAILED`, and `AGENT_UNAVAILABLE` (C4 returned `delivered` or `suppressed`
for an unhealthy Agent instead of queuing work). `unknown` includes a 45-second intake
timeout (`C4_DELIVERY_TIMEOUT`) or an unconfirmed result (`C4_DELIVERY_UNCONFIRMED`).
A timeout does not prove that the message was never queued; neither side automatically resends it.
Receipts belong to the submitting socket; a late receipt is not sent to its replacement.
Errors are visible in the panel rather than only in relay logs. Keys and chat contents are not logged for receipts.

The extension displays browser activity separately: `running` only while a browser
command is in flight, `ready` between commands, `paused` after `pause`, and `finished`
after `finish`, until the final reply. `finalize` removes the task. `info.control.phase` exposes the executor
phase (`ready`, `paused`, `finished`); the sidebar derives `running` from in-flight commands.
An ordinary assistant reply (missing `final` or `final:true`) ends the turn immediately:
the extension cancels queued actions, revokes control, removes the task card, detaches
the debugger and hands all open task pages back to the owner without closing them.
Only explicit `final:false` progress keeps the task active. System messages do not end it.
The normal C4 `send.js <endpoint> <message>` adapter sends final replies;
`send.js --progress <endpoint> <message>` explicitly sends progress.

Extensions advertise `chat-ack-v1`. After `hello`, the relay sends the oldest
pending final reply for this key, then waits for its exact ID to be acknowledged
before sending the next. On reconnect, the same ID is replayed. Acknowledgements
from a different key or superseded connection do not remove the message.
The extension deduplicates IDs, including after clearing chat history and worker
restart, so a replay neither duplicates a bubble nor ends a later task.
The outbox survives relay restarts in `chat-outbox.json` beside `keys.json` (0600).
Corrupt/unwritable storage fails visibly; it is never replaced with an empty queue.
Clients without `chat-ack-v1` must be upgraded before queued replies can be delivered.
No CDP command or other browser action is persisted or replayed by the relay.

Removed from v1: `state`, `attach`, `detach`, `event`, `lease-lost`, `sessionId`.
The extension attaches `chrome.debugger` itself per task and never streams CDP
events out.

### Extension-owned discovery and execution

The connected extension owns browser methods, parameter validation, instructions,
URL/task/input policies, action queues and idempotency. The relay has no browser
method registry. The extension advertises `tool-catalog-v1` and a read-only
`describe` method. Forward it through the same `/rpc` path:

- `describe {}` returns `schemaVersion`, `extensionVersion`, bundled `instructions`,
  a compact `tools:[{name,description}]` index and a parameter lookup hint.
- `describe {method:"..."}` or `{methods:[...]}` (up to 8 names) returns the chosen
  tools with JSON parameter shapes derived from the execution Zod schemas,
  explicit runtime constraints and examples. Supply one selector, not both.
- Discovery does not acquire browser control and remains available during waits.
  Unknown tool names are rejected by the extension, not guessed by Remote.
- The initial contract version is 1, advertised by extension transport version
  1.4.0+. Older plugins answer UNKNOWN_METHOD; update/reload the extension.

The Agent reuses descriptions within a task and refetches for another endpoint
or extension update. Descriptions belong to the target browser, not to the Relay
installation; no plugin source files need to be present on the Agent server.
Browser semantics are maintained in the extension's `agent/browser-guide.md` and
`utils/tool-catalog.ts`, alongside its implementation. See that repository for
browser-specific policy and recovery details.

### Generic image attachments and CLI output

Image bytes travel as Base64 in the existing result envelope. The relay does not
rewrite results. New extensions label image objects with `mimeType` and `data`.
The CLI recursively walks result objects and arrays, identifies image attachments
by data type (with legacy format/PNG/JPEG-header compatibility), and stores them
on the Agent host before printing JSON. There is no method-name dispatch here.

The same object keeps its metadata and receives `path`, `mimeType`, decoded
`bytes` and `imageReadRequired:true`; `data` is removed. PNG/JPEG are supported.
The CLI rejects declared unsupported/mismatched image types, excessive attachment
count/depth, or storage failures with CLI_ERROR rather than printing the payload.
At most 12 images are accepted per result, with 12 retained overall. Current-batch
files are protected from retention cleanup. Other result data passes through.

Paths require a filesystem shared with the consuming Agent; they are not paths
on the owner's computer or public URLs. This generic output adapter requires no
Remote change when an extension adds a new method returning typed images.

### MV3 constraints (unchanged)

- Service workers are recycled: WS activity resets the idle timer, `chrome.alarms`
  (30 s floor) re-dials after an offline recycle.
- One `chrome.debugger` client per tab; cannot attach to `chrome://*` or the Web Store.
- The yellow "being debugged" banner is visible while attached. By design.
- No custom WebSocket headers (hence the subprotocol key).

---

## C. C4 hop

- In: `{type:'chat'}` → `spawn(node, [c4-receive.js, --channel, browser-remote,
  --endpoint, <keyId>, --priority, 2, --content, '[Browser] ' + text])`. argv
  array, no shell; the owner's text is one inert argument.
- Out: `c4-send.js browser-remote <keyId>` → comm-bridge runs
  `scripts/send.js <keyId> <message>` → `POST 127.0.0.1:3803/chat`.

These messages enter the agent's normal conversation queue and therefore its
session memory — a deliberate decision (see `THIN-RELAY-PLAN.md` §3.3). If that
ever needs to change, the hook is an `--ephemeral` flag on `c4-receive.js`, not
anything in this relay.

## Optional client context

Side-panel chat may include an optional `context` string (maximum 16,000 JavaScript
characters). The relay validates only its type and size, then appends it unchanged
to the C4 message under a supporting-data label. User `text` is preserved verbatim.
The extension owns the context format, capture policy, references and tool rules;
Remote does not select tabs or interpret page content. Without context, existing
clients behave as before. Update Remote before relying on context from newer
extensions; old relays ignore the extra field. Development Monitor shows it under
the originating question. Context can contain page text and is only collected by
Monitor when the existing optional monitor is enabled.
