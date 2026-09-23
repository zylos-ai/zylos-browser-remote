# Zylos Browser Remote

连接远端 Zylos Agent 与用户 Chrome 插件的轻量转发服务。

**插件提供工具、执行动作、读取页面；Agent 返回决策；Remote 负责连接和传递。**
执行过程使用决策链路；普通聊天和任务最终回复通过标准 C4 发送入口返回。

```text
Chrome 插件 ── WebSocket ── Remote ── 首轮 C4 ── Agent
     ↑                        ↑                  │
     └──── 结构化决策 ─────────┴── /decision ──────┘
     └──── 新页面状态 ──────── Remote ── 等待中的 decision.js
Agent ── c4-send ── send.js ── Remote ── 插件保存最终回复并结束任务
```

首轮请求由 C4 写入队列并交给 Agent。后续观察结果直接作为 `decision.js` 的返回值，
不重复进入 C4。Agent 可以立即回答普通聊天，也可以返回动作列表，由插件执行后继续。

## 安装与启动

在运行 Zylos Agent 的机器上安装。已经安装时复用组件和密钥：

```sh
zylos add https://github.com/zylos-ai/zylos-browser-remote --yes --json
```

不带 `--branch` 装到的就是**最新的正式发布版本**（latest release tag），这是推荐且唯一
建议的安装方式。升级同理：

```sh
zylos upgrade browser-remote
```

> `--branch main` 只用于验证尚未发版的改动。日常安装和升级都不要加它 —— `main` 上可能
> 存在还没发版、也没有和对应版本插件一起验证过的提交。

组件入口是 `src/index.js`（`package.json` 的 `main`、`SKILL.md` 的 `entry`、
`ecosystem.config.cjs` 的 `script`，三处一致），实现模块在 `src/lib/`。组件管理器使用
`ecosystem.config.cjs` 注册 PM2 服务
`zylos-browser-remote`，持久化注册由 Core 的 `~/zylos/pm2/ecosystem.config.cjs` 管理。
生产配置关闭 Monitor。安装后检查：

```sh
pm2 status zylos-browser-remote
curl --fail --silent --show-error http://127.0.0.1:3803/status
```

### 部署路径注意事项

Core 的机器本地文件 `~/zylos/pm2/ecosystem.config.cjs` 把启动脚本路径写死，并拿**该文件存不
存在**当注册开关：路径不存在时那段配置返回空数组，服务不是启动失败，而是**压根不再被注册**。
且当下 `pm2 status` 看不出异常（运行中的进程早已把旧文件载入内存），要到下一次容器重启才
发作，没有报错也没有崩溃日志。

因此**升级一份手工安装的部署时，同步文件和更新那份机器本地 PM2 配置必须同批完成，并以一次
真实重启验证**——`pm2 status` 显示 online 不能作为验证依据。

### 从源码本地运行

```sh
npm ci
node scripts/key.js new --label my-chrome
npm start
```

`npm start` 执行 `node src/index.js`，一个 Node.js 进程监听两个入口：

| 入口       | 默认地址             | 用途                                         |
| ---------- | -------------------- | -------------------------------------------- |
| 插件连接   | `127.0.0.1:3802/ext` | Key 认证的 WebSocket，通过公网代理供插件连接 |
| Agent 调用 | `127.0.0.1:3803`     | `/decision`、`/status`，仅 Agent 本机访问    |

端口可用 `BROWSER_REMOTE_EXT_PORT` 和 `BROWSER_REMOTE_AGENT_PORT` 调整。
两者都绑定回环地址。公网仅代理插件入口。

## 配置公网入口

使用 Agent 已有的公网 HTTPS 域名。Core 的域名通常在 `~/zylos/.zylos/config.json`，
实际以平台入口为准。外层网关可能负责 TLS，不能用内部监听协议推断公网协议。

使用 Caddy 时，将以下路由加入 `~/zylos/http/Caddyfile` 的现有站点块：

```caddyfile
handle /browser-remote/* {
    uri strip_prefix /browser-remote
    reverse_proxy 127.0.0.1:3802
}
```

按照部署环境校验并重新加载 Caddy。保留已有站点配置；不要给 3803 添加公网路由。
交给用户的连接地址为 `wss://实际域名/browser-remote/ext`。
只有浏览器与 Remote 在同一台机器上时，才使用 `ws://127.0.0.1:3802/ext`。

## 连接 Key

```sh
node scripts/key.js new --label my-chrome
node scripts/key.js list
node scripts/key.js revoke <keyId>
```

`new` 生成 32 字节随机密钥，显示完整 Key 一次；服务器只保存 SHA-256 摘要、备注和时间。
摘要的前 12 位为 `keyId`，用于标识鉴权凭据。用户在插件设置填写地址与完整 Key。
同一个 Key 可以同时连接多个浏览器插件实例（最多 32 个）。插件自动生成并在本地保存
`browserId`，Remote 用 `keyId.browserId` 路由请求、决定、最终回复和诊断事件。
不同实例不会互相替换；同一个实例重新连接时才替换自己的旧连接，并中断旧任务。
同一 Chrome profile 的多个窗口共享一个实例；不同 profile 或设备有各自的实例。

先升级 Remote，再重新加载新版插件。新版插件使用 WebSocket v3 和
`browser-instance-v1` 握手；旧版 Remote 会拒绝连接，不会回退到按 Key 抢占连接。
升级期间 Remote 仍接受 v2 插件，其单 Key 连接与新版实例路由分别保存。
Agent 的上下文仍然共用，这项能力只隔离浏览器路由。

默认密钥文件是 `~/zylos/components/browser-remote/keys.json`，可以通过
`BROWSER_REMOTE_KEYS_FILE` 指定。每次握手重新读取。撤销阻止后续握手，
不会主动关闭已建立的连接。`BROWSER_REMOTE_KEY` 是开发测试用的单密钥配置，设置时覆盖文件认证。
不要把真实 Key 写入仓库或日志。

## 决策协议

双方连接后声明 `agent-loop-v1`。插件发送用户问题、页面上下文和契约；Remote
把首轮交给 C4，并附上关联回复命令。Agent 的动作通过标准输入提交契约规定的 JSON：

```sh
node scripts/decision.js <endpointId> <requestId> < decision.json
```

命令调用 `/decision`，等待插件返回下一轮请求或任务结束。Remote 不解释动作名称和参数，
不决定页面等待和任务完成。完整帧格式见 [协议文档](docs/PROTOCOL.md)，
Agent 使用说明见 [SKILL.md](SKILL.md)。

最终回复（包括普通聊天）走 C4，使用每轮附带的 `replyCommands.done`；遇到障碍使用
`replyCommands.blocked`。标准输入是回复正文，不是 JSON：

```sh
cat <<'EOF_REPLY' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js browser-remote '<endpointId>|req:<requestId>|status:done'
已完成，下面是结果。
EOF_REPLY
```

`send.js` 只将正文和结束状态适配为现有的终止决策，仍使用 `/decision`。
插件确认保存回答并结束对应任务后才算发送成功。请求 ID 关联当前任务，不能用旧轮次 ID；
相同请求和正文重试不重复显示。这个入口不支持无任务的主动通知或中途进度消息。
C4 记录每次发送尝试，包含失败与重试；数据库记录不等于送达确认。

图片通过连接传输，在 Agent 主机保存为私有文件，然后返回路径供图像工具读取。
PNG/JPEG 按 MIME 与文件头校验；标准输出不携带截图 Base64。
默认目录是 `~/zylos/components/browser-remote/observations`，保留最新 12 张。
可用 `BROWSER_REMOTE_OBS_DIR` 调整目录。

断线、停止或插件重载会中断当前任务；Remote 不自动重放动作。
请求重试必须沿用原请求 ID 和相同决策，不能因为超时就重新点击或提交。

## 插件当前活动

新插件通过 `agent-activity-v1` 订阅当前 Agent 工具活动。在原有 WebSocket 上推送
任务关联的 `agent-activity`，让同一行显示执行命令、读取文件、搜索等，工具返回后
显示处理结果。插件本地浏览器动作优先；这些事件不追加聊天历史。

此功能不依赖 Monitor，无需修改 zylos-core。Remote 只读 Agent 现有的 Codex CLI
或 Claude Code 根会话 JSONL 日志，只发送固定分类和已知程序名，不发送命令参数、
原始输出、路径或思考内容。活动标记位于 C4 消息开头，短预览也能关联；未知标记、
其他 Channel、混合任务及已结束连接不推测归属。

- `BROWSER_REMOTE_AGENT_DIR`：Agent 工作目录，需含 `.zylos/config.json`，默认
  `ZYLOS_DIR` 或 `~/zylos`。配置了 `BROWSER_REMOTE_MONITOR_AGENT_DIR` 时沿用该目录。
- `BROWSER_REMOTE_ACTIVITY=0`：关闭实时活动采集，聊天和浏览器功能不受影响。
- Codex 通过 `CODEX_HOME`（默认 `~/.codex`）的会话索引定位该目录下的 CLI 日志，
  需要 `sqlite3`；Claude Code 从 `~/.claude/projects` 对应项目的根会话日志读取。

有订阅任务时每 750 毫秒读取新增日志，每 5 秒刷新会话发现，最多跟踪 4 个会话，
每个会话每次最多读取 1 MiB。没有活动任务时不读取日志。日志不可用、无法确定归属
或状态过期时，插件回退到原有进度提示，不阻断任务。运行时日志格式变化可能需要
更新 Remote 适配器。Monitor 的完整诊断记录仍由下面的开关单独控制。

## 本地 Monitor

```sh
BROWSER_REMOTE_MONITOR=1 npm start
```

打开 `http://127.0.0.1:3803/monitor/`，查看提问、首轮投递、决策轮次、插件执行步骤与结果。
Monitor 使用已有的内部端口，不另起监听服务。默认关闭，生产 PM2 配置明确关闭。

- `BROWSER_REMOTE_MONITOR_FILE`：可选的历史记录文件。
- `BROWSER_REMOTE_MONITOR_AGENT_DIR`：可选的 Agent 日志发现目录，用于采集工具名称和参数。
- `BROWSER_REMOTE_AGENT_URL`：Agent CLI 的内部服务地址，只接受回环主机。
- `ZYLOS_C4_RECEIVE`：开发测试时覆盖 C4 接收脚本。
- `ZYLOS_C4_CONTROL`：可选，覆盖 C4 控制脚本；默认使用接收脚本旁的 `c4-control.js`，或 `ZYLOS_DIR` 下的安装路径。

执行中，插件输入框的发送按钮变为停止按钮。点击后插件立即停止后续浏览器操作，
Remote 通过 Core 现有的控制队列向当前运行时发送一次 `Escape`，中断当前 Agent 轮次。
无需修改 Core。该控制针对 Agent 当前主会话，按同一时刻只停止当前任务的使用方式工作，
不提供跨 Channel 的指定任务取消，也不提供原地恢复推理。
中断控制优先级为 0，5 秒后未投递即过期，不自动重复发送。插件等待按键投递回执后恢复发送；
失败或回执超时会提示“浏览器操作已停止，但 Agent 中断未确认”。投递成功仅表示按键已发送。
此能力需要同时更新插件和 Remote；旧版 Remote 仍能停止浏览器操作。

浏览器执行事件只记录经过裁剪的参数、结果元数据、耗时和错误。
Agent 日志采集为只读诊断，不触发模型调用或浏览器操作。敏感参数会遮蔽。

## 验证与排查

```sh
npm test
curl --fail --silent --show-error http://127.0.0.1:3803/status
pm2 logs zylos-browser-remote --lines 50 --nostream
```

测试使用临时目录、独立端口、模拟插件和 C4 接收脚本，不向实际 Agent 发送任务。
若相邻目录存在 zylos-core，还运行真实 c4-send 和临时 SQLite 数据库验证；
也可通过 `ZYLOS_C4_SEND` 指定 Core 发送脚本。
真实 Chrome 集成验证位于插件仓库的 `npm run test:e2e`。

连接失败时检查公网代理、完整 Key 和服务状态；协议不匹配时更新插件与 Remote。
入队失败检查 C4/Agent 状态；`queued` 只表示已接收，不表示任务已经完成。
Agent 应按请求中的契约持续提交决策，直到 `finished:true` 或明确中断。

## 代码入口

| 文件                                             | 职责                                    |
| ------------------------------------------------ | --------------------------------------- |
| `src/index.js`                                   | 入口；启动两个监听入口，首轮请求交给 C4 |
| `src/lib/ext-lane.js`                            | Key 认证、WebSocket、心跳与连接关联     |
| `src/lib/agent-lane.js`                          | 私有 HTTP 决策入口和状态查询            |
| `src/lib/agent-exchange.js`                      | 关联决策、下一轮请求、重试与结束状态    |
| `src/lib/keys.js`、`scripts/key.js`              | Key 生成、校验与管理                    |
| `scripts/decision.js`、`scripts/relay-client.js` | Agent 命令行传输适配                    |
| `scripts/send.js`、`scripts/reply-route.js`      | C4 最终回复适配与当前请求的命令地址     |
| `scripts/attachments.js`                         | Agent 主机图片、文件附件校验与保存      |
| `src/lib/monitor.js`、`src/lib/agent-trace.js`   | 可选执行诊断                            |
