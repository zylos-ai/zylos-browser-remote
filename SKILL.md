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
usual way when the turn is complete; it shows up as a bubble in their side panel:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote <keyId>
找到了，第一条是 2019 年的版本，要我点开吗？
EOF
```

Normal replies are final by default (`final:true`). Once the extension receives one,
it ends browser control, removes the Working/task card, cancels queued commands,
detaches the debugger and ungroups the task tabs. Open pages are retained, including
the video the owner asked you to play. No separate `finish` call is required.
Do not send the final reply until the tool sequence has ended.

Keep replies short. For an intermediate update before more commands, explicitly use
the progress adapter instead of the normal C4 final-reply path:

```bash
node ~/zylos/.claude/skills/browser-remote/scripts/send.js --progress <keyId> '正在搜索，找到后会打开播放。'
```

This sends `final:false` and keeps the task active while the panel waits for the final
answer. Use it also when `pause` needs the owner to log in or type a code before you
continue in the same task. Final answers still go through `c4-send.js` as above.

Optionally call `finalize keep=[...]` with actual tab IDs before the final answer to
close disposable tabs and retain only selected results; `finalize` alone closes all
task-owned tabs. `pause` and `finish` detach temporarily without ending the chat turn.
After a final reply, a new browser task starts in new tabs.

## Driving the browser

```bash
b() { node ~/zylos/.claude/skills/browser-remote/scripts/browser.js "$@"; }
b status
b info                                      # check capabilities; new commands need browser-actions-v2
b open url=https://www.bilibili.com/
b wait condition=loaded
b snapshot interactive=true                 # refs include their snapshot prefix, e.g. @a1b2c3d4-e7
b find 'selector=input[type="search"]'       # CSS lookup, also traverses open Shadow DOM
# Use the exact ref returned by snapshot/find. Never invent or shorten it.
b fill 'ref=@a1b2c3d4-e7' text="蜘蛛侠"         # illustrative ref: replace with the real result
b keypress key=Enter
b screenshot                                # read result.path using your image tool
b finish
b finalize 'keep=[123]'                      # replace with actual task tab IDs to retain
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
| `snapshot` | `interactive?` | AX tree across allowed frames, with refs and control states; refs go stale on navigation |
| `observe` | `interactive?` | snapshot + screenshot + viewport |
| `screenshot` | – | PNG; CLI writes it to `~/zylos/components/browser-remote/observations/` and returns `path` |
| `click` / `double-click` / `right-click` | `ref` OR `x,y`; `modifiers?` | native pointer events; coordinates are top viewport CSS pixels |
| `hover` | `ref` OR `x,y` | move without clicking |
| `drag` | `from:{ref}` or `{x,y}`, `to:{ref}` or `{x,y}`, `steps?`, `modifiers?` | pointer drag and HTML drag/drop |
| `fill` | `ref`, `text` | select-all then insert |
| `type` | `ref`, `text` | insert at caret |
| `scroll` | `direction`, `pixels?`, `ref?` OR `x,y?` | a specific scrolling container, a wheel position, or viewport center; default 500 |
| `keypress` | `key`, `modifiers?`, `ref?` | printable character or Enter/Tab/Escape/Backspace/Delete/Arrow*/Home/End/PageUp/PageDown/Space; modifiers: Control, Meta, Shift, Alt |
| `select` | `ref`, `values:[string]` | choose native select options by value; custom widgets use click/keypress |
| `check` | `ref`, `checked:boolean` | set checkbox/radio/switch state; does not toggle if already correct |
| `inspect` | `ref` | live value, checked/disabled/expanded/visible/clickable/focus/options/scroll state; secrets redacted |
| `find` | `selector`, `frameId?` | CSS lookup through open shadow roots; returns matches with usable refs and state |
| `frames` | – | discover IDs and URLs of permitted frames |
| `back` / `forward` / `reload` | – | initiate navigation; follow with wait for the target URL/loaded state |
| `dialog` | `action?:get/accept/dismiss`, `promptText?` | inspect or handle alert/confirm/prompt/beforeunload |
| `wait` | `condition`, `ref?` OR `selector?`, `frameId?`, `text?`, `url?`, `checked?`, `timeoutMs?` | see conditions below |
| `pause` / `finish` | – | detach debugger, keep tabs; auto-release after 10 min |
| `stop` | – | drop control; tabs stay |
| `finalize` | `keep?` | close tabs the task opened except `keep`, ungroup the rest |

### Browser actions v2 workflow

New actions require `info.capabilities` to include `browser-actions-v2` (extension 0.11.0+).
The relay and CLI remain generic; all operations, frame routing and waiting execute inside the extension.

- Use `find` or `snapshot` to get real refs. `find` can identify scrolling containers and elements that have no useful AX name.
  CSS selectors traverse **open** Shadow DOM. Closed-root elements exposed by Chrome's AX tree can use snapshot refs.
- For frames, call `frames`, then `find selector=... frameId=...` when matches are ambiguous. Ref actions route to their own frame.
- `wait` conditions: `attached`, `detached`, `visible`, `hidden`, `enabled`, `clickable`, `checked`, `text`, `url`, `loaded`, `new-tab`.
  Element conditions require ref or selector. `text` requires text; `url` requires the exact full target URL and also waits for page load.
  Prefer selectors across navigation, because old refs must never be re-bound to different documents.
- Waits default to 10 seconds and allow up to 60 seconds, bounded by the outer request deadline.
  For example `b --timeout 65000 wait condition=visible 'selector=#results' timeoutMs=60000`.
- After a link opens a new page: `b wait condition=new-tab`, then `b switch-tab tabId=<returned ID>` and `b wait condition=loaded`.
  Only pages Chrome identifies as opened by a task tab join the task. An unrelated personal tab never does.
  Logical switching does not select the user's foreground tab.
- `DIALOG_OPEN` means a command may already have opened the dialog. Call `b dialog`, then accept/dismiss as the task requires;
  do **not** click the triggering button again. Handle a prompt with `b dialog action=accept promptText="..."`.
- Use `inspect` or a wait condition to verify the business result after input/click. A dispatched click alone does not prove the website saved successfully.
- Modifiers are an array, for example `b keypress key=a 'modifiers=["Meta"]'` (macOS) or `["Control"]` (Windows/Linux).
  Browser chrome/address-bar and OS shortcuts are outside the page-control API.
- Coordinates are **CSS pixels in the top viewport**. Account for screenshot devicePixelRatio; get a fresh observation after resizing or navigation.
- Actions are serialized inside the plugin. Stop/pause/finish interrupt a wait and invalidate previously queued work.
  A requestId coalesces identical in-flight calls and replays cached successful mutations within the worker lifetime;
  changing its method/params returns `REQUEST_ID_CONFLICT`. Each CLI invocation generates a fresh requestId, so rerunning a CLI command is a new action.
- Ordinary and axis-scaled iframes are supported. Rotated/perspective iframe geometry may be refused. No uploads, downloads or arbitrary JavaScript tool is exposed.

### Error codes you will meet

| code | meaning / what to do |
|---|---|
| `EXT_OFFLINE` / `RELAY_DOWN` | no browser connected / relay not running. Tell the owner (via Lark etc., not the panel) |
| `AMBIGUOUS_ENDPOINT` | several browsers connected: pass `--endpoint <keyId>` from `status` |
| `BLOCKED_URL` | payment / banking / account-security page. Do NOT retry or work around; ask the owner to do that step |
| `CONTROL_NOT_GRANTED` | no task yet: `open <url>` first |
| `TASK_TAB_UNAVAILABLE` / `STOPPED` | owner closed the tab or hit 停止. Stop, tell them |
| `STALE_ELEMENT` / `PAGE_CHANGED` | page navigated since the snapshot: take a fresh `snapshot` |
| `DIALOG_OPEN` | inspect and handle `dialog`, then observe; do not replay the trigger |
| `WAIT_TIMEOUT` | condition did not become true; inspect current state before deciding the next step |
| `NO_HISTORY_ENTRY` | no previous/next history entry |
| `REQUEST_ID_CONFLICT` | same requestId was used with another command |
| `SENSITIVE_INPUT` | password / OTP field: `pause`, ask the owner to type it, then continue |
| `EXT_TIMEOUT` | the browser did not answer in time; `observe` before retrying |

### Rules

- Only task tabs created by the extension or admitted through a task tab's opener are driven. Never ask the owner to "arm" a personal tab.
- Read screenshots with the image tool; do not describe a page you have not observed.
- Logins, payments, OTPs, account settings: `pause`, ask the owner with `send.js --progress`, wait for their reply.
- After a timeout or interrupted mutation, observe the result before retrying. Re-running the CLI generates a new requestId and can repeat the action.
- When done, send the final answer; the extension ends the task and keeps the open pages. Use `finalize keep=[...]` beforehand only if some temporary tabs should close.

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
