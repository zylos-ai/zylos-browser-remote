# Zylos Browser Extension

*English below · 中文见下半部分*

Chrome MV3 extension half of the **Zylos browser-remote** system. Clicking its
toolbar icon opens a **side panel**: you talk to the agent in that panel, and the
agent drives the site you asked about — over a narrow, auditable command surface,
instead of handing out raw CDP.

> The relay (server half) lives in `zylos-ai/zylos-browser-remote`. This repo is the
> extension only; **it is not useful on its own** — without a running relay there is
> nothing on the other end of the socket.

> **Upgrading from 0.1.x? You must fully reload the extension.** `manifest.json`
> changed (version `0.2.0`, new `side_panel` entry, new `tabGroups` and `sidePanel`
> permissions). Go to `chrome://extensions` and click the **reload** (↻) button on
> this extension's card — reloading a page, or restarting the panel, is not enough.
> Chrome will ask you to accept the new permissions. Details in
> [Upgrading from 0.1.x](#upgrading-from-01x).

---

## Before you install: what this is, and what it is not

```
  you ──(Lark / OpenMax / this side panel)──► the agent
                                                │  sends structured actions
                                                ▼
   your Chrome ◄──[this extension]──► relay (wss://<agent-domain>/browser-remote/ext)
```

- **The side panel is a chat box.** You type to the agent there, and its replies
  appear there. It is the same agent session you talk to on Lark — the panel's text
  is handed to the relay, which forwards it into the same C4 channel. Same memory,
  not a second model. (The panel also mints a stable `sessionId` per install, stored
  in `chrome.storage.local`; that is the address the agent replies to.)
- **The browser dials out.** The agent's container has no route to your machine; your
  Chrome opens the connection. Nothing can dial in to you.
- **There is no arming step any more.** When the agent needs a page, it calls
  `_br.openTarget({url})`: if a tab is already open on that **origin** it drives that
  tab, otherwise it opens a new one. See
  [How the agent picks a tab](#how-the-agent-picks-a-tab).
- **Only one tab is drivable at a time** — the current task's tab. Any command
  aimed at a different tab is refused by the extension.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: permissions, the `side_panel` entry, `options_page`, version |
| `background.js` | Service worker: the relay socket, chat in/out, command execution, debugger attach/detach, reconnect |
| `session.js` | Task sessions: which tab a task drives, and the tab group that shows its state |
| `sidepanel.html` | Side-panel markup: header (task dot + connection pill), transcript, composer, footer (清理已完成 / 设置) |
| `sidepanel.css` | Side-panel styling; sized for a ~320px panel, follows your OS light/dark theme |
| `sidepanel.js` | Side-panel logic: renders the transcript, sends your messages to the service worker, owns the settings form. It opens no socket of its own and holds no secrets beyond what it writes to storage |
| `actions.js` | The `_br.*` command implementations. Everything injected into a page is fixed source shipped here |
| `policy.js` | Which methods are permitted, and which URL schemes are never attached to |
| `guard.js` | Refuses sensitive surfaces (payment / account-security pages, password fields) |
| `options.html` / `options.js` | **Legacy settings page** — see [The options page](#the-options-page) |
| `package.json` | Not read by Chrome. It exists only so Node loads these files as ESM in the repo's tests |

---

## Install and use

### 0. Get two things from the agent

You need a **relay URL** and a **token**. Ask the agent for both.

- Relay URL looks like `wss://<agent-domain>/browser-remote/ext` — the path is always
  `/browser-remote/ext`. The domain is assigned by the platform and **can change**, so
  it is deliberately not hardcoded anywhere in this repo. Over a tailnet instead:
  `ws://<tailnet-host>:3802/ext`.
- The token is a 64-character hex string minted on the relay. It is a **shared secret** —
  expect it over a private channel, never in a group chat.

If the relay is not running yet, the extension will sit in a reconnect loop and no
amount of configuring will help. Confirm with the agent that the relay is up first.

### 1. Load the extension (no packaging needed)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this directory

You do **not** need to build, bundle, or package this into a `.crx`. Unpacked is the
intended install path.

> **Use a dedicated Chrome profile, not your daily one. This matters more in 0.2.0
> than it did before.** In 0.1.x exactly one tab you had hand-picked could be driven.
> Now the agent resolves the tab itself: **any** tab already open on the origin it was
> asked about is fair game, and it can open new tabs of its own. That is a genuinely
> wider blast radius, and no wording softens it — a separate profile, logged in to
> only what this work needs, is what keeps it contained.
>
> What did *not* widen, and is enforced on every single command:
> `guard.js` still refuses payment, checkout, banking and account-security URLs and
> still refuses to type into password fields; the method allowlist in `policy.js` is
> unchanged; `Runtime.*` is still banned, so no code from the socket is ever executed;
> the extension is still its own trust domain and re-screens what the relay already
> screened — it may be **stricter** than the relay, never looser.

### 2. Open the panel and configure it

Click the extension's **toolbar icon** — the side panel opens. (If the icon is hidden
behind Chrome's puzzle-piece menu, pin it. On Chrome versions too old for
`openPanelOnActionClick`, open the panel from the puzzle-piece menu instead.)

In the panel footer, click **设置**, then:

1. Paste the **中继地址** (relay URL) — it must start with `wss://`, or `ws://` on a tailnet
2. Paste the **令牌** (token)
3. Click **保存并重连**
4. Watch the pill at the top right — you want **已连接**

The same section holds the **允许远程控制** checkbox. That is the kill switch: unchecking
it closes the relay connection, detaches the debugger, and refuses every command. It is
re-checked on each command, so flipping it mid-task takes effect immediately. Only an
explicit "off" disables; a fresh install with the box untouched is enabled.

The status box at the bottom of 设置 shows the raw connection state, the last close
code, and whether the URL and token are set.

Everything you type here is stored in **this Chrome profile's** local extension storage
and nowhere else.

### 3. Talk to it

Type in the box at the bottom of the panel. **Enter** sends, **Shift+Enter** adds a
newline, and confirming a Chinese IME candidate with Enter does not send.

Your message goes to the service worker, out over the relay socket, and into the agent's
C4 queue — the same session as Lark. Replies come back as chat bubbles. The last 200
messages are kept in `chrome.storage.local`, so replies that arrive while the panel is
closed are still there when you open it.

The composer is **disabled unless the connection state is 已连接**. When it is locked, a
line above it says why (連接中 / 已断开 / 远程控制已关闭 / 还没配置…).

### How the agent picks a tab

When the agent needs a page it calls `_br.openTarget({url})`. In order:

1. The URL is screened by `guard.js` and by the scheme blocklist **before anything is
   opened** — a blocked URL must not even become a tab.
2. Existing tabs are searched for one whose **origin** matches (scheme + host;
   `www.` is ignored, but `http://` never matches `https://`). The tab you are currently
   looking at wins; otherwise the most recently used match.
3. **A matching tab is reused where it sits.** It is not moved and not grouped — it is
   your tab and your window layout.
4. **If nothing matches, a new tab is created**, put in a native Chrome **tab group**,
   and the group is coloured green and titled `Zylos · 工作中`.
5. The debugger attaches to that tab. Chrome shows its "being debugged" banner; that
   banner is the honest signal that something is attached.

From then on, **only that tab is drivable**. A command naming any other tab is refused
with `tab N is not the task tab`. Between tasks there is no task tab at all — that is a
normal state, not a fault, and the agent opens one when you next ask for something.

### Tab groups and their colours

Only tabs the agent **opened itself** are grouped. The group's colour is the task state:

| Colour | Group title | Meaning |
|---|---|---|
| green | `Zylos · 工作中` | working |
| yellow | `Zylos · 等待你` | waiting for you |
| grey | `Zylos · 已停止` | stopped |

The same three states drive the coloured dot next to "Zylos 浏览器助手" at the top of the
panel (plus grey for idle).

Because a **reused** tab is never grouped, a task that ran in one of your existing tabs
has no coloured group — the panel's dot is the only state indicator in that case.

### When a task ends

- **CDP detaches.** Chrome's "being debugged" banner disappears. Nothing is driven until
  you say something in the panel again.
- **The relay socket stays connected.** That is intentional: the connection is how the
  agent's next reply reaches you.
- **The tab is never closed, and the group is never auto-ungrouped.** It turns grey and
  stays exactly where it is. Deciding when your tabs go away is not the agent's call.
- Closing the task tab yourself is a perfectly good way to say stop — the extension
  treats it as the end of the task instead of erroring on the next command.

**清理已完成** (panel footer) ungroups the grey `Zylos · 已停止` groups **and nothing else**.
It does not close tabs, does not touch a group you made yourself, and does not touch a
group that is still green or yellow.

### The options page

`chrome://extensions` → *Details* → *Extension options* still opens `options.html`, but
since 0.2.0 it is **legacy**. It has no unique function: relay URL, token and the kill
switch are all in the panel's 设置 section now, and the "Arm a tab" table is gone.

Keep it for exactly two situations:

- The side panel will not open (very old Chrome, or a panel-related failure) and you
  still need to fix the relay URL, the token, or the kill switch.
- You want the raw English status readout, which shows one field the panel does not:
  `lastDetach` — why the debugger was last detached.

Both pages write the same `chrome.storage.local` keys, which `background.js` watches, so
either one takes effect without a reload.

---

## Upgrading from 0.1.x

`manifest.json` changed in ways Chrome only picks up on a full extension reload:

- version `0.1.0` → `0.2.0`
- new permissions: `tabGroups`, `sidePanel`
- new `side_panel` key pointing at `sidepanel.html`

So:

1. `git pull` (or otherwise update this directory)
2. Open `chrome://extensions`
3. Click **reload** (↻) on the *Zylos Browser Remote* card — not F5 on a page, not
   closing and reopening a window
4. Accept the new permission prompt if Chrome shows one
5. Click the toolbar icon; the side panel should open

Your relay URL, token and kill-switch setting survive the reload — they live in
`chrome.storage.local`. The chat transcript survives too.

---

## What the agent can and cannot do

**Permitted structured actions** (the agent supplies *data* — a selector, a string, a
URL — never code, never raw coordinates):

Page actions: `_br.snapshot` · `_br.click` · `_br.fill` · `_br.press` · `_br.screenshot` ·
`_br.navigate` · `_br.waitFor`

Inspection: `_br.info` · `_br.listTabs`

Session control: `_br.openTarget` · `_br.setState` · `_br.endTask` · `_br.clearFinished`

| Session method | What it does |
|---|---|
| `_br.openTarget {url}` | Screen the URL, reuse a same-origin tab or open a new one (grouping only the new one), make it the task tab, attach the debugger |
| `_br.setState {state}` | `working` / `waiting` / `stopped` — recolours and retitles the group; `stopped` also detaches CDP |
| `_br.endTask {}` | Detach CDP, grey the group, forget the task tab. Tabs and groups stay on screen |
| `_br.clearFinished {}` | Ungroup grey `Zylos · 已停止` groups. **Never closes a tab** |

plus a small set of page-level CDP methods: `Page.enable`, `Page.disable`,
`Page.navigate`, `Page.reload`, `Page.getNavigationHistory`,
`Page.navigateToHistoryEntry`, `Page.captureScreenshot`, `Page.bringToFront`,
`Page.getFrameTree`.

**Refused by construction** — not by policy you can toggle, but by an allowlist compiled
into the extension:

| Refused | Why |
|---|---|
| `Runtime.*`, `Debugger.*` | arbitrary code execution in a logged-in browser |
| `Input.*` | raw input injection — use the structured `_br.*` actions |
| `Network.setCookie` / `getCookies` / `getAllCookies` / `deleteCookies` / `setExtraHTTPHeaders` | cookie / credential surface |
| `Storage.*` | origin storage and credential surface |
| `Fetch.*` | request interception |
| `Page.addScriptToEvaluateOnNewDocument` | persistent script injection |
| `Page.setDownloadBehavior` | writes to your filesystem |
| `Browser.*`, `Target.*` | browser-wide control / target creation |

(`_br.click`, `_br.fill` and `_br.press` do use `Input.*` internally — but from
coordinates and key descriptors this extension computed itself, from a selector it
resolved and screened. What is banned is the *agent* supplying them.)

**Also refused, regardless of what is asked** — `guard.js`:

- typing into, or sending keys to, a password field;
- navigating to payment / checkout / billing / banking URLs, or to account-security
  paths (password change, 2FA, API keys, sessions, delete-account, and the like),
  including percent-encoded variants;
- clicking a link whose `href` points at such a URL, pressing Enter in a form whose
  action does, or *landing* on one after a redirect — each of those is screened after
  the fact as well as before;
- driving a tab whose **live** URL is blocklisted. The guard re-reads the tab's actual
  current URL at execution time, not the URL the relay last saw.

The extension will not attach to `chrome://`, `chrome-extension://`, `devtools://`,
`edge://`, `about:` (other than `about:blank`), or the Chrome Web Store at all.

The allowlist here is a **deliberate second copy** of the relay's. The relay runs in the
agent's container; this extension runs inside your logged-in browser. Those are different
trust domains, so the side holding your real sessions does not execute whatever arrives
over the socket just because the socket was authenticated. Drift is allowed in exactly
one direction: this extension may be **stricter** than the relay, never looser.

---

## Troubleshooting

Read the pill at the top of the panel first, then the status box inside 设置.

| Symptom | Meaning |
|---|---|
| Toolbar icon does nothing / old options page opens instead of the panel | The extension was not fully reloaded after the 0.2.0 update — see [Upgrading from 0.1.x](#upgrading-from-01x) |
| Pill 未配置 (`state: unconfigured`) | Relay URL or token is not saved yet |
| Pill 已停用 (`state: disabled`) | The 允许远程控制 kill switch is off. Nothing is connected by design |
| Pill 连接中 looping, or 已断开 returning | Relay is not running, or URL/token is wrong |
| `closeCode: 1008` | Token rejected by the relay |
| `closeCode: 4001` | The relay handed the lane to a newer connection of ours. Not an error; it backs off and settles |
| Composer greyed out | The state is not 已连接. The line above the box says which state, and why |
| Connected, but the agent reports `no active task tab: call _br.openTarget({url}) first` | No task is running — normal between tasks. Just say what you want; it will open or adopt a tab |
| `refused by extension: tab N is not the task tab` | A command named a tab that is not the current task's. Only the task tab is drivable |
| `refused by extension: cannot attach to chrome://…` | The target is not a page this extension may attach to at all |
| `refused: … is on the blocklist` / `refused: _br.fill will not type into a password field` | The guard. Deliberate, and not toggleable — do that step yourself |
| The task's tab has no coloured group | It is a tab you already had open; reused tabs are never grouped. The dot in the panel header is the state indicator |
| Group is still green after the agent finished | The task was never formally ended (e.g. the agent stopped mid-run). The colour is cosmetic — check the debugging banner to see whether anything is still attached |
| "being debugged" banner will not go away | A task is still open. Tell the agent to stop, close the tab, or turn off 允许远程控制 |
| 清理已完成 seems to do nothing | It only ungroups groups titled exactly `Zylos · 已停止`, and never closes tabs. Nothing grey, nothing to do |
| Connection drops every ~16s | Platform-edge idle timeout. The extension reconnects on its own (exponential backoff, with a `chrome.alarms` backstop), so it recovers — but a long single action can be cut mid-flight |
| `refused by extension: …` | The action hit the allowlist or the guard. The message says which |

The service worker can be torn down by Chrome at any time; `chrome.alarms` wakes it back
up and reconnects. A brief 已断开 is normal, a permanent one is not. If the panel says the
background was asleep and your message did not go out, send it again.

---
---

# Zylos 浏览器扩展（中文）

**Zylos browser-remote** 系统的 Chrome MV3 扩展部分。点工具栏图标会打开一个**侧边栏**：
你在侧边栏里跟 agent 说话，agent 就去操作你提到的网站 —— 走一条**收窄的、可审计的**
命令通道，而不是把原始 CDP 权限直接交出去。

> 服务端（relay）在 `zylos-ai/zylos-browser-remote`。本仓库只有扩展这一半，**单独装是跑不起来的** ——
> 没有 relay 在跑，socket 另一端就是空的。

> **从 0.1.x 升上来的话，必须把扩展整个重新加载一次。** `manifest.json` 变了（版本
> `0.2.0`、新增 `side_panel` 配置、新增 `tabGroups` 和 `sidePanel` 权限）。请到
> `chrome://extensions`，在本扩展的卡片上点**重新加载**（↻）—— 刷新网页、或者把侧边栏
> 关掉再开，都不算数。Chrome 可能会让你确认新权限。详见
> [从 0.1.x 升级](#从-01x-升级)。

---

## 装之前先搞清楚：它是什么，不是什么

```
  你 ──(飞书 / OpenMax / 这个侧边栏)──► agent
                                         │  下发结构化动作
                                         ▼
   你的 Chrome ◄──[本扩展]──► relay (wss://<agent-domain>/browser-remote/ext)
```

- **侧边栏就是一个对话框。** 你在里面打字跟 agent 说话，它的回复也出现在里面。
  这跟你在飞书里聊的是**同一个 agent 会话** —— 侧边栏的文字会交给 relay，再转进同一条
  C4 通道。**同一份记忆，不是另开一个模型。**（扩展在每次安装时会生成一个固定的
  `sessionId` 存在 `chrome.storage.local` 里，agent 就是回复到这个地址。）
- **是浏览器主动往外拨号。** agent 所在的容器没有任何通往你机器的路由，是你的 Chrome
  主动建立连接。外部无法反向拨进你的机器。
- **已经没有「授权（arm）标签页」这一步了。** agent 需要页面时会调用
  `_br.openTarget({url})`：如果已经有标签页停在那个**源（origin）**上，就直接用它；
  否则新开一个。见[agent 怎么选标签页](#agent-怎么选标签页)。
- **同一时刻只有一个标签页可被驱动** —— 当前任务的那个。指向别的标签页的命令会被扩展拒绝。

## 文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单：权限、`side_panel` 配置、`options_page`、版本号 |
| `background.js` | Service worker：relay 连接、聊天收发、命令执行、debugger 的附加/分离、断线重连 |
| `session.js` | 任务会话：一个任务在哪个标签页上跑，以及那个用来显示状态的标签分组 |
| `sidepanel.html` | 侧边栏结构：顶部（状态圆点 + 连接状态）、对话记录、输入框、底部（清理已完成 / 设置） |
| `sidepanel.css` | 侧边栏样式；按最窄约 320px 设计，跟随系统浅色/深色主题 |
| `sidepanel.js` | 侧边栏逻辑：渲染对话、把你的消息交给 service worker、管设置表单。它自己不开 socket |
| `actions.js` | `_br.*` 命令的具体实现。所有注入进页面的函数都是本扩展里写死的源码 |
| `policy.js` | 允许哪些方法，以及哪些 URL scheme 永远不附加 |
| `guard.js` | 拦截敏感界面（支付 / 账户安全类页面、密码输入框） |
| `options.html` / `options.js` | **遗留的设置页** —— 见[选项页还有什么用](#选项页还有什么用) |
| `package.json` | Chrome 根本不读它。它只是为了让 Node 在跑仓库测试时把这些文件按 ESM 加载 |

---

## 安装与使用

### 0. 先向 agent 要两样东西

你需要一个 **relay 地址**和一个 **Key（token）**，两个都向 agent 要。

- 地址形如 `wss://<agent-domain>/browser-remote/ext` —— 路径固定是 `/browser-remote/ext`。
  域名由平台分配、**是会变的**，所以本仓库里刻意不写死。走 tailnet 的话则是
  `ws://<tailnet-host>:3802/ext`。
- Key 是 relay 生成的 64 位十六进制字符串，属于**共享密钥** —— 它应该通过私聊给你，
  **不应该出现在群聊里**。

如果 relay 还没启动，扩展只会一直重连，这时候你怎么配都没用。**先跟 agent 确认 relay 在跑。**

### 1. 加载扩展（不需要打包）

1. 打开 `chrome://extensions`
2. 右上角打开**开发者模式**
3. 点**加载已解压的扩展程序**，选中本目录

**不需要**构建、打包，也不需要做成 `.crx`。以解压目录方式加载就是设计好的安装路径。

> **请用一个专用的 Chrome 配置文件（profile），不要用你日常那个。到了 0.2.0，这条建议
> 比以前更重要，不是更不重要。** 0.1.x 时能被驱动的只有你亲手挑出来的那一个标签页；
> 现在是 agent 自己找标签页：**任何**已经停在目标源上的标签页都可能被直接拿来用，它还能
> 自己开新标签页。影响面确实变大了，这里不做任何粉饰 —— 单开一个 profile、只登录这件事
> 真正需要的账号，才是把影响面关住的办法。
>
> 没有变松、且每条命令都仍然强制执行的部分：
> `guard.js` 照样拒绝支付、结账、银行和账户安全类 URL，照样拒绝往密码框里输入；
> `policy.js` 的方法白名单一条没放宽；`Runtime.*` 依然禁用，所以从 socket 过来的东西
> 永远不会被当成代码执行；本扩展仍然是独立的信任域，会把 relay 已经筛过的再筛一遍 ——
> 只允许**比 relay 更严**，绝不允许更松。

### 2. 打开侧边栏并配置

点扩展的**工具栏图标**，侧边栏就会打开。（如果图标被收在 Chrome 的拼图菜单里，先把它固定
出来。Chrome 版本过老、不支持 `openPanelOnActionClick` 时，从拼图菜单里点开也一样。）

在侧边栏底部点**设置**，然后：

1. 粘贴**中继地址**（relay URL）—— 必须以 `wss://` 开头，走 tailnet 可以用 `ws://`
2. 粘贴**令牌**（token）
3. 点**保存并重连**
4. 看右上角那个小标签 —— 要看到**已连接**

同一块里还有**允许远程控制**复选框，这就是总开关（kill switch）：取消勾选会立刻断开 relay
连接、分离 debugger，并拒绝一切命令。每条命令执行前都会再查一次，所以任务进行中关掉它也是
立即生效的。只有明确关掉才算关；刚装好没动过这个框，默认就是开启。

设置里最下面的状态框会显示原始连接状态、最后一次的关闭码，以及地址和令牌是否已填。

你在这里填的东西只存在**这个 Chrome 配置文件**的本地扩展存储里，不会去别的地方。

### 3. 开始对话

在侧边栏最下面的框里打字。**Enter 发送**，**Shift+Enter 换行**；用中文输入法按 Enter
选字不会误发。

你的消息经 service worker 走 relay 出去，进入 agent 的 C4 队列 —— 跟飞书是同一个会话。
回复以气泡形式回到这里。最近 200 条消息存在 `chrome.storage.local`，所以你没开侧边栏时
到达的回复，下次打开还在。

**只有连接状态是「已连接」时输入框才可用。** 被锁住时，框上方那行字会告诉你原因
（连接中 / 已断开 / 远程控制已关闭 / 还没配置…）。

### agent 怎么选标签页

agent 需要页面时会调用 `_br.openTarget({url})`，顺序是：

1. 这个 URL 先过 `guard.js` 和 scheme 黑名单，**在开任何东西之前**就筛一遍 —— 被拦的 URL
   连变成一个标签页都不允许。
2. 在已开的标签页里找**源（origin）**相同的（协议 + 域名；`www.` 忽略，但 `http://` 永远
   不等于 `https://`）。你当前正在看的那个优先；否则取最近用过的那个。
3. **命中的标签页就地使用。** 不移动它，也不把它编组 —— 那是你的标签页、你的窗口布局。
4. **一个都没命中，就新开一个标签页**，放进一个原生 **Chrome 标签分组**，把分组染成绿色、
   标题写成 `Zylos · 工作中`。
5. debugger 附加到这个标签页。Chrome 会显示「正在被调试」横幅 —— 这条横幅就是「确实有东西
   附着在上面」的诚实信号。

之后**只有这个标签页可被驱动**。指向别的标签页的命令会被拒绝，报
`tab N is not the task tab`。任务之间是**没有**任务标签页的 —— 这是正常状态不是故障，
你下次提要求时 agent 会重新开一个。

### 标签分组和它的颜色

**只有 agent 自己新开的**标签页才会被编组。分组颜色就是任务状态：

| 颜色 | 分组标题 | 含义 |
|---|---|---|
| 绿色 | `Zylos · 工作中` | 正在干活 |
| 黄色 | `Zylos · 等待你` | 在等你回话 |
| 灰色 | `Zylos · 已停止` | 已停止 |

侧边栏顶部「Zylos 浏览器助手」旁边那个圆点是同样的三种状态（外加空闲时的灰色）。

因为**复用**的标签页不会被编组，所以如果这次任务跑在你原本就开着的标签页上，是没有彩色
分组的 —— 那种情况下侧边栏的圆点是唯一的状态指示。

### 任务结束时会发生什么

- **CDP 会分离。** Chrome 的「正在被调试」横幅消失。在你下次在侧边栏里说话之前，不会有
  任何东西被操作。
- **relay 连接保持不断。** 这是有意的：agent 下一条回复要靠这条连接送到你面前。
- **标签页永远不会被关掉，分组也不会被自动解散。** 它变成灰色，就留在原地。
  什么时候关掉你的标签页，不该由 agent 决定。
- 你自己把任务标签页关掉，也是一种完全有效的「停」—— 扩展会把它当作任务结束，而不是在
  下一条命令上报错。

**清理已完成**（侧边栏底部）只做一件事：把灰色的 `Zylos · 已停止` 分组解散。
它**不关闭标签页**，不碰你自己建的分组，也不碰还是绿色或黄色的分组。

### 选项页还有什么用

`chrome://extensions` → *详细信息* → *扩展程序选项* 仍然能打开 `options.html`，但从
0.2.0 起它是**遗留页面**：没有任何独占功能。中继地址、令牌、总开关现在都在侧边栏的
「设置」里，「Arm a tab」表格已经删掉了。

只在这两种情况下还用得上它：

- 侧边栏打不开（Chrome 太老，或者侧边栏出了问题），而你还需要改中继地址、令牌或总开关。
- 你想看那个英文的原始状态输出，里面有一个侧边栏没显示的字段：`lastDetach` ——
  上一次 debugger 是因为什么分离的。

两个页面写的是同一批 `chrome.storage.local` 键，`background.js` 都在监听，所以改哪边都
无需重载即可生效。

---

## 从 0.1.x 升级

`manifest.json` 的这些改动，Chrome 只有在整个扩展重新加载时才会认：

- 版本 `0.1.0` → `0.2.0`
- 新增权限：`tabGroups`、`sidePanel`
- 新增 `side_panel` 配置，指向 `sidepanel.html`

所以：

1. `git pull`（或者用别的方式把本目录更新到最新）
2. 打开 `chrome://extensions`
3. 在 *Zylos Browser Remote* 卡片上点**重新加载**（↻）—— 不是在网页上按 F5，也不是关窗口再开
4. 如果 Chrome 弹出新权限确认，同意它
5. 点工具栏图标，侧边栏应该能打开

中继地址、令牌、总开关都能扛过这次重载 —— 它们存在 `chrome.storage.local` 里。
聊天记录同样保留。

---

## agent 能做什么、不能做什么

**允许的结构化动作**（agent 只能提供**数据** —— 选择器、字符串、URL，
**不能提供代码，也不能给原始坐标**）：

页面动作：`_br.snapshot` · `_br.click` · `_br.fill` · `_br.press` · `_br.screenshot` ·
`_br.navigate` · `_br.waitFor`

信息查询：`_br.info` · `_br.listTabs`

会话控制：`_br.openTarget` · `_br.setState` · `_br.endTask` · `_br.clearFinished`

| 会话方法 | 作用 |
|---|---|
| `_br.openTarget {url}` | 先筛 URL，复用同源标签页或新开一个（只有新开的才编组），把它设为任务标签页，附加 debugger |
| `_br.setState {state}` | `working` / `waiting` / `stopped` —— 改分组的颜色和标题；`stopped` 还会分离 CDP |
| `_br.endTask {}` | 分离 CDP，把分组置灰，忘掉任务标签页。标签页和分组都留在屏幕上 |
| `_br.clearFinished {}` | 解散灰色的 `Zylos · 已停止` 分组。**绝不关闭标签页** |

外加一小撮页面级 CDP 方法：`Page.enable`、`Page.disable`、`Page.navigate`、`Page.reload`、
`Page.getNavigationHistory`、`Page.navigateToHistoryEntry`、`Page.captureScreenshot`、
`Page.bringToFront`、`Page.getFrameTree`。

**从构造上就被拒绝的** —— 不是一个你能开关的策略，而是编译进扩展里的白名单：

| 被拒绝 | 原因 |
|---|---|
| `Runtime.*`、`Debugger.*` | 在已登录的浏览器里等于任意代码执行 |
| `Input.*` | 原始输入注入 —— 请走结构化的 `_br.*` |
| `Network.setCookie` / `getCookies` / `getAllCookies` / `deleteCookies` / `setExtraHTTPHeaders` | cookie / 凭证面 |
| `Storage.*` | 源存储和凭证面 |
| `Fetch.*` | 请求拦截 |
| `Page.addScriptToEvaluateOnNewDocument` | 持久化脚本注入 |
| `Page.setDownloadBehavior` | 会往你的文件系统写东西 |
| `Browser.*`、`Target.*` | 浏览器级控制 / 创建新 target |

（`_br.click`、`_br.fill`、`_br.press` 内部确实用到了 `Input.*` —— 但坐标和按键描述符是
本扩展自己根据它解析并筛查过的选择器算出来的。被禁的是 **agent** 自己提供这些东西。）

**另外，不管你怎么要求都会被拒绝的** —— `guard.js`：

- 往密码框里输入内容、或往密码框发按键；
- 跳转到支付 / 结账 / 账单 / 银行类 URL，或账户安全类路径（改密码、二次验证、API key、
  会话管理、注销账号之类），**包括百分号编码后的变体**；
- 点击 `href` 指向这类 URL 的链接、在 action 指向这类 URL 的表单里按 Enter、
  或者跳转后**落在**这类 URL 上 —— 这几种情况事前事后都会筛；
- 驱动一个**当前实时 URL** 命中黑名单的标签页。guard 在执行的那一刻重新读标签页的真实
  URL，而不是 relay 上次看到的那个。

扩展也完全不会附加到 `chrome://`、`chrome-extension://`、`devtools://`、`edge://`、
`about:`（`about:blank` 除外）和 Chrome 应用商店上。

这里的白名单是 relay 那份的**刻意的第二份拷贝**，不是没去重。relay 跑在 agent 的容器里，
本扩展跑在**你已登录的浏览器**里，这是两个不同的信任域 —— 握着你真实会话的那一侧，
不能仅仅因为「消息是从一个通过鉴权的 socket 过来的」就照单执行。
只允许单向偏移：本扩展可以**比 relay 更严**，绝不能更松。

---

## 排查

先看侧边栏顶部那个连接状态标签，再看「设置」里的状态框。

| 现象 | 含义 |
|---|---|
| 点工具栏图标没反应 / 打开的还是旧的选项页 | 0.2.0 更新后没有把扩展整个重新加载，见[从 0.1.x 升级](#从-01x-升级) |
| 显示**未配置**（`state: unconfigured`） | 中继地址或令牌还没保存 |
| 显示**已停用**（`state: disabled`） | 「允许远程控制」被关掉了。此时本来就不会有连接 |
| 一直**连接中**，或反复**已断开** | relay 没在跑，或者地址/令牌填错了 |
| `closeCode: 1008` | 令牌被 relay 拒绝 |
| `closeCode: 4001` | relay 把通道交给了我们更新的一条连接。不是错误，退避一下就会稳定 |
| 输入框是灰的 | 状态不是「已连接」。框上方那行字会写明是哪种状态、为什么 |
| 明明连上了，agent 却说 `no active task tab: call _br.openTarget({url}) first` | 当前没有任务 —— 任务之间本来就是这样。直接说你要干什么，它会开一个或复用一个标签页 |
| `refused by extension: tab N is not the task tab` | 命令指向了非当前任务的标签页。只有任务标签页可被驱动 |
| `refused by extension: cannot attach to chrome://…` | 目标根本不是本扩展允许附加的页面 |
| `refused: … is on the blocklist` / `refused: _br.fill will not type into a password field` | 撞到 guard 了。这是故意的、也关不掉 —— 这一步请你自己来 |
| 任务用的标签页没有彩色分组 | 那是你原本就开着的标签页；复用的标签页不编组。此时看侧边栏顶部的圆点 |
| agent 都结束了，分组还是绿的 | 任务没有被正式结束（比如 agent 中途停了）。颜色只是显示 —— 想确认是否还附着着，看「正在被调试」横幅 |
| 「正在被调试」横幅一直不消失 | 还有任务开着。让 agent 停下来、或者把那个标签页关掉、或者关掉「允许远程控制」 |
| 点「清理已完成」好像没反应 | 它只解散标题正好是 `Zylos · 已停止` 的分组，且从不关闭标签页。没有灰色分组时就无事可做 |
| 每 ~16 秒断一次 | 平台边缘的空闲超时。扩展会自动重连（指数退避 + `chrome.alarms` 兜底），所以能自愈；但**单个耗时较长的动作可能被拦腰切断**。 |
| `refused by extension: …` | 撞到白名单或 guard 了，消息里会写明是哪一条 |

Service worker 随时可能被 Chrome 回收，`chrome.alarms` 会把它唤醒并重连。
短暂出现「已断开」是正常的，一直是就不正常。如果侧边栏提示后台在休眠、消息没发出去，
再发一次就好。
