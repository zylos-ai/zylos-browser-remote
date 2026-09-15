# zylos-browser-remote

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

### 用户可以发给 Agent 的说明

把本 README 的链接和下面这段话发给你现有的 Agent：

```text
请安装并配置 Browser Remote，让我能通过 Zylos Chrome 插件和你聊天、操作浏览器。
安装说明：https://github.com/zylos-ai/zylos-browser-remote/blob/main/README.md

请使用这台 Agent 已有的公网 HTTPS 地址，完成组件安装、路由配置、服务启动和检查，
为我的浏览器生成一个 Key，再通过当前对话把完整 WebSocket 地址和 Key 发给我。
安装后读取组件的 SKILL.md，了解浏览器命令和侧边栏回复方式。
如果已经安装，请检查并复用现有安装；缺少公网入口信息时再向我询问。
```

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
浏览器操作按 `SKILL.md` 执行；例如用户发出“打开一个示例网页”的任务后，
确认插件创建 `zylos` 工作标签组，并在任务完成时按文档清理。
只有完成这些验证，才报告完整链路可用。

用户侧的安装与填写说明见
[插件 README](https://github.com/zylos-ai/zylos-browser-extension#连接线上的-agent)。

## Run it locally

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
scripts/               browser.js · send.js · key.js · relay-client.js
tools/smoke.js         fake extension ↔ relay, 37 assertions
tools/test-cli.js      real relay process + real scripts + fake extension, 25 assertions
docs/PROTOCOL.md       the two surfaces and the C4 hop
docs/THIN-RELAY-PLAN.md  why the relay got thin, decisions taken
```
