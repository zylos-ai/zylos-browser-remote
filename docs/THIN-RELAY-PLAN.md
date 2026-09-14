# Thin relay 重构计划（2026-09-14）

> 状态：§7 第 1–3 步已完成（relay 瘦身 + channel 组件骨架 + 插件 remote transport，
> 方案 A）。剩余：第 4 步部署切换（Caddy 路由确认、pm2 ecosystem 注册、发 key）与真 Chrome 联调。
> 以下正文是实施前的设计，接口以 `docs/PROTOCOL.md` 为准。

目标：**所有浏览器相关逻辑（CDP、动作、策略、tab 生命周期、侧边栏聊天 UI）放进插件；
zylos-browser-remote 退化成一条"纯通道"** —— 一头是插件（wss + key），一头是 zylos-core
agent（C4 + 本地 CLI）。插件接入时只需要拿到 `relayUrl + key`，不需要知道 zylos 的任何内部结构。

这份文档取代 `PLAN.md` 里"三层协议已冻结"的部分：agent 侧不再暴露 CDP 兼容面
（`/json/list`、`/devtools/page/<leaseId>`），这是本次有意的取舍，见 §5。

---

## 1. 现状盘点（决定什么能删）

relay 今天其实**已经不做任何浏览器驱动**，它持有的东西是：

| relay 现有职责 | 位置 | 处置 |
|---|---|---|
| CDP 外观（`/json/version`、`/json/list`、`ws /devtools/page/<leaseId>`、JSON-RPC 错误码） | `relay/agent-lane.js:78-317` | **删**，换成高层命令 RPC（§3.2） |
| lease（TTL、单活、renew/revoke、sweep） | `relay/lease.js`、`agent-lane.js:152-179` | **删**，任务生命周期已在插件 `session.js`（openTarget/setState/endTask） |
| 方法 allowlist + banned patterns | `relay/chokepoint.js:23-134` | **删**，插件 `policy.js` 已有同一份且被测试断言为子集 |
| URL guard | `relay/guard.js` | **删**，插件 `guard.js` 字节相同，且插件是对着 *live* URL / href / form action 检查的，relay 只能对着缓存的 `tabs[]` 检查（本来就是冗余层） |
| idempotency LRU | `chokepoint.js:138-158` | **移到插件**（§3.4） |
| `attach`/`detach`/`lease-lost` 控制帧 | `agent-lane.js:298,385,388` | **删**，插件本来就是 per-command 懒 attach（`background.js:356`） |
| `tabs[]` 缓存 | `ext-lane.js:93-99` | **删**，只为 guard 和默认 tabId 服务 |
| 插件入口 WS + token 校验 + 心跳 + newest-wins | `relay/ext-lane.js` | **留**，改成 key→连接 的多路映射（§3.1） |
| 聊天入口：`{type:'chat'}` → spawn `c4-receive.js` | `relay/server.js:60-97` | **留**，这是通道的本职 |
| 聊天出口：`POST /chat` → 插件 | `agent-lane.js:116-150` | **留**，并补上缺失的 `scripts/send.js`（§3.3） |

删完之后 relay 剩下约 3 个文件：`ext-lane.js`（插件侧 WS）、`agent-lane.js`（loopback RPC）、
`server.js`（C4 spawn + 装配），预计 < 500 行，零业务判断。

### 两套插件的关系（需要你拍板，见 §6）

- `zylos-browser-remote/extension/`：vanilla MV3，**唯一在讲当前 relay 协议的插件**。有 sidepanel 聊天、guard、
  基于 CSS selector 的 `_br.*` 动作、`session.js` 任务 tab。约 2300 行。
- `zylos-browser-extension/`（WXT + React + TS）：引擎更强（`utils/automation/executor.ts`：AX 树 ref、
  PointerMotion、cleanup journal、敏感输入拦截、视觉光标），但 `main` 分支**只会连 OpenMAX 平台**
  （PKCE 登录、`ws://127.0.0.1:18090/browser-control/ws`、任务状态机），**没有聊天 UI**，
  不认识本 relay。

---

## 2. 目标拓扑

```
用户 Chrome ── MV3 插件（全部逻辑）──wss──▶ wss://<agent-domain>/browser-remote/ext
      · chrome.debugger / chrome.scripting                 │ Caddy strip_prefix（不动）
      · 动作 / 策略 / guard / 幂等 / 任务 tab               ▼
      · sidepanel 聊天                        relay :3802  /ext   key-authed ingress
                                                   │
                                            relay :3803  loopback only
                                              POST /rpc   {endpoint, method, params, requestId}
                                              POST /chat  {endpoint, text}
                                              GET  /status
                                                   │
                       ┌───────────────────────────┴───────────────────────┐
             skills/browser/scripts/browser.js            skills/browser/scripts/send.js
             (agent 调用的 CLI, 打 /rpc)                   (c4-send.js browser <endpoint> 调, 打 /chat)
                                                   ▲
             插件 {type:'chat'} ──▶ relay spawn c4-receive.js --channel browser --endpoint <keyId>
```

零信任边界不变：**插件把 relay 当不可信**（策略在插件），**relay 把插件当不可信**（只做信封校验、
长度上限、key 校验）。relay 唯一的"权力"是 spawn `c4-receive.js`，这与 zylos-telegram 等 channel 组件完全同构。

---

## 3. 接口定义（relay 只提供这三个面）

### 3.1 插件 ↔ relay（公网 wss，`/ext`）

沿用现有握手（MV3 不能设 WS header，key 走 subprotocol）：
`Sec-WebSocket-Protocol: zylos-browser-remote.v2, key.<hex>`。

- relay 侧对 key 做 SHA-256 timing-safe 比较（`ext-lane.js:37-42` 现有逻辑），
  keys 来源：`~/zylos/components/browser/keys.json`（`{ "<keyId>": { "hash": "<sha256>", "label": "bobo-mac" } }`）。
  **v2 阶段先只发一个 key**，但 `keyId = sha256(key).slice(0,12)` 从第一天就作为 C4 `endpoint`，
  这样以后多台浏览器 / 多个用户接入是纯增量。
- 同一 keyId 的新连接顶掉旧连接（现有 newest-wins，close 4001）。
- 帧（全部 JSON 文本）：

| 方向 | 帧 | 说明 |
|---|---|---|
| ext→relay | `{type:'hello', version, capabilities[]}` | 不再带 `tabs[]` |
| relay→ext | `{type:'ping', ts}` / ext→relay `{type:'pong', ts}` | 17 s，兼做 SW keepalive |
| relay→ext | `{id, type:'req', method, params, requestId?, deadline}` | `method` 是高层命令名（§4），relay **不解释** |
| ext→relay | `{id, type:'resp', result}` / `{id, type:'error', code, message}` | `code` 是插件定义的字符串码（`BLOCKED_URL`、`NO_TASK_TAB`、`STALE_ELEMENT`…） |
| ext→relay | `{type:'chat', text, ts}` | relay 只校验 `text ≤ 8000`，其余不看；`sessionId` 字段废弃，路由用 keyId |
| relay→ext | `{type:'chat', role:'assistant', text, ts}` | agent 回复 |
| relay→ext | `{type:'chat-status', state, error?}` | 只在 relay 拒收时发（保持现状） |

删除：`state`、`attach`、`detach`、`lease-lost`、`event`（CDP 事件不再穿透；插件内部消费即可，
需要给 agent 的信息放进 `resp`）。

### 3.2 agent ↔ relay（仅 loopback :3803，无鉴权，`127.0.0.1` 硬编码不变）

```
POST /rpc    {endpoint?: keyId, method, params, requestId?, timeoutMs?}
  → 200 {ok:true, result}
  → 200 {ok:false, code, message}          插件返回的错误，原样透传
  → 503 {ok:false, code:'EXT_OFFLINE'}      该 keyId 没有活跃连接
  → 504 {ok:false, code:'EXT_TIMEOUT'}
POST /chat   {endpoint?: keyId, text}      → 插件 sidepanel 气泡
GET  /status                              → {ok, extensions:{<keyId>:{connected, since, version, capabilities, lastSeenMsAgo}}}
```

`endpoint` 省略时：恰好一个连接就用它，否则 400 `AMBIGUOUS_ENDPOINT`。
relay 对 `method`/`params` **不做任何检查**——它不知道有哪些方法。

### 3.3 relay ↔ zylos-core（C4 channel 契约）

把 relay 做成标准 communication 组件（和 zylos-telegram 同款骨架）。
**组件名 / channel 名统一为 `browser-remote`**：`browser` 已被 registry 里的官方 capability 组件
`zylos-ai/zylos-browser` 占用，`browser-extension` 已被本机安装的 zylos-browser-channel 占用；
现有 `server.js:60-97` 里 `--channel browser` 要一并改掉。

```
skills/browser-remote/     （repo 根即 skill 根，与 zylos-telegram 一致）
├── SKILL.md               frontmatter: name: browser-remote, type: communication,
│                          lifecycle.service pm2 zylos-browser-remote,
│                          data_dir ~/zylos/components/browser-remote, dependencies: [comm-bridge]
├── relay/…                pm2 入口 relay/server.js
├── scripts/send.js        c4-send.js browser-remote <keyId> 会调它 → POST 127.0.0.1:3803/chat
├── scripts/browser.js     agent 用的 CLI：browser.js [--endpoint k] <method> [json-params] → POST /rpc
└── ecosystem.config.cjs
```

- 入：插件 `chat` → relay `spawn c4-receive.js --channel browser-remote --endpoint <keyId> --priority 2 --content "[Browser] <text>"`
  （现有 `server.js:60-97`，改 channel 名和 endpoint 来源；内容加 `[Browser]` 前缀，
  与 `[TG DM]`/`[Lark]` 的惯例一致，让 agent 和以后的记忆总结都能分辨来源）。
- 出：agent `cat <<'EOF' | c4-send.js browser-remote <keyId>` → comm-bridge 找到 `skills/browser-remote/scripts/send.js` → `/chat`。
  这补上了 `docs/SIDEPANEL-SPEC.md:44-51` 承诺但一直不存在的那一段。
- 操作浏览器：agent 直接跑 `scripts/browser.js`，SKILL.md 教方法名和参数（§4），
  截图结果落到 `~/zylos/components/browser-remote/observations/*.png` 让 agent 用图片工具读（借 zylos-browser-channel `src/observations.ts` 的做法）。

`SKILL.md` 里必须写清：C4 消息的 endpoint 就是浏览器的 keyId，回聊天和操作浏览器要用同一个 keyId。

**已决定（2026-09-14）**：浏览器侧边栏对话走正常的 C4 `conversations` 队列，**会进主会话记忆**，先接受。
评估过但否决的替代：`control_queue`（系统自管控制面，语义/信任模型都不匹配）、独立 headless agent 运行
（与主 agent 割裂）。如果以后要"不入记忆"，正解是在 zylos-core 给 `c4-receive.js` 加 `--ephemeral`
并让 `c4-fetch.js --unsummarized` 排除，relay 只需多传一个 flag。

### 3.4 幂等（移入插件）

agent 侧 CLI 对每个 mutating 调用生成 `requestId`（uuid），relay 原样透传，插件按 `requestId` 维护
200 条 LRU（内存 + `chrome.storage.session`），命中就回放并加 `replayed:true`。
relay 失去这项能力是可接受的：relay 与 CLI 同机，重试只发生在 CLI 层。

---

## 4. 插件命令面（v2，由插件 `capabilities` 宣告）

保留现有 `_br.*` 语义，去掉 `_br.` 前缀和"伪 CDP"外衣；relay 不认识这些名字。

| method | params | 来源 |
|---|---|---|
| `info`, `listTabs` | – | `extension/actions.js:639-660` |
| `navigate` | `{url, timeoutMs?}` | `actions.js:575-599` |
| `snapshot` | `{maxElements?, maxChars?}` | `actions.js:467-474` |
| `click` | `{selector}` / `{ref}` | `actions.js:476-500` |
| `fill` | `{selector|ref, text}` | `actions.js:502-517` |
| `press` | `{key, selector?, timeoutMs?}` | `actions.js:519-573` |
| `waitFor` | `{selector?, state?, timeoutMs?}` | `actions.js:601-624` |
| `screenshot` | `{format?, quality?}` | `actions.js:626-637` |
| `openTarget`, `setState`, `endTask`, `clearFinished` | 同现状 | `session.js` |

> 若采纳 §6 方案 A（以 zylos-browser-extension 为家），`click/fill` 改为 AX `ref`，并补齐
> `press <任意键>`、`waitFor`、`getText/getUrl/getTitle`（这些今天由服务端 agent-browser 提供，插件里缺）。

---

## 5. 有意放弃的东西

1. **stock CDP 客户端不能再直接 attach**（`zylos-browser`、`agent-browser`、Playwright）。
   这是让 relay 变薄的代价：CDP 兼容面 = lease + 事件穿透 + allowlist 全都要留在 relay。
   如果以后真要，可以在**插件里**实现一个受限的 CDP-over-command 方法（如 `cdp {method, params}`），
   仍然由插件的 policy 把关，relay 不变。
2. relay 层的 guard/allowlist 双保险。安全边界收敛为一层（插件），换来的是插件独立于 zylos 演进。
   要求：插件必须把 relay 当不可信输入——现在已经基本如此（`background.js:353` 对 live URL 复查）。
3. `sessionId`（per-install UUID）作为路由键。改用 keyId：是谁发的 key 决定它是谁。

---

## 6. 插件的"家"（已决定：方案 A，2026-09-14）

**方案 A（已采纳）— 以 `zylos-browser-extension` 为唯一插件代码库，加一个 "zylos-remote" transport。**
- `entrypoints/background/platform.ts` 与新 `remote.ts` 并列，构建时用 `WXT` env 选一个（或运行时按配置选）。
  `remote.ts` 只负责：wss 连接 + key + 心跳 + 把 `req` 分发给 `executor.execute()`；约 200 行。
- 从 `zylos-browser-remote/extension/` 移植：`guard.js`（URL 黑名单，TS 化）、`sidepanel` 聊天 UI
  （改成 React 组件挂进 `ExecutorPanel`）、幂等 LRU。
- 优点：一个引擎（AX ref + PointerMotion + cleanup journal 比 selector 版可靠得多）、TS + vitest；
  未来 OpenMAX 与 zylos 两条接入路径共用同一套动作实现。
- 代价：多一轮移植（估 2–3 天），且要接受 zylos-browser-extension 文档里"两项目不合并、不把
  agent-browser 搬到用户电脑"的方向被本次推翻（`docs/specs/openmax-browser-connector/design.md:119`）。

**方案 B — 就地升级 `zylos-browser-remote/extension/`。**
- 改动最小：删 `attach/detach/state/event` 处理，方法名去 `_br.`，加幂等 LRU，token→key。1 天内可跑通。
- 代价：两套插件继续分叉，selector 引擎的老问题（`docs/P1-GAPS-PLAN.md`）继续留着。

无论 A/B，**relay 侧改造完全相同**，可以先做。

---

## 7. 实施顺序

1. **relay 瘦身**（独立于 §6）：删 `chokepoint.js`、`guard.js`、`lease.js`、`providers/`、
   `agent-lane.js` 的 CDP 外观；新 `POST /rpc`；`ext-lane.js` 改 key→连接 map；
   `server.js` 的 C4 endpoint 改 keyId。测试：改写 `tools/smoke.js` 为 fake-ext + `/rpc` 往返，
   删 `test-guard.js`/`test-chokepoint.js`/`check-guard-sync.js`。
2. **补 channel 组件骨架**：`SKILL.md` frontmatter、`scripts/send.js`、`scripts/browser.js`、
   `ecosystem.config.cjs`；本地用 `component-management` 装上验证 `c4-send.js browser-remote <keyId>` 能到 sidepanel。
3. **插件侧**：按 §6 决定做 A 或 B。先 B 让链路当天跑通、再 A 也是合理路径。
4. **切换**：Caddy 路由不动；pm2 用 ecosystem 文件注册（不要 `pm2 start` + `save`，见 `PLAN.md:105-109`）。
5. 更新 `README.md` / `docs/PROTOCOL.md`，删掉 `PLAN.md` 中已过期的"冻结三层"段落。
