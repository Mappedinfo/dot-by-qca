# 快速开始

[文档首页](../README.md)

## 在 Mac 上试用

准备 Node.js 24.14 或更新版本。用下面的命令启动模拟服务。

```sh
git clone https://github.com/Mappedinfo/dot-by-qca.git
cd dot-by-qca
npm ci --ignore-scripts
node server.mjs --mock
```

打开 [本地演示](http://127.0.0.1:4317/)，点「创建主会话」，发一条消息。模拟模式可以体验界面、消息和审批，使用本地模拟数据。

## 连接真实 QCA 会话

准备 [Qoder Cloud Agents](https://docs.qoder.cn/cloud-agents/api/overview) 账号和个人访问令牌（PAT）。如需委派本机任务，还要在 Mac 上安装并配置 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

1. 停止模拟服务。在仓库目录运行以下命令，创建或保留本机配置。

   ```sh
   cp -n .env.example .env
   chmod 600 .env
   ```

2. 编辑 `.env`。中国站设置 `QODER_SITE=cn`，国际站使用 `global`，填入对应站点的 `QODER_PAT`。在真实会话中发送消息会消耗 QCA 额度。
3. 运行 `node server.mjs`，打开 [本地设置入口](http://127.0.0.1:4317/)，点「创建主会话」。服务会为当前账号准备云端环境、Agent 和会话。这个站点已有会话时，直接使用它。
4. 主会话空闲时停止设置服务，在同一目录配置并启动正式面板。

   ```sh
   node server.mjs --configure-qca-console
   DOT_PORT=4320 node server.mjs --qca-console
   ```

在 [Dot 本机面板](http://127.0.0.1:4320/) 确认顶部显示「可发送」。日常运行只需启动最后一条命令。PAT 保留在 Mac 的 `.env` 中。

## 在 DSH 和手机打开同一会话

- **Mac**。在 DSH 左栏点「插件 → 添加插件」，填入 `link:<仓库绝对路径>/dsh-panel`，安装后选择「立即启用」。左栏会出现「Dot by QCA」。Web 和 macOS 客户端分别管理插件。需要同步或续办既有 DSH 对话时，按 [DSH 面板与执行](../development/dsh-panel.md) 配置 DSH Web。
- **手机**。从面板右上角的「在 Qoder 打开」取得当前会话链接，在手机浏览器中用同一个账号打开。中国站也可收藏 [Qoder 会话列表](https://qoder.com.cn/cloud/sessions)，选「Dot by QCA · 当前主会话」。

先从手机发「看一下 Mac 现在几点」。在线桥接会核对请求并回传本机时钟。接下来可以尝试[对话与审批](chat-and-approvals.md)。
