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
| GET | `/status` | – | `{ok, extensions:{<keyId>:{connected, label, since, version, capabilities, lastSeenMsAgo, pending}}}` |
| POST | `/rpc` | `{endpoint?, method, params?, requestId?, timeoutMs?}` | see below |
| POST | `/chat` | `{endpoint?, text}` | `200 {ok:true, endpoint, delivered:true}` |

`/rpc` responses:

| status | body | meaning |
|---|---|---|
| 200 | `{ok:true, endpoint, result}` | extension answered |
| 200 | `{ok:false, endpoint, code, message, details?}` | extension refused (its code, e.g. `BLOCKED_URL`, `STALE_ELEMENT`) |
| 400 | `{ok:false, code:'BAD_REQUEST'\|'BAD_ENDPOINT'\|'AMBIGUOUS_ENDPOINT'}` | malformed, or several browsers and no `endpoint` |
| 404 | `{ok:false, code:'UNKNOWN_ENDPOINT'}` | no such key |
| 503 | `{ok:false, code:'EXT_OFFLINE'}` | key known, browser not connected |
| 504 | `{ok:false, code:'EXT_TIMEOUT'}` | no answer within `timeoutMs` (default 30 s, max 120 s) |

Relay-side validation is shape only: `method` matches `[A-Za-z][A-Za-z0-9_.:-]{0,127}`,
`params` is an object if present, `requestId` matches `[A-Za-z0-9._:-]{1,128}`,
body ≤ 256 KiB. The relay does not know which methods exist.

`endpoint` may be omitted when exactly one browser is connected.

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
| ext → relay | `{type:'chat', text, ts}` | owner typed in the side panel; text ≤ 8000 chars, else refused (never truncated) |
| relay → ext | `{type:'chat', role:'assistant', text, ts}` | agent's reply from `/chat` |
| relay → ext | `{type:'chat-status', state, error}` | only on refusal of an owner message |

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
