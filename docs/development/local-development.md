# 本地开发与验证

[文档首页](../README.md) · [架构与数据流](architecture.md)

## 安装和运行

使用 Node.js 24.14 或更新版本，在仓库根目录安装依赖并启动模拟服务。

```sh
npm ci --ignore-scripts
node server.mjs --mock
```

打开 [模拟面板](http://127.0.0.1:4317/)。它用本地网关模拟 QCA，状态保存在 `.dot-state-mock/local/`。已有实例占用默认端口时，可用 `DOT_PORT=4318 node server.mjs --mock` 启动演示。前端由服务直接读取静态文件，修改 HTML、CSS 和浏览器脚本后刷新页面即可。改动服务端代码后重启对应的开发实例。

## 验证消息、审批和回执

1. 创建模拟主会话，发「请记住口令 ORBIT17」，再发「我上一条消息里的口令是什么」，核对回复。
2. 发「请调用 Mac 工具写入测试标记 MOBILE17」。确认批准前没有该标记。
3. 选择允许，核对回传的回执与 `.dot-state-mock/local/mac-markers/<receipt>.json` 中的标签和会话。
4. 用新标签发起第二次，选择拒绝，核对回传结果与文件数量。
5. 刷新或重启模拟服务，确认原会话和历史仍可读取。

需要验证真实 QCA、DSH 宿主或 iPhone 网页时，按[快速开始](../user/getting-started.md)连接测试会话，并把联测结果与模拟测试分别记录。真实联测可能消耗账号额度。

## 运行测试

```sh
npm test
node --check web/app.js
node --check web/planet.js
```

修改审批、断线或重启恢复逻辑时，可先运行 `node --test test/command-recovery.test.mjs`。任务本相关改动可先运行 `node --test test/dot-taskbook.test.mjs`。测试使用模拟事件和临时目录，可以在空白配置下运行。启动测试会核对根目录入口、静态资源和状态保存位置。

要复现归档预演，可运行 `node server.mjs --seed-archive-preview` 准备合成样本，再在测试会话说「让 D 整理一下 Dot 工作区的旧报告，只预演」。查看[协商技能](../../skills/dot-task-consultation/SKILL.md)中的预演约定。

## 提交改动

用一个可复现的问题或使用场景说明改动。在 [Pull Request](https://github.com/Mappedinfo/dot-by-qca/pulls) 中写清影响范围、验证命令和实测结果。若改了启动入口、配置或权限，顺手更新对应文档。公开示例使用合成数据，提交前核对凭据、会话信息和本机路径。
