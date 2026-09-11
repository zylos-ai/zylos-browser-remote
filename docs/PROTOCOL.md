# zylos-browser-remote — protocol

Three layers, frozen. Layer 1 is what the agent talks, layer 2 is what the
extension talks, layer 3 is the seam that lets the transport underneath be
replaced without either side noticing.

```
agent / CDP client                relay                         owner's Chrome
──────────────────                ─────                         ──────────────
  layer 1: CDP over WS   ──▶  :3803 agent lane  (loopback only)
                                    │
                              chokepoint: allowlist → guard → idempotency
                                    │
                              :3802 ext lane  ──▶ wss://<domain>/browser-remote/ext
                                                        layer 2: ext wire protocol
```

Layer 3 (`ConnectionProvider`) sits in front of layer 1: the agent asks a
provider for a **lease**, and the lease carries the `cdpUrl` it should attach to.

---

## Layer 1 — agent-facing: standard CDP

The agent lane binds **127.0.0.1:3803 only** and is never routed by Caddy.
It mimics enough of Chrome's DevTools HTTP surface that a stock CDP client
attaches without special-casing.

| Method | Path | Purpose |
|---|---|---|
| GET | `/json/version` | Chrome-shaped version blob |
| GET | `/json` , `/json/list` | target list (one page target per active lease) |
| GET | `/status` | relay health: extension connected?, leases, pending |
| POST | `/lease` | acquire a lease → `{leaseId, cdpUrl, ttl, expiresAt}` |
| POST | `/lease/<id>/renew` | extend TTL |
| DELETE | `/lease/<id>` | revoke early |
| WS | `/devtools/page/<leaseId>` | the CDP socket |

`GET /json/list` lazily acquires a lease when none is active and an extension
is connected, so a stock client that only knows `/json/list` → `webSocketDebuggerUrl`
works unmodified. That shortcut is safe *because* the lane is loopback-only.

Frames on the WS are ordinary CDP: `{id, method, params}` in, `{id, result}` or
`{id, error:{code,message}}` out, plus unsolicited `{method, params}` events.

### Allowed methods (default-deny)

Two families pass the chokepoint; **everything else is refused**, including
anything merely "read-only looking" that is not listed.

*Real CDP, forwarded to `chrome.debugger` as-is:*
`Page.enable`, `Page.disable`, `Page.navigate`, `Page.reload`,
`Page.getNavigationHistory`, `Page.navigateToHistoryEntry`,
`Page.captureScreenshot`, `Page.bringToFront`, `Page.getFrameTree`

*`_br.*` pseudo-methods, implemented by trusted extension code:*
`_br.info`, `_br.listTabs`, `_br.snapshot`, `_br.click`, `_br.fill`,
`_br.press`, `_br.screenshot`, `_br.navigate`, `_br.waitFor`

`_br.press` takes a key **name** — `Enter`, `Tab` or `Escape`, and nothing else.
The descriptor (code, virtual key code, text) lives in the extension; modifier
combos are deliberately unavailable, because that is how a keyboard action turns
into a raw-input lane by degrees. It refuses when nothing is focused, when the
focused field is a password field, and when the focused field sits in a form
whose `action` is blocklisted — the one place an Enter's destination is visible.

### Explicitly banned

`Runtime.evaluate` and every other arbitrary-code path (`Runtime.callFunctionOn`,
`Runtime.compileScript`, `Page.addScriptToEvaluateOnNewDocument`, `Debugger.*`),
raw input injection (`Input.*`), cookie/credential surfaces (`Network.getAllCookies`,
`Network.setCookie`, `Storage.*`), and request interception (`Fetch.*`).

This is the extension driving the owner's **real** browser with their real login
state. Arbitrary JS in that context is equivalent to full account access, and the
URL guard cannot screen behaviour — only URLs (see `GUARD-REVIEW.md` F1 in
`cdp-bridge`). So the ban lives at the allowlist layer, above `guard.js`.

Structured actions (`_br.click`, `_br.fill`) take a **selector**, never
coordinates and never code. The extension resolves the selector itself and
applies its own copy of the guard to any URL the target would reach.

### P0 scope

Single owner, single tab: `navigate` / `snapshot` / `click` / `fill` /
`screenshot`. Full Playwright-grade CDP compatibility (sessions, multi-target,
`Network.*`, `DOM.*` trees) is a LATER milestone and is not faked here.

---

## Layer 2 — relay ↔ extension wire protocol

WebSocket, `ws://127.0.0.1:3802/ext`, reachable from outside only through the
platform edge at `wss://<agent-domain>/browser-remote/ext`. Every other path on
:3802 is refused. A leaked public URL lets someone offer to **be** a browser
(and only with the token); it never lets them drive one.

**Auth:** the token rides in `Sec-WebSocket-Protocol` as `token.<hex>` alongside
the protocol name `zylos-browser-remote.v1`. An MV3 service worker cannot set
custom headers on a WebSocket, and a subprotocol — unlike `?token=` — is not
written to every proxy access log on the path. Compared timing-safe over
SHA-256 digests. Newest authenticated connection supersedes the older one, so a
reconnect after a dropped socket heals instead of leaving a zombie.

| Direction | Frame | Notes |
|---|---|---|
| ext → relay | `{type:'hello', version, capabilities[], tabs[]}` | first frame after connect |
| relay → ext | `{type:'ping', ts}` / ext → `{type:'pong'}` | 17s app-level heartbeat |
| relay → ext | `{id, type:'attach', tabId}` | attach `chrome.debugger` to a tab |
| relay → ext | `{id, type:'detach', tabId}` | release it |
| relay → ext | `{id, type:'req', method, params, tabId}` | post-chokepoint CDP or `_br.*` |
| ext → relay | `{id, type:'resp', result}` | success |
| ext → relay | `{id, type:'error', error}` | failure (string message) |
| ext → relay | `{type:'event', method, params, tabId}` | CDP event, forwarded to the agent |
| relay → ext | `{type:'lease-lost', leaseId}` | lease expired/revoked → ext detaches |

The heartbeat stays in the protocol even though the edge WS-cutoff probe was
cancelled ("就当它是通的"): it is free, it doubles as the MV3 service-worker
keepalive (Chrome 116+ resets the idle timer on WS activity), and it avoids
rework if the edge turns out to cut long-lived sockets after all.

Commands time out after 30s. An `idempotencyKey` on a mutating `_br.*` request
is remembered in a 500-entry LRU so a retry after a mid-flight cutoff replays the
recorded answer instead of double-clicking or double-navigating.

### MV3 constraints (agreed; not to be "simplified" away)

- Service workers are recycled: WS activity resets the idle timer, `chrome.alarms`
  (30s floor) is the backstop.
- One `chrome.debugger` client per tab — nothing else may be attached.
- Cannot attach to `chrome://*` or the Chrome Web Store.
- A permanent yellow "being debugged" banner is visible while attached. By design.
- No custom WebSocket headers (hence the subprotocol token).

---

## Layer 3 — ConnectionProvider (migration seam)

```js
const lease = await provider.acquire({ ttl });
// { leaseId, cdpUrl, ttl, expiresAt, renew(ttl?), revoke(), isExpired() }
```

`LocalRelayProvider` talks to the relay in this repo. A future
`ConnectorProvider` will hand back a lease pointing at a platform-brokered
endpoint. Callers only ever see the lease, so the swap changes no call site.

**The guard sits BELOW the provider**, at the relay's single chokepoint, so
changing providers cannot bypass it. There is exactly one code path from an
agent frame to the extension, and it runs `methodAllowed()` then
`screen({method, params, tabUrl})` every time.
