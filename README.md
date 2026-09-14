# zylos-browser-remote

Lets a Zylos agent drive **the owner's own Chrome** — real profile, real logins —
from a container that has no public IP and cannot reach the owner's machine.
The browser dials out; the agent never dials in. The owner talks to the agent
from the extension's side panel; the agent works in dedicated, marked tabs.

This repo is the **relay**: a thin, opinion-free pipe plus the zylos-core
component glue. Every browser decision (what a command means, which URLs are
off-limits, which tab may be touched, idempotency) lives in the extension —
[`zylos-browser-extension`](../zylos-browser-extension), `remote` build.

```
owner's Chrome ─[extension]─→ wss://<agent-domain>/browser-remote/ext
                                 │  platform edge (TLS)
                                 ▼
                           caddy :3800   handle /browser-remote/*  (strips prefix)
                                 ▼
   relay :3802   PUBLIC lane — extension ingress ONLY, path /ext, key-authed
   relay :3803   LOOPBACK ONLY, never routed — POST /rpc, POST /chat, GET /status
                                 ▲
                scripts/browser.js (agent CLI)   scripts/send.js (C4 outbound)
```

Two ports, and they must not be collapsed: Caddy's `strip_prefix` forwards
*every* path on :3802, so anything served there is reachable by whoever learns
the domain. A leaked public URL lets someone offer to **be** a browser (and only
with a key) — never to drive one.

## Run it

```sh
npm install
node scripts/key.js new --label bobo-mac     # prints the key ONCE; hand relayUrl + key to the owner
npm start                                    # ext lane :3802, agent lane :3803
npm test                                     # smoke (fake ext ↔ relay) + CLI end-to-end (real scripts, real relay process)
```

Ports: `BROWSER_REMOTE_EXT_PORT` / `BROWSER_REMOTE_AGENT_PORT`. Keys file:
`BROWSER_REMOTE_KEYS_FILE` (default `~/zylos/components/browser-remote/keys.json`,
digests only, re-read on every handshake). `BROWSER_REMOTE_KEY` is a single-key
shortcut for dev. The agent lane's bind address is not configurable —
`127.0.0.1` is a safety property, not a default.

Owner side: install the extension's default remote build (`npm run build` in
zylos-browser-extension → `.output/chrome-mv3`), open the side panel,
paste `wss://<agent-domain>/browser-remote/ext` and the key.

## As a zylos-core component

`SKILL.md` is the component manifest (`type: communication`, pm2 service
`zylos-browser-remote`, data dir `~/zylos/components/browser-remote`). Installed
at `~/zylos/.claude/skills/browser-remote/`:

| script | who runs it | does |
|---|---|---|
| `relay/server.js` | pm2 | the relay |
| `scripts/browser.js` | the agent | `browser.js [--endpoint k] <method> [k=v … \| json]` → `POST /rpc`; screenshots land in `observations/` |
| `scripts/send.js` | comm-bridge, via `c4-send.js browser-remote <keyId>` | `POST /chat` → side-panel bubble |
| `scripts/key.js` | ops | `new --label` / `list` / `revoke` |

Owner messages from the side panel arrive as C4 conversations on channel
`browser-remote`, endpoint `<keyId>`, content prefixed `[Browser] `. The name is
`browser-remote` because `browser` is the official zylos-browser capability
component and `browser-extension` is zylos-browser-channel.

## Safety model

The relay is trusted with one fact — which key is which browser — and nothing
else. Both ends treat it as untrusted:

- **Extension**: re-validates every `req` (zod), refuses unknown methods, screens
  URLs against the reviewed blocklist (`utils/guard.ts`) on navigation *and* on
  the live task-tab URL, drives only tabs it created, replays retried mutating
  calls by `requestId`, refuses password/OTP fields, has a kill switch.
- **Relay**: bounds bodies and chat text, validates envelopes, passes owner text
  to `c4-receive.js` as a single argv element (no shell), exposes `/chat` only on
  loopback so nobody on the public side can put words in the agent's mouth.

There is deliberately **no CDP surface** for stock clients anymore: keeping one
meant keeping leases, event fan-out and a second allowlist in the relay. If raw
CDP is ever needed, it goes in as an extension method behind the extension's
policy — the relay does not change.

## Layout

```
relay/server.js        wiring + C4 hop (spawn c4-receive.js)
relay/ext-lane.js      :3802  key → connection map, heartbeat, req/resp correlation, chat envelope
relay/agent-lane.js    :3803  /rpc /chat /status
relay/keys.js          keys.json, sha256, keyId, timing-safe verify
scripts/               browser.js · send.js · key.js · relay-client.js
tools/smoke.js         fake extension ↔ relay, 37 assertions
tools/test-cli.js      real relay process + real scripts + fake extension, 25 assertions
docs/PROTOCOL.md       the two surfaces and the C4 hop
docs/THIN-RELAY-PLAN.md  why the relay got thin, decisions taken
```
