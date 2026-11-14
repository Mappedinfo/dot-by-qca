# Dot by QCA

Mac 上的 DSH 和 iPhone 使用同一个 Qoder Cloud Agents（QCA）会话。QCA 保存对话、解释执行意图并运行云端任务。Mac 后台服务接收已批准的本地任务，调用 DSH 并回传结果。

**Dot by QCA 是独立开发的第三方项目，与 Qoder Cloud Agents 的提供方无隶属关系，也未获其背书。**

## 日常使用

在 Mac 的 DSH Web 左栏打开「Dot by QCA」。面板复用本机后台服务，可直接发消息和审批。在 iPhone 浏览器打开 `https://qoder.com.cn/cloud/sessions/<session_id>`，登录同一个 Qoder 中国站账号。当前会话 ID 保存在 `.dot-state/cn/session.json`。iPhone 用蜂窝网络也走这个入口。

「让 Qoder 在云端做」交给 QCA 沙箱。沙箱的终端、写入和编辑需要单次确认，面板会显示实际参数。「让 D 那边做」可以指本地 DSH，执行前会显示整理后的任务。执行位置不明时，Qoder 会先问「Mac 还是云端」。缺少具体任务时会问要做什么。可以用口语回答，接着处理上一条任务。

只需当前对话或云端资料的任务可以直接留在 QCA。「优先让 Mac 做，掉线就交给云端」会先检查 Mac 的在线状态。桥接约每分钟更新一次在线状态，150 秒后失效。状态记录只包含会话 ID 和失效时间。依赖本机文件、既有 DSH 对话或本机审批的任务须等 Mac 可用，已投递的任务不会自动重跑。

「云端有任何任务吗？开一个子进程检索最近新闻」可以在同一轮查询当前 QCA 子线程并委派公开检索。「设置 → 检查并修复 Dot 配置」会核对当前会话和云端助手。缺少助手或网页检索工具时，Dot 会创建并验证迁移副本，等当前会话空闲后切换面板。手机可收藏 [Qoder 会话列表](https://qoder.com.cn/cloud/sessions)，迁移后打开「Dot by QCA · 当前主会话」。旧书签仍可查历史，旧会话标题包含最新地址。标题由 Mac 桥接同步到 QCA，发布后 Mac 离线也可以查看。[更新 Session](https://docs.qoder.cn/cloud-agents/sessions-update) · [Multiagent 编排](https://docs.qoder.cn/cloud-agents/multi-agents)

在 Dot 对话中也可以直接说「检查并修复 Dot 配置」。Mac 会登记请求，在本轮结束后用同一流程检查。随后说「查看 Dot 维护状态」可读到 QCA 记忆库中的最近记录。Mac 的请求记录保存在 `.dot-state/cn/maintenance.json`，同步到云端的内容只有请求编号、会话、阶段和更新时间。在面板打开「任务本」或在对话中说「看看任务本」，可同时看迁移前后的 QCA 子线程和从 Dot 发出的 DSH 续办。面板里的云端任务可打开所属 Qoder 会话。

Mac 掉线时，可在 Qoder 主会话说「Mac 现在离线，只查 Dot 任务本的数量」。QCA 从现有记忆库读取最后一次汇总和观测时间。汇总约每两分钟更新，包含近期 DSH 对话、续办与 QCA 子线程的统计。任务标题、正文、路径、DSH 对话 ID 和回执仍保存在 Mac。掉线期间的 Mac 状态以重连后的新观测为准。

Mac 桥接会在当前会话空闲时自动检查 Dot 提示词、工具、固定技能与云端助手。可更新的配置直接在原会话补齐。需要修复云端助手时，Dot 会在迁移副本核对记忆读回和真实子线程回执，通过后再切换。旧会话保留。手动切回缺少云端助手的旧会话后，会保留该选择，仍可在设置中主动修复。云端任务查询失败时显示状态未确认。

Mac 上运行 DSH Web 时，将 `DOT_DSH_WEB_STATUS` 指向 DSH 的 `dsh-web.sh`，或把它放到 `PATH`。在 Dot 对话中说「查找 DSH 对话：标题关键词」，可以查找近期任务本未显示的未归档对话，再按返回的 ID 续办。搜索只匹配标题或精确 ID。

在对话中说「查看 DSH 续办结果 回执编号」，可以按回执读回该次既有 DSH 对话中的最终文字回复。Dot 只在收到这条查询后读取对应续办结果，任务本平时只同步状态。旧会话发出的续办也能从当前主会话查询。

可以先说「帮我把这个想法整理成给 D 的任务，先别执行」。Qoder 会沿用已经谈清楚的约束，只追问会影响结果的问题，整理目标、范围、交付物和验收条件。确认后说「按刚才定的交给 D」。结果回来后，Qoder 会按原任务核对回执和完成证据。问「D 那边进展怎么样」会查这条会话最近一次 Mac 执行的本机回执。运行中的任务在原会话显示执行状态或待审批卡，结束后结果回到原会话。

「看一下 Mac 那边的时间」会直接返回 Mac 的当前日期、时间和时区。Qoder 识别查询，Mac 核对本轮原话，DSH 只运行预设的只读查询。涉及修改时钟或其他操作的请求沿用现有授权流程。

Qoder 先整理和判断任务，Mac 的 DSH 在执行前独立审查，回传结论与理由。明确的固定只读查询通过后自动执行。两端对范围或方法有疑问时，Qoder 可根据 Mac 的意见修订方案，同一轮最多送审两次。缺少只有用户能决定的信息时再追问。Mac 对递归删除和破坏磁盘等明确危险操作直接拒绝，并在本轮拒绝后续执行请求。协商通过的任务仍按本轮用户授权和 Mac 工具权限执行。

在原会话说「让 D 整理一下 Dot 工作区的旧报告」可试用归档预演。Mac 只盘点 `.dot-state/cn/dot-workspace/archive-preview-fixture/` 的五个合成文件，按上海时区的修改日期筛选。可在同一条消息里加「截止日期为 2025-01-01，只预演」。冲突项留在原位，回到对话的清单只有相对路径、文件类型、时间和冲突。新环境运行 `node server.mjs --seed-archive-preview` 准备样本。该流程由会话系统提示词和固定版本的 [Dot 协商技能](skills/dot-task-consultation/SKILL.md) 共同提供。更新技能时运行 `node publish-dot-skill.mjs`，然后在会话空闲时运行 `node server.mjs --configure-qca-console`。

DSH 面板顶部的「记忆」显示本机 `.dot-state/cn/MEMORY.md` 中的条目和来源。在同一会话中可以说「记住 项目偏好 archive-order：按年份排序」「查一下 Dot 记忆 archive-order」「更新 项目偏好 archive-order：按季度排序」或「忘记 Dot 记忆 archive-order」。忘记会移除本机条目，旧消息仍可在 Qoder 会话历史中查看。

### 迁移到带云端记忆的新会话

在 DSH 的 Dot by QCA 面板打开「设置」，填新 Agent 名称和可选交接说明，选择「一键创建迁移副本」。迁移复制当前会话实际生效的模型、系统提示词、技能和工具配置，在同一环境创建新会话。Memory Store 可以提前创建，首次挂载要随会话创建。原会话已有云端记忆库时会复用，保留其中的条目和版本。可为新会话选择只读或读写。没有云端记忆库时默认新建只读挂载。[创建 Session](https://docs.qoder.cn/cloud-agents/sessions-create) · [持久化记忆](https://docs.qoder.cn/cloud-agents/memory-stores)

交接说明会保存到 Qoder 云端。只有勾选上传选项才会将本机 `MEMORY.md` 另存一份云端快照，后续本机修改和忘记操作只作用于本机文件。原始对话和执行回执保存在原会话。新会话用云端 Read 读回校验码后，设置页会提供新旧两个 Qoder 链接和双向切换。Mac 桥接每次连接一条会话，手机也可用同一条会话的 Qoder 链接。迁移中断后可从设置页继续原副本，进度保存在 `.dot-state/cn/migration.json`。

在会话里发「请调用 Mac 工具写入测试标记 MOBILE17」，再在「Mac 写入」卡片上选择「允许」并提交。Mac 写入后，QCA 会话显示回执。Mac 需已登录且联网，重新连上 QCA 后会检查仍待处理的请求。

### 调用 Mac 上的 DSH

可以直接说「让 D 那边把 cellular-dsh-47 转成大写，只给我结果」。QCA 根据当前对话识别 DSH 委派，缺少关键信息时先询问。核对「Mac DSH」卡片上显示的任务，选择「允许」并提交。DSH 的回答和本地会话 ID 会回到当前 QCA 主会话，回执保存在 `.dot-state/cn/dsh-runs/<receipt>.json`。

每个请求启动一次 `dsh headless`，只转发当前轮审批卡中明确批准的单行任务，最多 500 字符。文本任务用纯文本配置。在 Dot 工作区读写文件的任务会在卡片上标明文件权限，文件范围是 `.dot-state/cn/dot-workspace/` 内的普通文件。两种模式都使用本机已有的 DeepSeek 模型凭据。Mac 端默认使用 `/opt/homebrew/bin/dsh`。需要自定义路径或模型代理时，在 `.env` 中设置 `DOT_DSH_BIN` 或 `DOT_DSH_HTTPS_PROXY` 并重启服务。

终端任务通过 DSH 的 Agent Client Protocol 启动。直接下达一条完整单行命令，例如「让 D 在 Mac 执行 `printf HELLO`，把输出发回来」，本条消息即授权执行一次。Mac 会核对本轮原文、执行位置和 DSH 实际请求的命令。要在已授权项目执行，可说「让 D 在当前项目执行 `npm test`」。有引号、中文或复杂标点的命令建议用反引号标出边界。明确要求执行但本机无法从原文核对时，可用一张命令审批卡。需要 DSH 自己决定步骤时，先批准任务，再逐条核对实际命令。命令沿用 DSH 的工作区写入策略。最终回执记录 DSH 会话 ID 和实际命令结果。Mac 服务重启后会把已保存的终端回执补回仍在等待结果的原会话。

在 DSH Web 面板的「本地项目」可以选一个已注册项目。之后在任一端说「让 D 在这个项目里跑测试」，任务卡和终端卡都会显示选定项目。路径保留在 Mac，Qoder 查询接口只返回已选项目的名称和授权编号。改回「Dot 工作区」即可取消该项目选择。

### 查看或停止待处理任务

iPhone 继续在 Qoder 网页查看审批，选择「允许」或「拒绝」后点「提交」。需要逐条审批时，核对命令卡上的截止时间。10 分钟从 Mac 启动这项终端任务时算起。超时后提交旧卡，等待审批的命令不会执行，回执会注明过期及之前已执行的命令。手机端采用网页内审批，Safari 后台推送尚未验证。Mac 面板会显示待审批数量。与 Qoder 断开时，面板显示「正在重连」并保留历史，恢复后补齐原会话的新事件。「停止当前轮」会向 Qoder 发送中断，并通知本机 DSH 停止。中断完成后可以在同一会话发下一条消息。

Qoder 网页会保留历史审批卡。若看到「正在处理上一轮」且输入仍在编辑框，刷新原会话并跳到最新事件。对照本次任务，只处理写着本次任务的审批卡。Qoder 正在取消上一轮时，新消息暂时不会入队。Dot 面板会从待审批区移除已取消的卡片，等该轮结束才恢复发送。

在 DSH 左栏点「插件」→「添加插件」，填入 `link:<本仓库绝对路径>/dsh-panel`，点击「安装」后选「立即启用」。左栏会出现「Dot by QCA」。Web 和 macOS 客户端各自管理插件。

本机页面是 `http://127.0.0.1:4320/`。标记文件位于 `.dot-state/cn/mac-markers/<receipt>.json`。首次接入已有 demo 会话时，先停旧服务，确保当前会话空闲，然后在本目录运行以下命令。已有的会话和对话历史会保留。

```sh
node server.mjs --configure-qca-console
DOT_PORT=4320 node server.mjs --qca-console
```

Mac 通过 QCA 的公开事件流接收请求并回传结果，无需公网入站或 Cloudflare。审批卡返回格式若有变化，Mac 会拒绝无法核对的请求。相关接口见 [Agent 工具配置](https://docs.qoder.cn/cloud-agents/agent-tools)、[更新 Session](https://docs.qoder.cn/cloud-agents/sessions-update) 和 [流式读取 Session 事件](https://docs.qoder.cn/cloud-agents/api/sessions/events/stream)。

Mac 无法直连 QCA 时，可在本机 `.env` 设置 `DOT_QCA_HTTPS_PROXY`，使用已有的 HTTPS 出站代理。此设置需要 Node.js 24.14 或 25.4 及更新版本。

## 启动本地演示

使用 Node.js 24.14 或以上版本。首次在本目录运行 `npm ci --ignore-scripts`，再运行 `node server.mjs --mock`，然后在 Mac 浏览器打开 `http://127.0.0.1:4317/`。模拟网关按 QCA 的公开 API 形状返回确定性事件，可检查界面、共享历史、审批和 Mac 落盘。

iPhone 模拟器启动后，用 Safari 打开同一地址，或在 Mac 运行：

```sh
xcrun simctl openurl booted http://127.0.0.1:4317/
```

真实 QCA 联测时，复制 `.env.example` 到 `.env`，设置权限为 `600`，再填入个人访问令牌。PAT 只由 Mac 上的服务使用。

```sh
cp -n .env.example .env
chmod 600 .env
```

中国站填写 `QODER_SITE=cn`。先停止同端口的模拟服务，再运行 `node server.mjs`。点击「创建主会话」会用该账号创建一个云端环境、一个 Agent 和一条会话。Agent 默认使用当前账号的 `auto` 模型（若可用），也可通过 `QODER_MODEL` 指定账号可用的模型。发送消息会消耗 QCA 额度。创建进度和会话 ID 分步写入 `.dot-state/<站点>/session.json`，同一站点重启后继续使用该会话。模拟状态位于 `.dot-state-mock/local/`。两种模式可以用 `DOT_PORT` 在不同端口同时运行。

## 验证

1. Mac 点击「创建主会话」，发送「请记住口令 ORBIT17」。确认 iPhone 显示同一个 `session_id`，并能看到这条消息及回复。
2. iPhone 发送「我上一条消息里的口令是什么？」。确认回复引用 `ORBIT17`，Mac 也能看到这轮对话。
3. iPhone 发送「请调用 Mac 工具写入测试标记 MOBILE17」。确认两端显示同一个审批请求，批准前没有对应标记文件。
4. 在 iPhone 点击「允许」。两端应收到同一个 `receipt`。打开 `.dot-state/<站点>/mac-markers/<receipt>.json`，核对 `label`、`sessionId` 和 `eventId`。模拟模式的文件位于 `.dot-state-mock/local/mac-markers/`。
5. 再用一个新标签请求写入并点击「拒绝」。两端应收到拒绝结果，Mac 的标记文件数量保持原样。刷新页面或重启服务后核对同一个 `session_id` 和历史记录。

运行 `node --test` 执行本地回归测试。

相关接口见 [中国站 API 概览](https://docs.qoder.cn/cloud-agents/api-overview)、[列出模型](https://docs.qoder.cn/cloud-agents/list-models-new)、[Agent 工具配置](https://docs.qoder.cn/cloud-agents/agent-tools)、[列出事件](https://docs.qoder.cn/cloud-agents/api/sessions/events/list) 和 [发送事件](https://docs.qoder.cn/cloud-agents/api/sessions/events/send)。
