# Zylos Browser Extension

*English below · 中文见下半部分*

Chrome MV3 extension half of the **Zylos browser-remote** system: it lets an agent
drive a browser tab you have explicitly *armed*, over a narrow, auditable command
surface — instead of handing out raw CDP.

> The relay (server half) lives in `zylos-ai/zylos-browser-remote`. This repo is the
> extension only; **it is not useful on its own** — without a running relay there is
> nothing on the other end of the socket.

---

## Before you install: what this is, and what it is not

The system has two halves and one chat channel:

```
  you ──(chat: Lark / OpenMax / …)──► the agent
                                        │  sends structured actions
                                        ▼
   your Chrome ◄──[this extension]──► relay (wss://<agent-domain>/browser-remote/ext)
```

- **This extension is the hands, not the mouth.** It has *no chat box*. You do not
  talk to the agent inside the extension — you talk to the agent where you normally
  talk to it, and the extension is what lets it touch your browser.
- **The browser dials out.** The agent's container has no route to your machine; your
  Chrome opens the connection. Nothing can dial in to you.
- **Nothing is driven until you arm a tab**, and exactly one tab is drivable at a time.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: relay connection, armed-tab lifecycle |
| `actions.js` | The `_br.*` command implementations |
| `policy.js` | Which commands are permitted |
| `guard.js` | Refuses sensitive surfaces (password / payment / account-security pages and fields) |
| `options.html` / `options.js` | Relay URL + token configuration UI |

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

> **Use a dedicated Chrome profile, not your daily one.** Any tab you arm here can be
> driven remotely. A separate profile keeps that blast radius small.

### 2. Configure

Open the extension's **Options** page (`chrome://extensions` → *Details* → *Extension
options*), then:

1. Paste the **Relay URL**
2. Paste the **Token**
3. Click **Save & reconnect**
4. Check the status box — you want `state: open`

### 3. Arm a tab

On the same Options page, the **Arm a tab** table lists your open tabs. Click **Arm**
next to the one the agent should drive. The armed row is highlighted.

- Only one tab at a time.
- Click **Disarm** to withdraw control — it takes effect immediately, and the agent's
  next command is refused.
- The **Remote control enabled** checkbox at the top is the kill switch: unchecking it
  closes the relay connection and refuses everything, without you having to find the
  armed tab.

### 4. Actually use it

Go back to your chat with the agent and tell it what to do — *"open bilibili and search
for X"*, *"click the second result"*, *"screenshot what you see"*. The agent issues the
structured actions; this extension executes them against the armed tab.

---

## What the agent can and cannot do

**Permitted structured actions** (the agent supplies *data* — a selector, a string, a
URL — never code, never raw coordinates):

`_br.info` · `_br.listTabs` · `_br.snapshot` · `_br.click` · `_br.fill` · `_br.press` ·
`_br.screenshot` · `_br.navigate` · `_br.waitFor`

plus a small set of page-level CDP methods (`Page.navigate`, `Page.reload`,
`Page.captureScreenshot`, history navigation, frame tree).

**Refused by construction** — not by policy you can toggle, but by an allowlist compiled
into the extension:

| Refused | Why |
|---|---|
| `Runtime.*`, `Debugger.*` | arbitrary code execution in a logged-in browser |
| `Input.*` | raw input injection — use the structured `_br.*` actions |
| `Network.*Cookie*`, `Storage.*` | cookie / credential surface |
| `Fetch.*` | request interception |
| `Page.addScriptToEvaluateOnNewDocument` | persistent script injection |
| `Page.setDownloadBehavior` | writes to your filesystem |
| `Browser.*`, `Target.*` | browser-wide control / target creation |

**Also refused:** typing into password fields, and navigating to payment or
account-security surfaces — `guard.js` blocks these *regardless of what is asked*.
The extension will not attach to `chrome://`, `chrome-extension://`, `devtools://`, or
the Chrome Web Store at all.

The allowlist here is a **deliberate second copy** of the relay's. The relay runs in the
agent's container; this extension runs inside your logged-in browser. Those are different
trust domains, so the side holding your real sessions does not execute whatever arrives
over the socket just because the socket was authenticated. Drift is allowed in exactly
one direction: this extension may be **stricter** than the relay, never looser.

---

## Troubleshooting

Read the status box on the Options page first.

| Symptom | Meaning |
|---|---|
| `state: connecting` looping | Relay is not running, or URL/token is wrong |
| `closeCode: 1008` | Token rejected |
| `state: open`, commands refused | No tab armed, or the kill switch is off |
| Connection drops every ~16s | Platform-edge idle timeout. The extension reconnects on its own (exponential backoff, with a `chrome.alarms` backstop), so it recovers — but a long single action can be cut mid-flight. |
| `refused by extension: …` | The action hit the allowlist or the guard. The message says which. |

The service worker can be torn down by Chrome at any time; `chrome.alarms` wakes it back
up and reconnects. A brief `state: closed` is normal, a permanent one is not.

---
---

# Zylos 浏览器扩展（中文）

**Zylos browser-remote** 系统的 Chrome MV3 扩展部分：它让 agent 通过一条**收窄的、可审计的**
命令通道，去驱动一个**你亲手授权（arm）**的标签页 —— 而不是把原始 CDP 权限直接交出去。

> 服务端（relay）在 `zylos-ai/zylos-browser-remote`。本仓库只有扩展这一半，**单独装是跑不起来的** ——
> 没有 relay 在跑，socket 另一端就是空的。

---

## 装之前先搞清楚：它是什么，不是什么

整套系统是两半 + 一个聊天通道：

```
  你 ──(聊天：飞书 / OpenMax / …)──► agent
                                       │  下发结构化动作
                                       ▼
   你的 Chrome ◄──[本扩展]──► relay (wss://<agent-domain>/browser-remote/ext)
```

- **这个扩展是「手」，不是「嘴」。** 它**没有对话框**。你不在扩展里跟 agent 说话 ——
  你还是在平时聊天的地方跟它说，扩展只是让它能碰到你的浏览器。
- **是浏览器主动往外拨号。** agent 所在的容器没有任何通往你机器的路由，是你的 Chrome
  主动建立连接。外部无法反向拨进你的机器。
- **不授权任何标签页，就什么都不会被操作**，且同一时刻只能有一个标签页可被驱动。

## 文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单 |
| `background.js` | Service worker：relay 连接、已授权标签页的生命周期 |
| `actions.js` | `_br.*` 命令的具体实现 |
| `policy.js` | 允许哪些命令 |
| `guard.js` | 拦截敏感界面（密码 / 支付 / 账户安全类页面和输入框） |
| `options.html` / `options.js` | relay 地址 + Key 的配置界面 |

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

> **请用一个专用的 Chrome 配置文件（profile），不要用你日常那个。**
> 在这里被授权的标签页都可能被远程驱动，单独开一个 profile 能把影响面控制住。

### 2. 配置

打开扩展的**选项**页（`chrome://extensions` → *详细信息* → *扩展程序选项*），然后：

1. 粘贴 **Relay URL**
2. 粘贴 **Token**
3. 点 **Save & reconnect**
4. 看状态框 —— 要看到 `state: open`

### 3. 授权（arm）一个标签页

还是在选项页，**Arm a tab** 表格里列着你当前打开的标签页。在你希望 agent 操作的那个后面
点 **Arm**，被授权的那一行会高亮。

- 同一时刻只能授权一个。
- 点 **Disarm** 立刻收回控制权，agent 的下一条命令就会被拒。
- 顶部的 **Remote control enabled** 复选框是总开关（kill switch）：取消勾选会直接断开
  relay 连接并拒绝一切命令，不用你再去找是哪个标签页被授权了。

### 4. 真正开始用

回到你和 agent 的聊天里，直接告诉它要干什么 —— *「打开 bilibili 搜 X」*、
*「点第二个结果」*、*「截个图给我看」*。agent 下发结构化动作，本扩展在已授权的标签页上执行。

---

## agent 能做什么、不能做什么

**允许的结构化动作**（agent 只能提供**数据** —— 选择器、字符串、URL，
**不能提供代码，也不能给原始坐标**）：

`_br.info` · `_br.listTabs` · `_br.snapshot` · `_br.click` · `_br.fill` · `_br.press` ·
`_br.screenshot` · `_br.navigate` · `_br.waitFor`

外加一小撮页面级 CDP 方法（`Page.navigate`、`Page.reload`、`Page.captureScreenshot`、
前进后退、frame tree）。

**从构造上就被拒绝的** —— 不是一个你能开关的策略，而是编译进扩展里的白名单：

| 被拒绝 | 原因 |
|---|---|
| `Runtime.*`、`Debugger.*` | 在已登录的浏览器里等于任意代码执行 |
| `Input.*` | 原始输入注入 —— 请走结构化的 `_br.*` |
| `Network.*Cookie*`、`Storage.*` | cookie / 凭证面 |
| `Fetch.*` | 请求拦截 |
| `Page.addScriptToEvaluateOnNewDocument` | 持久化脚本注入 |
| `Page.setDownloadBehavior` | 会往你的文件系统写东西 |
| `Browser.*`、`Target.*` | 浏览器级控制 / 创建新 target |

**另外还拒绝：** 往密码框里输入内容、以及跳转到支付或账户安全类页面 ——
`guard.js` **不管你怎么要求都会拦**。扩展也完全不会附加到 `chrome://`、
`chrome-extension://`、`devtools://` 和 Chrome 应用商店上。

这里的白名单是 relay 那份的**刻意的第二份拷贝**，不是没去重。relay 跑在 agent 的容器里，
本扩展跑在**你已登录的浏览器**里，这是两个不同的信任域 —— 握着你真实会话的那一侧，
不能仅仅因为「消息是从一个通过鉴权的 socket 过来的」就照单执行。
只允许单向偏移：本扩展可以**比 relay 更严**，绝不能更松。

---

## 排查

先看选项页上的状态框。

| 现象 | 含义 |
|---|---|
| `state: connecting` 反复循环 | relay 没在跑，或者地址/Key 填错了 |
| `closeCode: 1008` | Key 被拒绝 |
| `state: open` 但命令被拒 | 没有授权标签页，或者总开关是关的 |
| 每 ~16 秒断一次 | 平台边缘的空闲超时。扩展会自动重连（指数退避 + `chrome.alarms` 兜底），所以能自愈；但**单个耗时较长的动作可能被拦腰切断**。 |
| `refused by extension: …` | 撞到白名单或 guard 了，消息里会写明是哪一条 |

Service worker 随时可能被 Chrome 回收，`chrome.alarms` 会把它唤醒并重连。
短暂出现 `state: closed` 是正常的，一直是就不正常。
