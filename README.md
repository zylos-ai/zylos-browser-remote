# zylos-browser-remote

Lets this agent drive **the owner's own Chrome** — real profile, real logins —
from a container that has no public IP and cannot reach the owner's machine.
The browser dials out; the agent never dials in.

Status: **P0 relay works end-to-end against a fake extension** (`npm run smoke`,
28 assertions). The MV3 extension itself is the next milestone — until it lands
there is no real browser on the other end.

```
owner's Chrome ─[MV3 ext]→ wss://<agent-domain>/browser-remote/ext
                              │  platform edge (TLS, Host→localhost)
                              ▼
                        caddy :3800   handle /browser-remote/*  (strips prefix)
                              ▼
   relay :3802   PUBLIC lane — extension ingress ONLY, path /ext, token-authed
   relay :3803   LOOPBACK ONLY, never routed — CDP surface the agent attaches to
```

Two ports, and they must not be collapsed: Caddy's `strip_prefix` forwards
*every* path on :3802, so anything served there is reachable by whoever learns
the domain. Keeping the driving surface on :3803 means a leaked public URL lets
someone offer to **be** a browser (and only with the token) — never to drive one.

## Run it

```sh
npm install
openssl rand -hex 32 > relay/token && chmod 600 relay/token   # never commit this
npm start            # ext lane :3802, agent lane :3803
npm test             # 42 guard + 42 chokepoint assertions, offline
npm run smoke        # full loopback round-trip, fake extension + fake CDP client
```

Ports are overridable with `BROWSER_REMOTE_EXT_PORT` / `BROWSER_REMOTE_AGENT_PORT`;
the agent lane's bind address is not — `127.0.0.1` is a safety property, not a default.

Attach like you would to Chrome:

```js
const { LocalRelayProvider } = require('./relay/providers/local-relay-provider');
const lease = await new LocalRelayProvider().acquire({ ttl: 15 * 60_000 });
// lease.cdpUrl -> ws://127.0.0.1:3803/devtools/page/<leaseId>
```

or just point a stock CDP client at `http://127.0.0.1:3803` — `/json/version`
and `/json/list` answer in Chrome's shape, and `/json/list` mints a lease on
demand.

## Safety model

One gate, one code path. Every agent→browser frame passes, in order:

1. **default-deny allowlist** (`relay/chokepoint.js`) — `Page.navigate`,
   `Page.reload`, `Page.captureScreenshot`, a few more, plus the `_br.*`
   structured actions. Everything else is refused.
2. **URL guard** (`relay/guard.js`, copied verbatim from the reviewed
   `cdp-bridge` original) — payment/checkout/banking/account-settings URLs and
   hosts, screened raw and percent-decoded, walking every string in `params`.
3. **idempotency** — a retried mutating action replays its recorded answer
   instead of clicking or navigating twice.

**`Runtime.evaluate` is banned**, along with every other arbitrary-code and raw-input
path. A URL blocklist cannot see `document.querySelector('form#pay').submit()`
coming, and arbitrary JS in a logged-in browser is account-takeover-equivalent.
Structured actions take selectors, never code and never coordinates.

The guard sits **below** the provider seam, so swapping `LocalRelayProvider` for a
future `ConnectorProvider` cannot route around it.

`tools/test-guard.js` (42 assertions) still asserts that `screen()` leaves
F1/F4/F5 open — correct, because those are behaviour, not URLs, and they are
closed one layer up in `tools/test-chokepoint.js` (42 more). Don't "fix" either
file to agree with the other; they test different layers.

## Scope

P0 is single owner, single tab: `navigate` / `snapshot` / `click` / `fill` /
`screenshot`. Full Playwright-grade CDP compatibility — sessions, multi-target,
`Network.*`, `DOM.*` trees — is a later milestone and is **not** faked here: a
stock client attaches and the allowlisted methods work, anything else is refused
loudly rather than silently half-implemented.

Protocol details, frame shapes, and the MV3 constraints that shaped them:
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Layout

```
relay/chokepoint.js              allowlist + guard + idempotency  (the gate)
relay/guard.js                   URL blocklist, shared with the extension
relay/ext-lane.js                :3802 token-authed extension ingress
relay/agent-lane.js              :3803 loopback CDP + lease HTTP surface
relay/lease.js                   time-boxed, revocable grants
relay/providers/                 ConnectionProvider seam + LocalRelayProvider
relay/server.js                  wiring and boot
tools/                           tests + smoke test
extension/                       MV3 extension — next milestone
```
