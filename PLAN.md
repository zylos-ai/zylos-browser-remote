# zylos-browser-remote — build plan (working doc, not the README)

Status 2026-09-11: relay + extension + all three test layers DONE and pushed
(`a7bf61c`, `9ceda77`, `86d127e`, `e62c70d`). The real-Chrome round trip passes
34/34 (`npm run test:chrome`). NEXT: option-3 allowlist widening for
agent-browser, then install agent-browser locally and test client-vs-relay.
Only after that: mint `relay/token` + register in pm2's ecosystem file.
(Original status: repo cloned EMPTY, nothing written yet. Caddy route already live.)
Owner ask: bobo, Lark group `oc_783338341070bc1562a33ef8fa0d2b14`; design authored
by peer agent Piper, 分工 = this agent writes the code.

## Already done outside this repo (do NOT redo)

- Caddy route LANDED + validated + reloaded in `~/zylos/http/Caddyfile`:
  `handle /browser-remote/*` → `uri strip_prefix /browser-remote` →
  `reverse_proxy 127.0.0.1:3802 { flush_interval -1 }`, INSIDE the
  `http://localhost:3800` site block, OUTSIDE the managed markers (re-add if a core
  upgrade rewrites the file). `/browser-remote/*` currently 502s — expected until the
  relay listens. `/health` still 200.
- Repo access verified: `zylos-ai/zylos-browser-remote`, private, **admin**, default
  branch `main`, empty. Clone at `~/zylos/workspace/zylos-browser-remote`
  (askpass `vault/github/askpass.sh`).
- Prior parked work to REUSE, not rewrite: `~/zylos/workspace/cdp-bridge/`
  - `relay/guard.js` — URL/host blocklist + deep param walk, adversarially reviewed
    (`GUARD-REVIEW.md`). **Source of truth. Copy verbatim.**
  - `tools/test-guard.js` — 42 offline assertions, all passing. Copy verbatim.
  - `tools/check-guard-sync.js` — asserts relay/extension guard copies are
    byte-identical inside the SHARED GUARD BLOCK markers.
  - `relay/server.js` — reference implementation of the ext lane: token in WS
    subprotocol (`token.<hex>`, MV3 workers cannot set WS headers), timing-safe
    compare over SHA-256 digests, newest-connection-wins, 17s app-level heartbeat
    (doubles as the MV3 service-worker keepalive), idempotency-key LRU, pending-map
    with 30s timeout. Lift these mechanics; the *surface* changes (see below).
  - `extension/` — MV3 manifest + background dial-out + options page, already written
    against the old protocol; port rather than restart.

## Topology decided (keeps the landed Caddy route unchanged)

```
bobo's Chrome ─[MV3 ext]→ wss://<domain>/browser-remote/ext
                              │ platform edge (TLS, Host→localhost)
                              ▼
                        caddy :3800  handle /browser-remote/*  (strips prefix)
                              ▼
   relay :3802  PUBLIC lane — extension ingress ONLY, path /ext, token-authed.
                Every other path on :3802 → 426/404. A leaked public URL lets
                someone offer to BE a browser, never to drive one.
   relay :3803  LOOPBACK ONLY, never routed by Caddy — agent-facing CDP surface:
                GET /json/version, GET /json/list, WS /devtools/page/<leaseId>
```

Two ports, exactly like cdp-bridge's ext/ctl split, and for the same reason. Do not
collapse them onto one port: Caddy strip-prefix forwards *all* paths on 3802.

Port map (verified free/taken 2026-09-11): 3480 platform-reserved, 3800/3801 Caddy,
3456 web-console, 3457 lark, 3470 dashboard. 3802 + 3803 free.

## Three-layer protocol (frozen with bobo — do not relitigate)

1. **Agent-facing = standard CDP over WebSocket.** `zylos-browser` today takes only a
   numeric port → make it accept port-or-URL. Discovery endpoints must look enough
   like Chrome's that a stock CDP client attaches.
2. **Extension wire protocol** (relay ↔ extension): `hello`/`capabilities`,
   `attach`/`detach`, CDP `req`/`resp`/`event`, `heartbeat`, `lease-lost`.
3. **ConnectionProvider** = migration seam. `LocalRelayProvider` now,
   `ConnectorProvider` later. `acquire()` returns a **LEASE**, not a bare endpoint:
   `{ leaseId, cdpUrl, ttl, expiresAt, renew(), revoke() }`.

## Non-negotiable placements

- **Guard sits BELOW the provider**, at the relay's single CDP chokepoint — so
  swapping providers cannot bypass it. Every agent→extension CDP frame passes
  `methodAllowed()` then `screen({method, params, tabUrl})`.
- **Raw `Runtime.evaluate` is BANNED** at the chokepoint allowlist (the extension
  drives bobo's REAL browser and login state). Structured actions only. Note this
  closes GUARD-REVIEW F1 at the *allowlist* layer, not inside `guard.js` —
  `test-guard.js` still asserts F1/F4/F5 OPEN for `screen()` in isolation, and that
  is correct; add a SEPARATE test file for the allowlist instead of editing those 42.
- **P0 scope**: single user, single tab, `navigate` / `snapshot` / `click` / `fill` /
  `screenshot`. Structured actions land as a `_br.*` pseudo-method namespace
  implemented by trusted extension code, plus a small real-CDP allowlist
  (`Page.navigate`, `Page.captureScreenshot`, …). Full Playwright-grade CDP
  compatibility is explicitly a LATER milestone — say so in the README, don't fake it.
- **Heartbeat/reconnect stay in the protocol** even though the edge-cutoff probe was
  cancelled (bobo: "就当它是通的"). Free to keep, avoids rework if the edge does cut
  long WS connections.
- MV3 constraints already agreed and not to be "simplified" away: service-worker
  recycling (WS activity resets the idle timer; `chrome.alarms` 30s floor as backstop),
  one `chrome.debugger` client per tab, cannot attach to `chrome://` or the Web Store,
  permanent yellow "being debugged" banner, no custom WS headers.

## Build order

1. Scaffold: `package.json` (dep: `ws`), `.gitignore` (must exclude `token`,
   `node_modules`), `README.md`, `docs/PROTOCOL.md` (freeze the three layers above).
2. Copy `guard.js` + `test-guard.js` + `check-guard-sync.js` verbatim; confirm
   `node tools/test-guard.js` → 42 pass.
3. Relay skeleton: `relay/ext-lane.js` (:3802), `relay/agent-lane.js` (:3803),
   `relay/chokepoint.js` (allowlist + guard + idempotency), `relay/server.js` (wiring).
4. `relay/lease.js` + `relay/providers/{connection-provider,local-relay-provider}.js`.
5. Smoke test with a fake extension client + a fake CDP client: bad token → 401,
   good token → hello, lease acquire → cdpUrl, `Page.navigate` allowed, blocklisted
   URL refused, `Runtime.evaluate` refused, heartbeat, lease expiry revokes.
6. First commit + push to `main`. Then the MV3 extension port.
7. Only AFTER a tab round-trips `navigate`+`snapshot`: add the relay to
   `~/zylos/pm2/ecosystem.config.cjs` (boot-durable — NOT `pm2 start` + `pm2 save`;
   boot reads the ecosystem file only, which is exactly how tailscaled died silently).
   Mint the token as `openssl rand -hex 32 > relay/token && chmod 600 relay/token`;
   never commit it.

## Report-back

Progress goes to the Lark group, not a DM:
`node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "oc_783338341070bc1562a33ef8fa0d2b14|type:group|msg:<latest incoming msgid>"`
Promised bobo: report when the first version round-trips single-tab
navigate/snapshot, and push the first commit.
