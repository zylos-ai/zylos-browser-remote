# Side-panel chat + task sessions — implementation contract

Owner request (bobo, 2026-09-11, Lark group "bobo群"). This file is the single
source of truth for the wire protocol so the extension, the relay and the C4
channel can be built independently without drifting.

## What changes, in the owner's words

1. Click the extension icon → the whole UI opens as a **side panel** (not an options page).
2. The owner **chats inside the side panel**; the agent's replies land there too.
3. The agent drives the website while that conversation is happening.
4. Tab targeting: if a tab is **already on the target site, drive it**; otherwise
   **open a new tab**. No arming, no per-tab authorization.
5. New tabs are put in a **native Chrome tab group** with three states:
   working = green, waiting-for-owner = yellow, stopped = grey.
6. When a task ends the **CDP attachment is dropped** (the debugging banner
   disappears). The relay socket stays connected, but nothing is driven until
   the owner speaks again in the panel.

### Decisions made on the owner's behalf (he delegated these)

- **Finished tabs are never closed and never auto-ungrouped.** They go grey and
  stay. The panel offers a "清理已完成" button that ungroups grey groups only.
  Closing someone's tabs is not ours to do.
- **Chat rides the existing C4 bridge**, so the panel talks to the same agent
  session as Lark — same memory, not a second model.

### Security note (stated to the owner, accepted by him)

Removing the arm gate widens what the extension will drive: previously exactly
one hand-picked tab, now any tab matching the target plus tabs it opens itself.
**The guard and the method allowlist are unchanged and still enforced** —
payment and account-settings pages are still refused, password fields still
cannot be typed into, `Runtime.*` is still banned. The extension remains its own
trust domain and re-screens everything the relay already screened.

## Component map

```
side panel  ──chrome.runtime──►  background SW  ──WS(:3802)──►  relay
                                                                  │
                                                    c4-receive.js │ (spawn)
                                                                  ▼
                                                              C4 queue ──► agent session
                                                                  ▲
   side panel ◄──runtime──  background SW  ◄──WS──  relay  ◄──────┘
                                              POST /chat (:3803, loopback)
                                                        ▲
                                          skills/browser/scripts/send.js
                                                        ▲
                                              c4-send.js browser <endpoint>
```

## Wire protocol

### A. Extension → relay (existing ext socket, new frame types)

```jsonc
// owner typed something in the side panel
{ "type": "chat", "sessionId": "<uuid>", "text": "打开B站搜蜘蛛侠", "ts": 1757600000000 }
```

The relay MUST NOT interpret the text. It spawns:

```
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
  --channel browser --endpoint "<sessionId>" --priority 2 --content "<text>"
```

`sessionId` is minted by the extension once per install (persisted in
`chrome.storage.local.sessionId`) and is the C4 endpoint id — it is what the
agent replies to.

### B. Relay → extension (new frame type)

```jsonc
// agent's reply, to be rendered as a chat bubble
{ "type": "chat", "role": "assistant", "text": "好，开了", "ts": 1757600001000 }
// optional transient status line (not persisted in the transcript)
{ "type": "chat-status", "state": "working" | "waiting" | "stopped" | "idle" }
```

### C. Agent → relay (loopback HTTP, new endpoint on the agent lane :3803)

```
POST /chat
Content-Type: application/json
{ "text": "好，开了", "sessionId": "<optional; default = the connected panel>" }

200 {"ok":true,"delivered":true}
503 {"ok":false,"error":"extension not connected"}
```

Loopback-only, same as the rest of the agent lane. No token: :3803 is never
routed by Caddy. (Do not add this to :3802 — that port is public.)

### D. New `_br.*` session methods (agent → extension, over the normal req path)

These must be added to **both** `relay/chokepoint.js` and `extension/policy.js`
— the test `tools/test-extension.js` asserts extension ⊆ relay.

| Method | Params | Behaviour |
|---|---|---|
| `_br.openTarget` | `{url}` | Resolve a tab for `url`: an existing tab whose **origin** matches wins (active tab preferred), else create one. Set state `working` and attach the debugger. Returns `{tabId, url, title, reused: bool, groupId}`. Refuses via the existing guard/`tabAttachAllowed` before touching anything. |
| `_br.setState` | `{state}` | `working`\|`waiting`\|`stopped`. Recolours the group (green/yellow/grey) and retitles it. `stopped` also detaches CDP. |
| `_br.endTask` | `{}` | Detach CDP, set the group grey/已停止, clear the active task tab. Tabs and groups are left on screen. |
| `_br.clearFinished` | `{}` | Ungroup grey ("已停止") Zylos groups. **Never closes tabs.** |

Tab-group colours are Chrome's named colours: `green`, `yellow`, `grey`.

**Only tabs we created are grouped** (`extension/session.js`). A *reused* tab is
driven where it sits: grouping it would move it in the owner's tab strip, and
tab groups are his UI, not ours. The consequence is deliberate but worth stating
plainly — **on a reused tab there is no colour signal**, and `_br.setState` has
no group to recolour (it returns `groupId: null`). What still marks a reused tab
as driven is Chrome's own "being debugged" banner, which appears on attach and
disappears when the task ends.

## Ownership of files (do not cross these lines)

| Area | Files | Owner |
|---|---|---|
| Side panel UI | `extension/sidepanel.html`, `sidepanel.css`, `sidepanel.js` | agent A |
| Relay | `relay/ext-lane.js`, `relay/agent-lane.js`, `relay/server.js`, `relay/chokepoint.js` | agent B |
| C4 channel | `~/zylos/.claude/skills/browser/**` | agent C |
| SW, sessions, manifest, policy | `extension/background.js`, `extension/session.js`, `extension/manifest.json`, `extension/policy.js` | main session |

## Invariants that must survive this change

- `extension/policy.js` allowlist ⊆ `relay/chokepoint.js` allowlist (`tools/test-extension.js`).
- The guard still screens the tab's **live** URL at execution time, not the URL
  the relay last saw (`extension/guard.js`, re-run in `background.execute`).
- `:3802` stays the only public surface; `:3803` stays loopback-only.
- Existing suites must stay green: `tools/smoke.js` (28), `tools/test-chokepoint.js` (46),
  `tools/test-guard.js` (42), `tools/test-extension.js`, `tools/test-handshake-race.js` (5).
