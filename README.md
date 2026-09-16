# zylos-browser-remote

## 复制给 Agent

在 GitHub 页面上，将鼠标移到下面的文本块，点击右上角的**复制按钮**，
再把整段文字粘贴给你线上的 Zylos Agent。
Agent 会按本文完成安装配置，并通过原来的对话把连接地址和 Key 发给你。

```text
请帮我安装并配置 Zylos Browser Remote，让我能通过 Chrome 插件和你聊天，并让你操作我的浏览器。我确认安装（confirm）。

请先阅读安装说明：
https://github.com/zylos-ai/zylos-browser-remote/blob/main/README.md

然后完成：
1. 检查是否已安装 browser-remote；已安装则复用。
2. 使用你现有的公网 HTTPS 域名，配置 WebSocket 转发路由。
3. 启动服务，检查 Relay 和公网入口是否可用。
4. 为我的 Chrome 插件生成一个连接 Key。
5. 读取组件 SKILL.md 了解传输入口；插件连接后，通过 describe 获取插件自己的工具和操作指南。

完成后，请直接在当前对话返回：
地址：wss://你的真实域名/browser-remote/ext
Key：本次生成的完整密钥，不是 keyId

我会把这两项填入插件设置，然后与你验证聊天和浏览器操作。
```

需要手动执行或了解安装细节时，见下方的[线上安装步骤](#让线上-agent-安装并返回连接信息)。

## Overview

Lets a Zylos agent drive **the owner's own Chrome** — real profile, real logins —
from a container that has no public IP and cannot reach the owner's machine.
The browser dials out; the agent never dials in. The owner talks to the agent
from the extension's side panel; the agent works in dedicated, marked tabs.

This repo is the **relay**: a thin, opinion-free pipe plus the zylos-core
component glue. Every browser decision (what a command means, which URLs are
off-limits, which tab may be touched, idempotency) lives in the extension —
[`zylos-browser-extension`](https://github.com/zylos-ai/zylos-browser-extension).

```
owner's Chrome ─[extension]─→ wss://<agent-domain>/browser-remote/ext
                                 │  platform edge (TLS)
                                 ▼
                           existing Caddy   /browser-remote/*  (strips prefix)
                                 ▼
   relay :3802   PUBLIC lane — extension ingress ONLY, path /ext, key-authed
   relay :3803   LOOPBACK ONLY, never routed — POST /rpc, POST /chat, GET /status
                                 ▲
                scripts/browser.js (agent CLI)   scripts/send.js (C4 outbound)
```

Two ports, and they must not be collapsed: Caddy's `strip_prefix` forwards
_every_ path on :3802, so anything served there is reachable by whoever learns
the domain. A leaked public URL lets someone offer to **be** a browser (and only
with a key) — never to drive one.

## 让线上 Agent 安装并返回连接信息

适用于**每个用户已有一台 Zylos Agent，且每个 Agent 已有独立公网 HTTPS 地址**的部署。
Browser Remote 与 Core / C4 运行在同一台机器或同一容器的网络空间，插件运行在用户自己的 Chrome 中。
用户电脑只需要安装插件；Relay、C4 和 Agent 由线上机器运行。

例如 Agent 的公网入口为 `https://alice.example.com`，插件应连接
`wss://alice.example.com/browser-remote/ext`。沿用现有域名、证书和公网 443 入口，
在现有反向代理中增加路径转发即可。聊天和工具消息共用这条 WebSocket。
Relay 的两个端口都绑定 `127.0.0.1`：`3802` 经代理供插件连接，`3803` 只供 Agent 本机调用。

用户可直接复制本文开头的[安装话术](#复制给-agent)发给 Agent。

### Agent 执行步骤

下面是**当前版本需要 Agent 按文档完成的安装流程**。
目前 `scripts/key.js` 只生成 Key；`SKILL.md` 尚未声明 `http_routes`，也没有一键配对脚本。
因此不能把 `zylos add --json` 返回成功等同于路由、服务和浏览器连接均已就绪。

#### 1. 检查运行环境并安装组件

确认 Core 已初始化，Agent 和 C4 正常运行，现有 HTTPS 入口可访问。
以下命令使用当前组件默认的 `~/zylos` 运行目录。
如果使用自定义目录或容器部署，先核对组件路径及本机端口是否位于同一网络空间。

```sh
zylos list
```

尚未安装 `browser-remote` 时执行：

```sh
zylos add https://github.com/zylos-ai/zylos-browser-remote --branch main --yes --json
```

安装前先检查列表；已存在 `browser-remote` 时复用现有组件，避免重复安装或重置密钥。
使用完整仓库地址，因为当前 Core 内置 registry 尚未收录 `browser-remote`。
安装后读取 `~/zylos/.claude/skills/browser-remote/SKILL.md`。

组件目录中的 `scripts/send.js` 已符合 C4 的 Channel 约定：
`c4-send.js browser-remote <keyId>` 会找到这个脚本。
Agent 通过 `scripts/browser.js` 发出浏览器命令，具体 CDP 操作由插件执行。

#### 2. 配置现有公网入口

读取现有部署的公网 HTTPS 地址。Core 通常把域名保存在
`~/zylos/.zylos/config.json` 的 `domain` 字段中；平台提供的公网入口应以平台配置为准。
外层网关可能负责 TLS，容器内 Caddy 使用 HTTP，所以不要仅根据内部监听协议生成公网地址。
插件使用的地址必须来自用户可访问的入口，不能使用服务器的 `localhost` 或容器内网地址。

如果入口使用 Core 的 Caddy，在 `~/zylos/http/Caddyfile` 的现有站点块内加入下面的路由。
已有同一路由时核对并复用，保留站点的其他配置。

```caddyfile
# BEGIN zylos-component:browser-remote
handle /browser-remote/* {
    uri strip_prefix /browser-remote
    reverse_proxy 127.0.0.1:3802
}
# END zylos-component:browser-remote
```

校验后重载运行中的 Caddy：

```sh
~/zylos/bin/caddy validate --config ~/zylos/http/Caddyfile --adapter caddyfile &&
  ~/zylos/bin/caddy reload --config ~/zylos/http/Caddyfile --adapter caddyfile
```

校验失败时先修正配置，不执行重载。外层网关也必须将 `/browser-remote/ext`
送到这个站点，并允许 WebSocket Upgrade。使用其他代理时实现相同的转发与去前缀行为。
`3803` 的 `/rpc`、`/chat`、`/status` 保持本机访问，不添加公网路由。

#### 3. 启动并检查 Relay

```sh
mkdir -p ~/zylos/components/browser-remote/logs
pm2 start ~/zylos/.claude/skills/browser-remote/ecosystem.config.cjs --only zylos-browser-remote
pm2 save
pm2 status zylos-browser-remote
curl --fail --silent --show-error http://127.0.0.1:3803/status
```

已在线的服务直接检查即可。Core 的组件注册记录与组件 `ecosystem.config.cjs` 用于服务发现；
同时检查该机器原有的 PM2 / 容器启动机制会在重启后恢复服务。
`/status` 返回 `ok: true` 且 `extensions` 为空，表示 Relay 已运行、浏览器尚未连接。

将示例域名替换为真实域名后检查公网路由：

```sh
curl --silent --show-error --max-time 15 --include https://alice.example.com/browser-remote/ext
```

当前 Relay 对普通 HTTP 请求返回 `426 Upgrade Required` 和 `upgrade required`。
这只能初步确认 HTTPS 请求到达 Relay，不能代替带 Key 的 WebSocket 连接或完整聊天验证。
出现证书错误、404 或 502 时，先检查公网入口、路径转发和服务状态。

#### 4. 生成 Key 并交给用户

```sh
node ~/zylos/.claude/skills/browser-remote/scripts/key.js new --label owner-chrome
```

这条命令输出完整 `key` 和 `keyId`；`keys.json` 只保存摘要，无法从中取回原始 Key。
为同一浏览器排查连接问题时先保留原配置；需要新增或替换凭据时再生成新 Key。
生产服务使用密钥文件，不设置用于本地开发的 `BROWSER_REMOTE_KEY`，因为该变量会覆盖文件鉴权。

将实际公网地址的协议换成 `wss`，加上 `/browser-remote/ext`，
再通过用户**原来的对话入口**返回下面两项。首次配对时插件尚未连接，不能用插件侧栏交付 Key。

```text
浏览器连接配置

地址：wss://alice.example.com/browser-remote/ext
Key：<本次生成的完整 key>

打开 Zylos 插件 → 设置 → 填入地址和 Key → 保存并连接
```

`keyId` 是内部用于区分浏览器和回复会话的标识，不能代替插件设置里的完整 Key。
Key 单独填入密钥字段，不放在 URL 的查询参数中。当前插件需要分别填写地址和 Key，尚不支持合并连接码。

#### 5. 用户连接后验证聊天与浏览器操作

```sh
node ~/zylos/.claude/skills/browser-remote/scripts/browser.js status
node ~/zylos/.claude/skills/browser-remote/scripts/browser.js --endpoint '<keyId>' info
```

把 `<keyId>` 替换为本次生成的标识。`status` 中应出现该浏览器，`info` 应返回插件版本与能力。
让用户从侧栏发送一条消息，并通过 `c4-send.js browser-remote <keyId>` 回复，确认双向聊天。
连接后先调用 `browser.js --endpoint <keyId> describe`，按插件返回的指南和工具定义执行；例如用户发出“打开一个示例网页”的任务后，
确认插件创建 `zylos` 工作标签组，并在任务完成时按文档清理。
只有完成这些验证，才报告完整链路可用。

用户侧的安装与填写说明见
[插件 README](https://github.com/zylos-ai/zylos-browser-extension#连接线上的-agent)。

## 插件是浏览器能力的唯一来源

Remote 的 Skill 只说明连接、通用调用、附件读取与消息投递。浏览器工具名、参数和操作策略
均由当前连接的插件提供，服务端不维护另一份表，也不从相邻源码目录读取文档。

```sh
node scripts/browser.js --endpoint <keyId> describe
node scripts/browser.js --endpoint <keyId> describe 'methods=["<tool-name>","<another-tool-name>"]'
```

第一次返回插件打包的指南和精简工具目录；指定方法后返回从实际校验规则生成的参数定义、
约束与例子。同一任务内复用已读取的说明，避免每一步重复拉取。不同浏览器可以有不同版本
和工具，始终从目标 endpoint 获取。新增浏览器操作只需更新插件中的实现与说明。
旧插件没有 `describe` 时会返回 `UNKNOWN_METHOD`，应更新并刷新插件；Remote 不用旧表猜测。

## 图片附件如何交给远程 Agent

插件在结果的任意层级返回 `{mimeType:"image/png",data:"<base64>"}` 等图片对象。
Relay 原样转发；CLI 根据数据类型（而非工具名）递归处理对象和数组，在 **Agent 所在服务器**
的 `~/zylos/components/browser-remote/observations/` 保存图片，把同一对象的 `data` 替换为
`path`、`mimeType`、`bytes`、`imageReadRequired:true`，其余字段和层级保留。

支持 PNG/JPEG；旧插件的 format 或有效 PNG/JPEG 图片头可兼容识别。一次最多返回 12 张图片，
默认保留最近 12 张，当前响应中的图片不会在同批处理时被清理。无效类型或保存失败会报错，
不把图片编码写到 stdout。具体工具返回图片的位置由插件决定，Remote 不登记工具名称。

这些路径属于执行 CLI 的服务器，不是用户电脑上的路径；Agent 与 CLI 需共享对应文件系统。
网络仍传输完整图片，CLI 文本输出只移除图片编码。通过 `BROWSER_REMOTE_OBS_DIR` 改存储目录。

## Run it locally

### 实时查看每轮提问的执行过程

使用相邻目录的 `Browser-dev.sh` 启动本地联调时，会同时启用
[浏览器执行记录](http://127.0.0.1:3803/monitor/)。保持服务运行，在插件侧栏发送问题后，
页面每秒更新收到提问、C4 入队、Agent 工具、浏览器命令、进度回复、最终回复及插件确认。
「工具调用分布」分别列出两类实际工具的名称和次数，时间线可按来源筛选，展开查看摘要、
耗时和错误。Agent 的 `exec_command` 可以包含 `browser.js observe` 等命令，因此两类
次数分别计算；通过命令读文件仍计为 `exec_command`，不会虚构一个 `Read` 调用。
展开 `exec_command` 可查看实际 `cmd` 命令及调用参数 JSON（包括工作目录、等待时间等实际传入的
字段）。「Agent 实际收到的消息」展示日志里确认接收的浏览器提问，包含 C4 前缀和回复目标。
两者分别是用户给 Agent 的消息、Agent 给执行工具的参数。已识别的凭证、图片编码会隐藏，
每条参数详情上限 16 KiB，发生截断时页面会标注。旧步骤在对应会话最近 8 MiB 的日志内分段
查找；只有匹配到完全相同的
会话 ID 和调用 ID 时补充参数，不重放工具，不改变原来的状态、耗时或计数。

Agent 工具采集目前支持 **Zylos Codex CLI**：只读查询 `sqlite3` 中工作目录匹配
`ZYLOS_DIR`、来源为 CLI 的会话，增量读取对应 JSONL 中的工具调用和返回。不读取其他项目
或 Codex 桌面任务的工具，不展示模型内部推理。通过 C4 消息末尾的 `browser-remote`
回复目标关联到已捕获的提问；同一 Agent 轮次混入其他来源时，后续无法归属的调用不分配，
面板会提示。未接入、日志不可读或不支持的运行时会显示采集状态，不把无记录当成没有调用。
工具「已返回」与「完成」分开显示：只有明确的退出码等证据才标记成功/失败。

监控从启用时开始采集，不会还原此前没有记录的任务。每个浏览器的一轮处理在最终回复
提交后结束归组；回复得到插件确认后才显示「已结束」，并不据此判断用户目标是否达成。
同一轮里的连续提问会合并展示：现有命令协议没有逐条问题的关联 ID，不能可靠地拆分。
等待期间只显示「等待下一步」，没有推测模型的思考过程。

开发脚本将记录保存在 `~/zylos/components/browser-remote/monitor.json`（随 `ZYLOS_DIR` 调整），
刷新页面和重启服务后仍可查看。保留最近 60 轮、每轮最近 120 步，文件上限 8 MiB；达到体积
上限时会进一步移除最早的记录。每轮工具次数累计保留，即使早期时间线已省略。
截图编码不记录，输入动作的文本与已识别的凭证字段隐藏；Agent 保存工具名、受限参数摘要、
输出字节数、时间及状态；`exec_command` 额外保存经凭证过滤并限制体积的调用参数，
包括命令文本。其他工具仍仅保留摘要，不保存完整补丁或工具输出。命令中的业务内容、路径、
浏览器参数、页面摘要、问题和回复仍属于本机调试记录。

旧 Relay 进程需要停止后重新运行 `Browser-dev.sh --no-build` 才能加载监控功能。
单独启动 Relay 时，可设置 `BROWSER_REMOTE_MONITOR=1`，可选设置
`BROWSER_REMOTE_MONITOR_FILE` 以保存历史。默认不启用，不设置文件时仅保存在内存。
设置 `BROWSER_REMOTE_MONITOR_AGENT_DIR=/path/to/zylos` 后启用 Agent 工具采集；开发脚本已设置。
需要 `sqlite3` CLI，默认读取 `CODEX_HOME`（未设置时为 `~/.codex`），须与 Zylos Agent 一致。
采集器运行在 Agent/Relay 所在机器，HTML 从 `/monitor/api` 获取数据，不要求浏览器能访问
远端机器的文件路径。新调用从启用后的下一轮提问开始采集，日志刷新可能带来短暂延迟。
页面及只读接口 `/monitor/api` 只挂在本机 `3803`，不挂到供插件连接的 `3802`。
Monitor 复用 Relay 已有的 Agent HTTP 服务，与 `/rpc`、`/chat`、`/status` 使用同一个监听器；
不会启动另一个服务占用 3803。生产 `ecosystem.config.cjs` 显式设置 `BROWSER_REMOTE_MONITOR=0`，
避免继承开发终端的开启设置。关闭时不挂载监控页面、不启动 Agent 日志采集、不写监控历史。
开启后会增加日志读取、历史保存和页面轮询的开销，不产生额外模型请求；不要把 `Browser-dev.sh`
当成生产启动脚本。
测试使用独立端口和模拟插件，不会往正在运行的 Agent 发送问题。

### 启动命令

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

Owner side: install the extension's default build (`npm run build` in
zylos-browser-extension → `.output/chrome-mv3`), open the side panel,
paste `ws://127.0.0.1:3802/ext` and the key when Chrome and the relay run on the
same machine. For an online agent, use its public `wss://` URL as described above.

## As a zylos-core component

`SKILL.md` is the component manifest (`type: communication`, pm2 service
`zylos-browser-remote`, data dir `~/zylos/components/browser-remote`). Installed
at `~/zylos/.claude/skills/browser-remote/`:

| script               | who runs it                                          | does                                                                                                    |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `relay/server.js`    | pm2                                                  | the relay                                                                                               |
| `scripts/browser.js` | the agent                                            | `browser.js [--endpoint k] <method> [k=v … \| json]` → `POST /rpc`; screenshots land in `observations/` |
| `scripts/send.js`    | comm-bridge, via `c4-send.js browser-remote <keyId>` | `POST /chat` → side-panel bubble                                                                        |
| `scripts/key.js`     | ops                                                  | `new --label` / `list` / `revoke`                                                                       |

Owner messages from the side panel arrive as C4 conversations on channel
`browser-remote`, endpoint `<keyId>`, content prefixed `[Browser] `. The name is
`browser-remote` because `browser` is the official zylos-browser capability
component and `browser-extension` is zylos-browser-channel.

## 排查「一直 Working」或聊天无回复

正常最终回复会直接结束本轮：插件撤销浏览器控制、移除 Working 和紫色任务卡片，
保留已打开的页面并取消工作分组。Agent 无需为普通回答额外调用 `finish`。
只有显式标记为进度的消息（`scripts/send.js --progress <keyId> <text>` / `final:false`）才保留任务。
需要只保留部分结果页面时，可以在最终回复前用 `finalize keep=[...]` 关闭其他临时页面。
这些收尾逻辑在插件中执行；Relay 只转发聊天的 `final` 标记和工具请求。

**插件离线也要向原面板提交最终回复。** Relay 0.3.0 会先把最终回复保存到数据目录下的
`chat-outbox.json`，插件重连后补送；插件保存回复后确认，Relay 才移除记录。
插件需支持 `chat-ack-v1`（当前扩展 0.13.0，协议版本 1.3.0）。
普通发送返回 `queued:true` / `messageId` 表示已保存，尚不代表用户已经看到。
`browser.js status` 的 `pendingReplies` 可以检查每个 Key 尚未确认的回复数量。
等待回复确认期间，新的工具请求返回 `CHAT_PENDING`，避免旧回复结束一个刚启动的新任务。
仅最终回复参与补送，进度消息和浏览器操作指令不会重放。

队列总量上限为 100 条，满时返回 `OUTBOX_FULL`；写入失败返回 `OUTBOX_WRITE_FAILED`，
两者都不能当作发送成功。数据文件权限为 `0600`，升级时须保留此文件。
不要因之前一次 `/status` 显示离线而跳过面板回复，也不要用其他聊天渠道的消息代替。

新版 Relay 会把 C4 入队结果通过 `chat-status` 发回插件。C4 退出失败、Agent 不可用、
45 秒未拿到入队结果都会产生提示；两分钟未收到聊天回复时，插件显示延迟提示，不自动重发。
本次状态修复需要同时更新插件和线上 Browser Remote，再重启 Relay、重新加载插件。

在 Agent 机器上检查：

```sh
pm2 status zylos-browser-remote c4-dispatcher activity-monitor
pm2 logs zylos-browser-remote --lines 80 --nostream
node ~/zylos/.claude/skills/browser-remote/scripts/browser.js status
```

日志中的 `chat: queued in C4` 表示已入队，可按 `conversation` ID 继续检查 C4 和 Agent。
出现 `C4 delivery timed out` 或 `C4 returned no queue receipt` 时，投递结果不确定，先检查再重试。
只有 `ext[...] chat` 而没有入队成功日志时，先检查 C4 接收脚本、运行目录和服务状态。
`chat[...] -> panel` 表示回复已交给浏览器连接；WebSocket 在线本身不代表 Agent 正常回复。
最终回复还应有对应 message ID 的 `chat[...] acknowledged`，才表示插件已经保存并确认收到。
`queued reply` 后没有确认，检查插件是否重连、是否支持 `chat-ack-v1`、是否提示本地存储失败。
截图过程超过 12 秒会返回 `SCREENSHOT_TIMEOUT` 并指出阶段；该错误不证明之前的网页操作失败。
`heartbeat missed` 只证明没有及时收到插件数据，仍需浏览器端日志判断是休眠、网络还是插件异常。

## Safety model

The relay is trusted with one fact — which key is which browser — and nothing
else. Both ends treat it as untrusted:

- **Extension**: re-validates every `req` (zod), refuses unknown methods, screens
  URLs against the reviewed blocklist (`utils/guard.ts`) on navigation _and_ on
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
relay/chat-outbox.js   bounded, persisted final replies; removed after extension acknowledgement
scripts/               browser.js · send.js · key.js · relay-client.js
tools/smoke.js         fake extension ↔ relay, 37 assertions
tools/test-cli.js      real relay process + real scripts + fake extension, 25 assertions
docs/PROTOCOL.md       the two surfaces and the C4 hop
docs/THIN-RELAY-PLAN.md  why the relay got thin, decisions taken
```
