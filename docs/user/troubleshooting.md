# 故障排查

[文档首页](../README.md) · [快速开始](getting-started.md)

## 面板无法连接

- 在 Mac 浏览器打开 [本机 Dot](http://127.0.0.1:4320/)。页面打不开时，确认已运行 `DOT_PORT=4320 node server.mjs --qca-console`。本机可打开但 DSH 左栏没有面板时，检查插件是否已在使用的宿主启用。
- 页面提示配置 PAT 时，确认 `.env` 的 `QODER_SITE`、`QODER_PAT` 与 Qoder 账号站点一致。首次安装请先创建主会话。
- 显示「正在重连」时，历史仍可查看。连接恢复后，Dot 补读缺失事件并恢复发送。Mac 需要代理时，参见[配置与本机接口](../development/configuration-and-api.md)中的代理项。

## 审批或消息卡住

- Qoder 网页保留历史审批卡。刷新并跳到最新消息，核对当前轮对应的卡片。
- 命令卡过期后，待确认命令会停止等待。先查看回执中已执行的步骤，再决定是否重新发起。
- 「停止当前轮」会同时通知 QCA 和本机 DSH。等页面恢复「可发送」后再继续。
- 提交结果未确认时，先看原会话是否已有消息、审批结果或回执。跨设备重试前也先核对一次。

## 任务本显示未同步

- 找不到本机任务时，检查 DSH CLI 和 DSH Web 是否可用。配置 `DOT_DSH_BIN` 或 `DOT_DSH_WEB_STATUS` 后重启 Dot。
- 搜索框只查已载入的记录。更早的 DSH 对话可说「查找 DSH 对话：标题关键词」。Mac 离线期间显示的任务本数据带有上次观测时间。
- QCA 子线程一直未同步时，先用 Qoder 网页核对当前会话。云端助手缺失时，在 Dot 设置中[检查并修复配置](memory-and-migration.md#修复-dot-配置)。

## 提交问题时附上什么

在 [GitHub 新建问题](https://github.com/Mappedinfo/dot-by-qca/issues/new)时，附上 macOS、Node.js 和 DSH 版本、启动模式、复现步骤，以及关键的页面状态或经过脱敏的错误。提交前移除 PAT、Cookie、登录链接、真实会话 ID、用户资料和任务内容。
