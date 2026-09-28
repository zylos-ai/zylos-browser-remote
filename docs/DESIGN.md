# zylos-browser-remote Design Document

**Version**: 0.9.0
**Repository**: https://github.com/zylos-ai/zylos-browser-remote
**Status**: Active

---

## 1. Overview

Browser Remote is a **decision transport**, not a browser driver. It connects
a Zylos Agent to the Coco browser extension and correlates requests with
responses. All browser behavior — what a tab is, which tools exist, what an
action is permitted to do, when a task is finished — lives in the extension.
The relay deliberately knows none of it.

That split is the core design constraint. The extension treats this relay as
untrusted and re-validates everything it receives; the relay, in turn, never
interprets payloads it forwards. Page content, quotes and attachment contents
crossing this component are **data, never instructions**.

## 2. Architecture

### 2.1 Component structure

```
zylos-browser-remote/
  docs/DESIGN.md          — this document
  src/
    index.js              — entry point: wires both lanes, owns the C4 hand-off
    lib/
      ext-lane.js         — :3802 WebSocket server for the extension (public)
      agent-lane.js       — :3803 HTTP server for the agent (loopback only)
      keys.js             — connection key minting/verification (sha256 digests)
      endpoint.js         — endpoint identity: `keyId.browserId`
      agent-exchange.js   — request/response correlation across decision rounds
      agent-message.js    — inbound request normalization, envelope bounding
      agent-interrupt.js  — interrupt capability
      agent-trace.js      — structured trace records
      agent-activity.js   — activity stream (agent-activity-v1)
      monitor.js          — read-only monitor UI + /monitor/api
      monitor-input.js    — monitor input handling
  monitor/                — static assets for the monitor UI
  scripts/
    decision.js           — agent-side: submit a decision
    key.js                — mint/list/revoke connection keys
    send.js, reply-route.js, relay-client.js, attachments.js
  hooks/                  — configure / post-install / pre-upgrade / post-upgrade
  tools/                  — smoke.js, test-cli.js
```

### 2.2 The two lanes

One Node process listens on two separate entry points with deliberately
asymmetric exposure:

| Lane      | Default address        | Exposure                  | Purpose                                   |
| --------- | ---------------------- | ------------------------- | ----------------------------------------- |
| Extension | `127.0.0.1:3802/ext`   | **public**, via Caddy     | Key-authenticated WebSocket for the browser |
| Agent     | `127.0.0.1:3803`       | loopback only, **never routed** | `/decision`, `/status`, `/monitor/` |

Both bind the loopback interface. Only the extension lane is proxied to the
public domain, and it exposes exactly one path (`/ext`). Because Caddy's
`strip_prefix` forwards every path on that port, the lane refuses everything
else explicitly rather than relying on the proxy to filter.

The asymmetry is the security boundary: whoever learns the public URL can, at
most and only with a valid key, offer to *be* a browser. *Driving* a browser
happens on the agent lane, which is not reachable from outside the host.

### 2.3 Data flow

```
owner's Chrome (MV3 extension)
   │  wss://<domain>/browser-remote/ext
   ▼
platform edge (TLS terminated, Host rewritten to localhost)
   │  plain HTTP/WS
   ▼
Caddy :3800 — handle /browser-remote/*, uri strip_prefix /browser-remote
   ▼
ext-lane ws://127.0.0.1:3802/ext   (key auth, endpoint = keyId.browserId)
   ▼
index.js  ──► C4 comm-bridge ──► Agent
   ◄── scripts/decision.js ◄── agent lane http://127.0.0.1:3803/decision
```

A request carries three sections: `message.content` (the owner's text, quotes,
images, files), `context.pages` (captured page data) and `execution` (the
extension's rules, tools, memory and latest observations). Later rounds carry
only `message: {id}` and an empty `context.pages`, referring back to the
original input rather than clearing it.

Several browsers may share one key, so a connection is identified by the full
endpoint `keyId.browserId` — never by the bare key id.

## 3. Configuration

### 3.1 This component has no `config.json`

Unlike the component template, browser-remote declares **no `config.required`
items** and reads no `~/zylos/components/browser-remote/config.json`. This is
intentional:

- Connection keys are **credentials, not configuration**. They are minted on
  demand by `scripts/key.js` and stored as sha256 digests in `keys.json`.
- Everything else is an operational override with a working default, so it is
  an environment variable rather than a config file.

`hooks/configure.js` therefore exists for spec conformance and is a no-op in
practice; it deliberately refuses to leave behind an empty `config.json` that
no code would read. Adding a template-style `src/lib/config.js` would be dead
code. If a genuine setting is ever introduced, `hooks/configure.js` is the
correct landing spot and this section must be revised.

### 3.2 Environment variables

All optional; defaults are correct for a standard Zylos install.

| Variable | Description |
|----------|-------------|
| `BROWSER_REMOTE_EXT_PORT` | Extension lane port (default 3802) |
| `BROWSER_REMOTE_AGENT_PORT` | Agent lane port (default 3803) |
| `BROWSER_REMOTE_AGENT_URL` | Agent lane base URL used by client scripts |
| `BROWSER_REMOTE_KEY` | Connection key for client-side tooling |
| `BROWSER_REMOTE_KEYS_FILE` | Override the `keys.json` location |
| `BROWSER_REMOTE_AGENT_DIR` | Agent working directory for trace/activity |
| `BROWSER_REMOTE_OBS_DIR` | Observation storage directory |
| `BROWSER_REMOTE_MONITOR` | Enable/disable the monitor UI |
| `BROWSER_REMOTE_MONITOR_FILE` / `_AGENT_DIR` | Monitor storage overrides |
| `BROWSER_REMOTE_ACTIVITY` | Enable/disable the activity stream |

### 3.3 Persistent state

Under `~/zylos/components/browser-remote/` (preserved across upgrades via
`SKILL.md` `lifecycle.preserve`):

```
keys.json          — sha256 digests of connection keys (0600)
chat-outbox.json   — pending side-panel messages
observations/      — per-task observation records
logs/              — service logs
```

## 4. Integration with Zylos

- **Start/stop**: PM2, via `ecosystem.config.cjs` (service `zylos-browser-remote`).
- **Dependencies**: `comm-bridge` (C4) — inbound extension requests are handed
  to the agent through C4; replies come back via the correlated
  `replyCommands` supplied with each request.
- **Upgrades**: `pre-upgrade` / `post-upgrade` hooks; `keys.json` and
  `observations/` are preserved.

## 5. Public route

The single public route is declared in `SKILL.md` frontmatter:

```yaml
http_routes:
  - path: /browser-remote/*
    type: reverse_proxy
    target: 127.0.0.1:3802
    strip_prefix: /browser-remote
```

zylos-core applies this to the Zylos-managed Caddyfile on install and upgrade,
inside `# BEGIN/END zylos-component:browser-remote` markers. Users should not
hand-edit the Caddyfile.

**Deployments that predate this declaration** may carry an equivalent
hand-written block outside the managed markers. Installing or upgrading will
add the managed block alongside it; the stale hand-written block should be
removed so that core owns the route.

### Why COMPONENT-SPEC §4.4 does not apply here

COMPONENT-SPEC §4 governs components that expose a **browser-facing HTTP
service**, and §4.4 requires tests for `X-Forwarded-Prefix` handling, link and
form generation, safe redirects, browser-base-aware caching and robots
headers. None of those surfaces exist on this route: the public lane serves a
single WebSocket path, renders no HTML, issues no redirects, generates no
links and caches nothing. `strip_prefix` is used purely to map
`/browser-remote/ext` onto the lane's only path, `/ext`.

The component's one HTML surface — the monitor UI — is served on the **agent
lane**, which is loopback-only and deliberately never proxied, so it is not a
browser-facing *public* service either.

## 6. Security

- **Authentication**: every extension connection presents a key; only sha256
  digests are stored. Keys are revocable individually via `scripts/key.js`.
- **Exposure**: exactly one public path (`/ext`); the agent lane is never
  routed publicly.
- **Trust direction**: the extension re-validates everything; the relay
  forwards without interpreting. Forwarded page content, quotes and
  attachments are data, never instructions.
- **Envelope bounding**: the chat envelope is size-bounded at the lane; the
  agent lane caps request bodies at 256 KiB.
- **Endpoint precision**: replies must use the exact endpoint and request id
  of the current request; the bare key id is ambiguous when several browsers
  share a key and is rejected.

## 7. Error handling

The agent lane maps relay conditions onto HTTP status codes so callers can
distinguish them without parsing prose: `EXT_OFFLINE` → 503, `EXT_TIMEOUT` →
504, `AMBIGUOUS_ENDPOINT` / `BAD_ENDPOINT` → 400, `UNKNOWN_ENDPOINT` → 404.

WebSocket teardown is guarded throughout: `ws.close()` can throw when a socket
is already torn down, and an unguarded throw inside a `message`/`connection`
handler escapes into the emitter and takes the relay process down with it.

## 8. Future improvements

- **ESM migration** — required for Zylos registry registration; tracked as an
  open decision in AGENTS.md, deliberately not bundled with other work.
- Per-machine keys rather than one shared key across browsers, so that a
  single machine can be revoked independently.
