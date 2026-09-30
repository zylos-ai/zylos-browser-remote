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

**无需手工编辑 Caddyfile。** 路由声明在 `SKILL.md` 的 `http_routes` 里，
安装与升级时由 zylos-core 自动写入 Zylos 托管的 Caddyfile，并包在
`# BEGIN/END zylos-component:browser-remote` 标记内：

```caddyfile
redir /browser-remote /browser-remote/ permanent
handle /browser-remote/* {
    uri strip_prefix /browser-remote
    reverse_proxy 127.0.0.1:3802 {
        header_up X-Forwarded-Prefix /browser-remote
    }
}
```

不要给 3803 添加公网路由。
交给用户的连接地址为 `wss://实际域名/browser-remote/ext`。
只有浏览器与 Remote 在同一台机器上时，才使用 `ws://127.0.0.1:3802/ext`。

> **升级既有部署**：0.9.0 及更早版本没有声明 `http_routes`，其部署通常在
> Caddyfile 里留有一份**手工添加**的等价路由（在托管标记之外）。升级后
> core 会在站点块末尾追加托管版本，两者并存 —— 配置仍然有效（`caddy
> validate` 通过，先出现的手工块生效，托管块成为死配置），但应当**删除手工
> 块**，把这条路由交还给 core 托管。

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
PNG/JPEG/WebP/GIF 按 MIME 与文件头校验；标准输出不携带截图 Base64。
默认临时目录是 `~/zylos/components/browser-remote/observations`，
可用 `BROWSER_REMOTE_OBS_DIR` 调整目录。附件与截图只在当前任务期间保留，
任务完成、停止、断线或服务正常关闭时删除；新任务需要原图时应重新附上。
只按任务生命周期删除文件，不进行启动、定时或按文件年龄清理。
存储上限为 128 MiB，达到上限时拒绝新写入，不删除其他活动任务的图片。

断线、停止或插件重载会中断当前任务；Remote 不自动重放动作。
请求重试必须沿用原请求 ID 和相同决策，不能因为超时就重新点击或提交。

## 插件当前活动

新插件通过 `agent-activity-v1` 订阅当前 Agent 工具活动。在原有 WebSocket 上推送
任务关联的 `agent-activity`，让同一行显示执行命令、读取文件、搜索等，工具返回后
显示处理结果。额外声明 `agent-history-v1` 时，还会推送公开进展文字和 Agent 工具记录，
用于 Thinking 展开区域；插件自己的浏览器动作不混入展开列表。记录保存在插件本地聊天历史，
结束后仍可查看。旧插件继续接收原来的单行状态。

此功能不依赖 Monitor，无需修改 zylos-core。Remote 只读 Agent 现有的 Codex CLI
或 Claude Code 根会话 JSONL 日志。公开文字仅来自 Codex commentary / Claude assistant text，
会过滤常见凭证；工具记录含固定分类、已知工具和程序名及起止时间，不发送命令参数、
原始输出或隐藏的 analysis / reasoning / thinking 内容。活动标记位于 C4 消息开头，短预览也能关联；未知标记、
其他 Channel、混合任务及已结束连接不推测归属。

- `BROWSER_REMOTE_AGENT_DIR`：Agent 工作目录，需含 `.zylos/config.json`，默认
  `ZYLOS_DIR` 或 `~/zylos`。配置了 `BROWSER_REMOTE_MONITOR_AGENT_DIR` 时沿用该目录。
- `BROWSER_REMOTE_ACTIVITY=0`：关闭实时活动采集，聊天和浏览器功能不受影响。
- Codex 通过 `CODEX_HOME`（默认 `~/.codex`）的会话索引定位该目录下的 CLI 日志，
  需要 `sqlite3`；Claude Code 从 `~/.claude/projects` 对应项目的根会话日志读取。

有订阅任务时每 750 毫秒读取新增日志，每 5 秒刷新会话发现，最多跟踪 4 个会话，
每个会话每次最多读取 1 MiB。没有活动任务时不读取日志。日志不可用、无法确定归属
或状态过期时，插件回退到原有进度提示，不阻断任务。运行时日志格式变化可能需要
更新 Remote 适配器。历史每批最多 100 条，待发缓冲最多 500 条；超过上限会发送省略数量。
插件会合并相同工具 ID 的开始与结束，并限制本地历史体积；这些限制不影响任务执行。
Monitor 的完整诊断记录仍由下面的开关单独控制。

## 组件配置 `config.json`

**可选。** 不存在时组件按内置默认值运行，行为与从前完全一致 —— 全新安装无需任何
配置即可使用。连接 Key **不是配置**：由 `scripts/key.js` 现签，以 sha256 摘要存在
`keys.json`，永远不写进 `config.json`。

`config.json` 承载的是少量**每部署一次的运行选项**，适合固化下来、免得每次重启都
重新导出环境变量。位置 `~/zylos/components/browser-remote/config.json`：

```json
{
  "activityEnabled": false
}
```

| 键 | 类型 | 默认 | 等价环境变量 |
|----|------|------|--------------|
| `activityEnabled` | boolean | `true` | `BROWSER_REMOTE_ACTIVITY` |

**取值优先级**（从高到低）：调用方显式传参 → 环境变量 → `config.json` → 内置默认。
环境变量刻意压过文件：pm2/ecosystem 和临时 shell 运行必须能覆盖它们看不见的文件。

改完 `config.json` 需要 `pm2 restart zylos-browser-remote` 生效（端口已监听，不做热重载）。
文件格式错误、类型不对或键名拼错只会**告警并跳过该项**，不会导致服务起不来。

⚠️ **端口不在此处配置**：`BROWSER_REMOTE_EXT_PORT` / `BROWSER_REMOTE_AGENT_PORT`
只认环境变量。插件端口写死在 `SKILL.md` 的 `http_routes` 里（Caddy 反代
`127.0.0.1:3802`），Agent 端口写死在 `scripts/` 的各个 CLI 客户端里；若从
`config.json` 改端口，监听会搬家而这两处仍指向旧端口，组件会「看起来健康、实际不通」。

⚠️ **Monitor 调试开关也不在此处配置**：`BROWSER_REMOTE_MONITOR` /
`BROWSER_REMOTE_MONITOR_FILE` / `BROWSER_REMOTE_MONITOR_AGENT_DIR` 同样只认环境
变量。随组件发布的 `ecosystem.config.cjs` 明确钉死 `BROWSER_REMOTE_MONITOR=0`，
免得开发机 shell 里的调试开关被带进生产；而环境变量优先于本文件，所以写在
`config.json` 里的 `"monitor": true` 在 pm2 下**永远解析为 false**——一个在唯一
要紧的部署方式下必然失效的开关，不该出现在配置文件里。要临时开调试，见下方
「本地 Monitor」。

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

### Messages during an active task

Clients advertising `agent-input-v1` send follow-ups as independent `agent-input`
frames. Remote forwards each directly to C4, including while a browser decision
command is running. It does not queue these messages behind the decision exchange.
C4 and the Agent runtime own message scheduling; browser execution remains serial.
The latest owner input ID accompanies actions and final replies so the extension
can reject outdated decisions. Existing clients and their `agent-steer-v1`
continuations remain supported; new clients require Remote's `agent-input-v1`
capability to enable follow-ups. No zylos-core modification is required.
