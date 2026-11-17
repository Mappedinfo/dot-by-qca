# 配置与本机接口

[文档首页](../README.md) · [本地开发与验证](local-development.md)

## 启动模式

| 命令 | 用途 |
| --- | --- |
| `node server.mjs --mock` | 本机模拟，默认端口 4317 |
| `node server.mjs` | 连接真实 QCA 并从本机页面创建主会话，默认端口 4317 |
| `node server.mjs --configure-qca-console` | 核对并更新已存在、处于空闲状态的 QCA 会话配置 |
| `DOT_PORT=4320 node server.mjs --qca-console` | 持续连接已有主会话，提供正式面板和 DSH 桥接 |
| `node server.mjs --seed-archive-preview` | 在所选站点的 Dot 工作区创建归档预演样本并退出 |

## 环境变量

从 [.env.example](../../.env.example) 起步。下面列出日常和开发常用配置。

| 变量 | 用途 |
| --- | --- |
| `QODER_SITE` | `global`（默认）或 `cn` |
| `QODER_PAT` | 所选站点的个人访问令牌。服务端也接受 `QODER_ACCESS_TOKEN` |
| `QODER_MODEL` | 创建 Agent 时选择模型。未指定时优先尝试账号可用的 `auto` |
| `DOT_PORT` | Mac 本机监听端口，DSH 面板使用 4320 |
| `DOT_DSH_BIN` | DSH CLI 路径，默认 `/opt/homebrew/bin/dsh` |
| `DOT_DSH_WEB_STATUS` | 返回本机 DSH Web 登录地址的状态脚本，默认从 `PATH` 解析 `dsh-web.sh` |
| `DOT_QCA_HTTPS_PROXY` | Mac 服务访问 QCA 的 HTTPS 出站代理。Node.js 24.x 从 24.14 支持，25.x 从 25.4 支持 |
| `DOT_DSH_HTTPS_PROXY` | DSH 子进程使用的 HTTPS 出站代理 |
| `DOT_QCA_APPROVAL_SCHEDULE_ID`、`DOT_QCA_WECHAT_PAIRING_ID`、`DOT_SERVERCHAN_SENDKEY` | 可选[审批提醒](../user/notifications.md) |
| `DOT_DISABLE_THREAD_POLL` | 联调时关闭服务端的 DSH 与 QCA 任务本后台轮询 |

QCA PAT、通知凭据和本机会话状态留在 Mac。正式面板监听 `127.0.0.1`，手机通过 Qoder 网页接入。[Node.js 代理接口](https://nodejs.org/api/http.html#httpsetglobalproxyfromenvproxyenv)

## 本机 HTTP 接口

这些路由供当前面板与本机 DSH 宿主使用。字段以 [server.mjs](../../server.mjs) 中的路由和处理函数为准。

| 路由 | 使用方与用途 |
| --- | --- |
| `GET /api/state` | 面板读取会话状态、消息、待审批项 |
| `POST /api/start` | 原型或模拟页面创建主会话 |
| `POST /api/message`、`POST /api/approval` | 面板提交消息或审批 |
| `GET /api/memory`、`GET /api/taskbook` | 控制台面板读取本机记忆和任务本 |
| `POST /api/project`、`POST /api/stop` | 控制台面板选工作区或停止当前轮 |
| `POST /api/migration`、`POST /api/migration/switch`、`POST /api/settings/update-agent` | 控制台面板迁移、切换会话或检查配置 |
| `POST /api/taskbook/local` | 本机宿主提交 DSH 状态投影 |

写请求核对来源及 JSON 格式。本机记忆和任务本读取要求 `X-Requested-With: XMLHttpRequest`，宿主上报走独立路由。控制台连接状态未确认时，面板会暂停写操作。
