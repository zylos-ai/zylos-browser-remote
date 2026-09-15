# zylos-browser-remote — protocol (v2)

Two surfaces and one hop. The relay owns the surfaces; it does **not** own the
meaning of anything that crosses them.

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
| ext → relay | `{type:'chat', id?, text, ts}` | owner typed in the side panel; `id` correlates the intake receipt; text ≤ 8000 chars |
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

### What the extension enforces (not the relay)

- **Method table**: `info start open new-tab switch-tab tabs snapshot observe
  screenshot click fill type scroll keypress pause finish stop finalize frames find inspect
  hover double-click right-click drag select check back forward reload dialog wait`. Anything
  else → `UNKNOWN_METHOD`. Params are zod-validated → `BAD_PARAMS`.
- **URL guard** (`utils/guard.ts`, the reviewed cdp-bridge blocklist): navigation
  to payment / banking / account-security URLs → `BLOCKED_URL`; while the task tab
  sits on such a page, `snapshot observe screenshot click fill type scroll
  keypress` are refused, the exits (`open new-tab switch-tab pause finish stop
  finalize`) stay open.
- **Task tabs**: commands touch only tabs the extension created for the task
  (`open` with no task creates one beside the owner's active tab), plus new pages
  Chrome identifies as opened by those task tabs. Never the
  owner's own tab.
- **Idempotency**: `requestId` on a mutating method replays the recorded answer
  (`replayed:true`) instead of acting twice; 200-entry LRU per worker lifetime.
  Matching in-flight IDs are coalesced; different method/params with the same ID
  return `REQUEST_ID_CONFLICT`. Fresh CLI invocations use fresh IDs.
- **Sensitive input**: password / OTP fields → `SENSITIVE_INPUT`.
- **Kill switch**: the owner's 停用 closes the socket and releases the task.

### Browser actions v2 (extension 0.11.0+)

`hello` / `info` capabilities add `browser-actions-v2`, `frames-v1`, `popup-v1`,
`dialog-v1`, and `wait-v1`. Wire envelopes, HTTP endpoints and relay forwarding
remain unchanged. Method parameters and Agent workflows are documented in
[SKILL.md](../SKILL.md) and the extension's `docs/BROWSER-ACTIONS.md`.

Commands are queued in the plugin. Stop/pause/finish/finalize cancel preceding
queued work; dialog handling and info remain accessible while a wait is pending.
The screenshot capture/verification stage has a 12-second budget, also bounded by
the RPC deadline. `SCREENSHOT_TIMEOUT` identifies the stage; late pixels are ignored.
WebSocket ping handling runs independently of command promises.
`DIALOG_OPEN` can report a dialog caused by an already dispatched click. The
caller handles it with `dialog`; it must not blindly retry the click. `wait`
uses local polling, defaults to 10 seconds, max 60 seconds and never extends
the `/rpc` deadline. A longer wait therefore also needs a longer `timeoutMs`.
No child CDP sessions or browser events are exposed on the relay wire.

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
