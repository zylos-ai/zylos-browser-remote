---
name: browser-remote
version: 0.2.0
description: >-
  Drive the owner's own Chrome (real profile, real logins) through the Coco
  browser extension, and chat with the owner in the extension's side panel.
  Use when: (1) a C4 message arrives on channel `browser-remote` -- the owner
  typed in the extension side panel and expects a reply THERE, via
  `c4-send.js browser-remote <keyId>`; (2) the owner asks you to look at, search,
  read or operate a website in THEIR browser; (3) issuing a new extension key.
  The agent talks to the relay only through scripts/browser.js; every command
  goes to a dedicated, marked work tab that the extension creates -- never the
  owner's active tab. Payment / banking / account-security pages are refused by
  the extension. Service: pm2 zylos-browser-remote. Keys: scripts/key.js.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-browser-remote
    entry: relay/server.js
  data_dir: ~/zylos/components/browser-remote
  preserve:
    - keys.json
    - observations/

upgrade:
  repo: zylos-ai/zylos-browser-remote
  branch: main

dependencies:
  - comm-bridge
---

# browser-remote

The relay is a pipe between the owner's Chrome extension and this agent. It has no
opinion about browser commands; everything below is implemented and enforced inside
the extension. If a command is refused, the refusal came from the owner's browser.

```
owner's Chrome ─[extension]─wss─▶ relay :3802 (public, key-authed)
                                  relay :3803 (loopback)  ◀── scripts/browser.js  (you)
side panel chat ─────────────────▶ C4  --channel browser-remote --endpoint <keyId>
you ── c4-send.js browser-remote <keyId> ──▶ scripts/send.js ──▶ side panel bubble
```

`<keyId>` identifies one browser (one key). It is the C4 endpoint of incoming chat
AND the `--endpoint` you pass to `browser.js` when more than one browser is connected.
With a single browser connected you may omit `--endpoint`.

## Replying to the owner

Incoming chat arrives as `[Browser] <text>` on channel `browser-remote`. Reply the
usual way; it shows up as a bubble in their side panel:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote <keyId>
找到了，第一条是 2019 年的版本，要我点开吗？
EOF
```

Keep side-panel replies short: it is a narrow panel next to the page you are working in.
Say what you are about to do before long sequences of commands, and what you found after.

## Driving the browser

```bash
B="node ~/zylos/.claude/skills/browser-remote/scripts/browser.js"
$B status                                   # which browsers are connected (keyId, label, version)
$B open url=https://www.bilibili.com/       # first open CREATES the work tab beside the owner's active tab
$B snapshot interactive=true                # accessibility tree with @refs -> pick a ref
$B fill ref=e7 text="蜘蛛侠"
$B keypress key=Enter
$B observe                                  # snapshot + screenshot (path) + url/title in one call
$B screenshot                               # -> result.path ; READ IT with your image tool
$B click ref=e12
$B finish                                   # detach debugger, keep the tab, group turns grey "等待继续"
$B finalize keep=[123]                      # end the task: close tabs you opened except those kept
```

Every call prints one JSON document: `{ok:true, endpoint, result}` or
`{ok:false, code, message, details?}`. Exit code 0 only when `ok` is true.

### Methods

| method | params | notes |
|---|---|---|
| `info` | – | version, capabilities, current task / tab |
| `open` | `url` | navigate the task tab; with no task yet, creates one (== `start`) |
| `start` | `url` | explicit task creation; fails `TASK_ALREADY_STARTED` if one exists |
| `new-tab` | `url` | another work tab in the same group (max 8) |
| `switch-tab` | `tabId` | make another work tab the target |
| `tabs` | – | work tabs only, with `selected` |
| `snapshot` | `interactive?` | AX tree lines `@ref role "name"`; refs go stale on navigation |
| `observe` | `interactive?` | snapshot + screenshot + viewport |
| `screenshot` | – | PNG; CLI writes it to `~/zylos/components/browser-remote/observations/` and returns `path` |
| `click` | `ref` | real pointer motion + hit-test; refuses covered/moved targets |
| `fill` | `ref`, `text` | select-all then insert |
| `type` | `ref`, `text` | insert at caret |
| `scroll` | `direction`, `pixels?` | up/down/left/right, default 500 |
| `keypress` | `key` | Enter Tab Escape Backspace Arrow* |
| `pause` / `finish` | – | detach debugger, keep tabs; auto-release after 10 min |
| `stop` | – | drop control; tabs stay |
| `finalize` | `keep?` | close tabs the task opened except `keep`, ungroup the rest |

### Error codes you will meet

| code | meaning / what to do |
|---|---|
| `EXT_OFFLINE` / `RELAY_DOWN` | no browser connected / relay not running. Tell the owner (via Lark etc., not the panel) |
| `AMBIGUOUS_ENDPOINT` | several browsers connected: pass `--endpoint <keyId>` from `status` |
| `BLOCKED_URL` | payment / banking / account-security page. Do NOT retry or work around; ask the owner to do that step |
| `CONTROL_NOT_GRANTED` | no task yet: `open <url>` first |
| `TASK_TAB_UNAVAILABLE` / `STOPPED` | owner closed the tab or hit 停止. Stop, tell them |
| `STALE_ELEMENT` / `PAGE_CHANGED` | page navigated since the snapshot: take a fresh `snapshot` |
| `SENSITIVE_INPUT` | password / OTP field: `pause`, ask the owner to type it, then continue |
| `EXT_TIMEOUT` | the browser did not answer in time; `observe` before retrying |

### Rules

- Only the work tabs the extension created are ever driven. Never ask the owner to "arm" a tab.
- Read screenshots with the image tool; do not describe a page you have not observed.
- Logins, payments, OTPs, account settings: `pause`, ask the owner in the panel, wait for their reply.
- Retrying a failed mutating call is safe: the CLI attaches a `requestId` and the extension replays the recorded answer.
- When done, `finalize` so the group and temporary tabs disappear; leave `keep=[...]` for pages the owner wants.

## Ops

```bash
node ~/zylos/.claude/skills/browser-remote/scripts/key.js new --label bobo-mac   # hand the owner relayUrl + key
node ~/zylos/.claude/skills/browser-remote/scripts/key.js list
node ~/zylos/.claude/skills/browser-remote/scripts/key.js revoke <keyId>
pm2 status zylos-browser-remote && pm2 logs zylos-browser-remote
curl -s 127.0.0.1:3803/status
```

Extension side: the owner installs the `remote` build of zylos-browser-extension
(`npm run build` → `.output/chrome-mv3`), opens the side panel, and pastes
`wss://<agent-domain>/browser-remote/ext` plus the key. Caddy must route
`/browser-remote/*` to `127.0.0.1:3802` (see README).
