# 架构与数据流

[文档首页](../README.md) · [本地开发与验证](local-development.md)

## 三个运行端

| 运行端 | 职责 |
| --- | --- |
| Qoder Cloud Agents | 保存主会话事件，运行云端工具与子线程，接收 Mac 结果 |
| Dot Mac 服务 | 订阅主会话，解释授权相关事件，调用 DSH，保存本机状态并回传 |
| Dot 面板和 Qoder 网页 | 读取同一对话、显示审批和结果。手机通过 Qoder 网页访问主会话 |

Mac 服务主动连 QCA。手机使用 Qoder 的公网网页，Mac 面板监听本机回环地址。

## 一轮 Mac 任务如何流转

1. 用户向主会话发消息。Dot 通过 QCA 事件流取得消息、工具请求和审批状态。
2. Mac 用本轮原文、当前审批和已选工作区核对请求。需要讨论的任务由 Mac DSH 审查方案，明确请求和逐条审批走各自的检查。
3. Mac 启动 DSH 并保存结果或中断回执。回传绑定原工具请求，重启后根据已保存的回执继续处理。
4. 面板通过本机状态接口更新对话。QCA 按原会话保存回传，手机可直接查看。

Mac 桥接定期更新在线状态，标明到期时间和 CLI、Web 能力。新消息也可带上该轮的在线状态文件。任务本为离线查询同步统计及观测时间，详细任务数据保留在 Mac。[QCA 会话资源](https://docs.qoder.cn/cloud-agents/api/sessions/resources/add)

## 从哪里读代码

| 模块 | 入口 |
| --- | --- |
| 本机服务、事件投影、路由 | [server.mjs](../../server.mjs) |
| QCA 接口、工具定义和会话提示词 | [qca.mjs](../../qca.mjs) |
| Mac 审批核对、DSH 执行 | [console-approval.mjs](../../console-approval.mjs)、[dsh-runner.mjs](../../dsh-runner.mjs) |
| 任务本和在线状态 | [dot-taskbook.mjs](../../dot-taskbook.mjs)、[dot-bridge.mjs](../../dot-bridge.mjs) |
| 迁移和维护 | [dot-migration.mjs](../../dot-migration.mjs)、[dot-maintenance.mjs](../../dot-maintenance.mjs) |
| Web 界面、Markdown 和星球外观 | [index.html](../../index.html)、[app.js](../../app.js)、[markdown.js](../../markdown.js)、[planet.js](../../planet.js) |
| DSH 插件 | [dsh-panel](../../dsh-panel/) |

真实配置和状态分别保存在本机 `.env` 与 `.dot-state/<站点>/`。公开复现使用 `.env.example`、模拟网关和测试夹具，保留账号及数据边界。
