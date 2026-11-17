# DSH 面板与执行

[文档首页](../README.md) · [配置与本机接口](configuration-and-api.md)

## 面板从哪里启动

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件界面安装 `link:<仓库绝对路径>/dsh-panel`。启用后，从左栏打开「Dot by QCA」。Dot 控制台必须运行在 `http://127.0.0.1:4320/`，这也是插件内嵌页面和宿主上报的目标。

| 插件文件 | 职责 |
| --- | --- |
| [client.js](../../dsh-panel/client.js) | 注册左栏和主面板，向 Dot 提供项目列表，按已知会话 ID 打开 DSH 对话 |
| [index.js](../../dsh-panel/index.js) | 从 DSH 宿主读取会话状态并投递到本机任务本接口 |
| [task-rows.js](../../dsh-panel/task-rows.js) | 生成近期对话和状态投影 |

Dot 与 DSH 通过本机端口和 `postMessage` 交换项目和会话定位信息。面板允许 DSH Web 的本机 3080 地址和桌面宿主的 `dsh-app://app` 作为嵌入来源。

## 同步和续办现有对话

启用 DSH Web，使其在本机 3080 端口可用。设置 `DOT_DSH_WEB_STATUS` 指向状态脚本，或将 `dsh-web.sh` 放进 Mac 服务的 `PATH`。脚本的 `status` 输出为 Dot 提供本机登录入口，随后 [dsh-task-source.mjs](../../src/dsh/dsh-task-source.mjs) 通过本机接口查找、核对、续办或停止已有对话。登录地址和 Cookie 留在本机。

验证时先打开一个测试工作区和对话，再从 Dot 任务本打开该对话。用专门的测试对话检查续办或停止，核对回执指向原对话和原轮次。

## 新任务如何执行

- 文本和已授权的 Dot 工作区任务由 `dsh headless` 执行。文本、工作区和终端路径各自使用适用的配置。
- 终端任务经 DSH 的 Agent Client Protocol 核对实际请求、命令内容和执行位置。批准后的执行结果保存在 `.dot-state/<站点>/dsh-runs/`。
- 一般文件任务使用 Dot 工作区。已选 DSH 项目由本机核对目录身份，QCA 可查询项目名称和授权编号。

实现入口见 [dsh-runner.mjs](../../src/dsh/dsh-runner.mjs) 和 [console-approval.mjs](../../src/console-approval.mjs)。改动终端审批或恢复时，重点复核取消、过期、重连和同一回执重试。
