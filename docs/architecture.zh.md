# DeepSeek Harness 架构

[English](architecture.md) | 中文

改动 `packages/` 前请先阅读本文。本文假定你了解 Cordis；否则请从[入门](cordis-primer.zh.md)或[教程](cordis-tutorial/index.zh.md)开始。

## Cordis

[Cordis](cordis-primer.zh.md) 是 dsh 底层的框架：插件向共享上下文贡献服务、类型化事件和可逆的副作用。每个组件——包括模型适配器、工具注册表、会话日志和 agent loop（智能体循环）——都是可通过配置替换的插件。

不存在需要打补丁的特权内核：把插件挂载到现有插件旁边，其注册是副作用，在卸载时撤销。

## Profile 与组合包

`dsh` 启动时按序叠加各层，组装插件树。

**profile** 是 Harness home 中的具名组装。它列出组合包，存放已安装的树外插件和用户的 `cordis.patch.yml`。随附模板为 `web`、`headless`、`sdk`、`sdk-minimal` 和 `acp`。

**组合包**分发 Cordis 配置项及其代码；更高层可以 patch 它插入的全部内容。

两者使用 `package.json` 的 `dsh` 字段：`dsh.profile` 列出组合包，`dsh.bundle` 指定组合包的 patch 文件。

[`dsh-base`](../packages/bundle/base/README.zh.md) 是 `web`、`headless`、`sdk` 与 `acp` profile 的共享第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。[`dsh-web-app`](../packages/bundle/web-app/README.zh.md) 增加浏览器应用，[`dsh-headless`](../packages/bundle/headless/README.zh.md) 增加不带服务器的一次性运行器，[`dsh-sdk-app`](../packages/bundle/sdk-app/README.zh.md) 增加 SDK JSON-RPC 服务器，[`dsh-acp-app`](../packages/bundle/acp-app/README.zh.md) 增加仅用于自动化的 ACP 服务器。[`dsh-sdk-minimal`](../packages/bundle/sdk-minimal/README.zh.md) 是刻意保留的例外：一个组合包拥有完整的显式 SDK 配置树，不应用 `dsh-base`。

各层依次应用于空条目列表：profile 中有序的组合包、其 `cordis.patch.yml`、home patch，最后是 `--patch` overlay。patch 按 id 替换条目的整个 config 或插入条目。`preset` patch 在目标声明的 `config.plugins` 内操作，优先级相同。

YAML 控制 HMR：base 启用仅监视配置的 `dsh-hmr`；Headless、SDK 和 ACP 禁用它；`sdk-minimal` 不包含它。Profile patch 覆盖这些默认值。HMR 协调监听和重载；启动器提供 profile 数据和就绪信号。

base 提供用于 Web 和 Agent 的[插件管理器](../packages/boot/plugin-manager/README.zh.md)。

查看启动的配置树：

```sh
dsh --profile web --dump-config
```

它打印出的任何条目，都可以由你自己的 patch 替换。

组装机制见 [app-boot](../packages/boot/app-boot/README.zh.md#profiles)；配置字段见生成的[配置目录](config-catalog.zh.md)。

## 应用启动

受支持的 Node 应用使用具名 `dsh` profile：`web`、`headless`、`sdk`、`sdk-minimal` 和 `acp`，通过 `dsh --profile <name>` 或 `dsh <name>` 选择。`plugin` 是管理命令；同名 profile 必须用 `--profile plugin`。TypeScript SDK 解析同版本 `dsh` 并选择 `sdk`。自定义组装使用 profile 与有序 patch，绝不使用其他可执行文件或内联应用树。`sdk-minimal` 是仓库持有的独立组合包，沿用同一 launcher，不是调用方提供的 Cordis 树。

Vendored CLI、构建/测试可执行文件、进程内直接挂载插件和私有浏览器 WebWorker 预览都不是 Harness 应用启动器。[`verify-application-entrypoints`](../scripts/verify-application-entrypoints.ts)显式分类各包 bin、可执行源码、根 demo、`start:web` 和 `dev:web`，拒绝绕过 `dsh` 的 Node 应用。

Python SDK 采用相同架构：`deepseek-harness-sdk-runtime-<platform>-<arch>` wheel 包含普通 CLI；客户端默认以显式 Harness home 启动 `dsh --profile sdk`。极简示例选择 `sdk-minimal`。Python 暴露 profile 和有序 patch，而非完整 Cordis 树；`dsh plugin` 安装持久外部插件。已删除的私有直读配置载体没有兼容 bin 或回退 parser。

## 桌面应用

[Electron 桌面应用](../apps/desktop/README.zh.md)在签名资源中携带精确匹配的 dsh 生产运行时，并拥有保留的 `$DSH_HOME/profiles/desktop`。共享 helper 初始化 profile、协调组合包、解析安装/组合包依赖，不替换 pnpm 持有的包。Desktop 与 npm CLI 共享产品数据，但包、启用选择与锁文件独立。Desktop 内置 CLI 管理其已初始化的插件。

Electron 以 Electron Node 模式启动私有 Desktop Host。Host 运行共享 CLI profile runner 与完整 Web 应用。窗口立即加载打包 Web 资源，等待启动注入后在同一文档中激活客户端插件。Web 负责 RPC/流；桌面载体将本地页面连接到已认证的 Host。Node IPC 承载启动注入、就绪、致命错误与关闭。Desktop 默认使用系统分配的端口，profile 配置可覆盖。壳拥有的 UI 通过内置 pnpm 执行插件事务，遵循正常用户/profile 配置。

## 核心包

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| [`core/session`](subsystems/session.zh.md) | 仅追加的 `SessionEvent` 日志和内存存储 | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.zh.md) | 提示词片段与工具 schema 的组装 | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.zh.md) | 作用域化的工具注册表和带把关的执行流水线 | `ctx.tools` |
| [`core/agent`](subsystems/core.zh.md) | `Agent` 接口、活跃 agent 注册表和 `agent/*` 事件 | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.zh.md) | 实现该接口的默认驱动器 | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.zh.md) | 按 agent 划分作用域的注册原语 | 库，无 ctx 键 |
| [`llm/llm`](subsystems/llm-streaming.zh.md) | 消息与流式词汇表，以及适配器 seam | `ctx.llm` |

[原生创建事务](subsystems/core.zh.md#creation-and-ownership)等待未发布 setup，只 commit 一次，并在发布前持久化其剩余 Session 事件。可选同步 current 复核在持久化及发布等待后重新核验 setup；失败沿用原回滚与清理所有权。

<a id="events"></a>

## 事件

事件是扩展点；大多数改动从选择事件域开始。

- **会话事件**是追加到日志并通过 `session/event` 广播的持久事实。当某个事实必须在重新加载后仍然存在时，使用它。
- **Agent 事件**（`agent/*`）携带活跃 `Agent`：inbox、步骤、状态、请求、验证、续跑。要观察或拦截进行中的工作时，使用它。
- **能力事件**无需导入循环即可向某个 seam（`fs/*`、`tools/*`、`telemetry/*`）附加策略和适配器。

AgentLoop 在启动已排队工作前等待串行 `agent/created`，初始化失败则回滚。拥有者可调用 `ctx.agentLoop.stop()`，在图销毁前停止它持有的工作。清理期间保留所需资源；[agent-loop](../packages/core/agent-loop/README.zh.md#understand-the-implementation)定义顺序。

[事件映射](event-producer-consumer.zh.md)列出每个事件的生产方与消费方。

<a id="turn-flow"></a>

## 轮次流程

一个**步骤**是一次模型请求加上它调用的工具。一个**轮次**包含零个或多个步骤：它在领取首条输入之前打开，并在不再欠下任何工作时关闭。

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step; project runtime context at fallback
                                     reject | enter(messages, startsRequestSeries?)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     agent/request -> prepareCall (cancellation commits neither system nor users)
     reconcile system/message using the prepared call capability
     append entered messages as user/message; reconcile retained runtime context
     log request/header and request/context as needed
     derive and freeze model history from the log
     stream the bound prepared call -> llm/stream -> agent/assistant-stream start
       agent/assistant-stream chunk*
       assistant/message | assistant/attempt -> agent/assistant-stream end
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`system/message`、`user/message`、`assistant/message`、`assistant/attempt` 和 `tool/*` 是持久会话事件；其余是分属三个事件域的实时扩展点。`agent/assistant-stream` 发布进程本地 start、瞬态 chunk 与 end frame。loop 会在 committed end frame 前把完整紧凑 stream 提交为一个 message 或仅日志 attempt；Web Session-follow adapter 是该 live event 唯一的远程消费方。`agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件是 waterfall（瀑布式事件），其监听器必须调用 `next()` 才能委托下去；`agent/turn-stopping` 是 serial 事件，没有 `next()`。

Loop 的[静止条件](../packages/core/agent-loop/README.zh.md#understand-the-implementation)涵盖 driver、inbox 和启动活动。

输入通过同一个 inbox 到达驱动器；注入的上下文等待唤醒输入。持久 `inbox` 投影使待处理输入在没有活跃 Agent 时仍可读取。

`agent/pre-step` 决定接纳的输入。监听器可以改写或拒绝已领取消息；首次领取被拒绝或为空时，关闭不含步骤的持久轮次。enter 决策可设置 `startsRequestSeries`：循环记录新的 `request/header`（原因为 `series`，或在封装同时变化时为携带 `startsSeries: true` 的 `change`）。包装监听器通过 `{ ...decision, messages }` 保留该声明。组装与 `step/start` 之后，`agent/request` 和 `prepareCall()` 先解析实际路由，再提交系统提示词与已接纳用户消息；在任一异步阶段取消都不会提交这两者。提示词准入依据已准备调用的能力，而非先前的 `request/context`。每次尝试刷新已注册运行时事实、协调绑定的提示词、仅接纳一次用户消息并恢复被移除的运行时上下文、按需记录 header/context，再冻结请求并通过绑定调用发起流式请求。重试不重复组装或 `agent/pre-step`。附接后的 surface 替换和图片省略决定开启新请求序列，包括恢复后的首次 pre-step 中发生的替换；未变化的恢复延续序列。首次接纳的步骤在用户消息之前预留系统头节点，即使提示词为空（不产生协议消息）。提示词仅通过 `system/message` 历史传递：空渲染文本清除所有生效的系统节点，模型不再看到旧提示词；具备能力的路由可在缓存前缀之后追加非空更新，包括同时发生的受支持工具更新；不具备能力的路由与新请求序列将非空提示词文本归并到首个系统节点，并为非空的后续系统节点记录空内容替换（[决策](../.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.zh.md)；[决策规则](../packages/core/agent-loop/README.zh.md#understand-the-implementation)）。

循环发送不可变请求，同时保持取消有效，仅对完全冻结的对象复用冻结证据；[agent-loop](../packages/core/agent-loop/README.zh.md) 负责请求构建与取消原因。

失败步骤会[记录缺失的工具结果](../packages/core/agent-loop/README.zh.md#understand-the-implementation)。

详情见[时序图](agent-lifecycle.zh.md)、[工具流水线](tool-execution-pipeline.zh.md)和[取消与错误恢复](subsystems/core.zh.md#the-agent-handle)。

## 会话日志

会话日志是模型所见上下文的来源。`deriveMessages()` 从中投影出模型历史。每个 `assistant/message` 都嵌入产生其组装内容的精确紧凑带时间 stream；`assistant/attempt` 保留已到达 settlement 的失败、重试、取消与 stream error attempt，且不添加模型历史。fork、恢复、transcript（文本记录）、遥测与持久化都从这些持久 settlement 派生，实时 UI 增量则来自 `agent/assistant-stream`；如果进程在 settlement 前硬中断，则不会留下持久 attempt stream（见[决策](../.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.zh.md)）。

Session 消费方只了解当前逻辑格式。仅 header 的 `stat` 与 `list` 会重新扫描每个 Session 目录，选择数值最高的规范 generation，并在不加载事件或发布后继的情况下转换受支持的历史 header。已存储 Session 的 `open` 选择同一 generation，拒绝未来版本，或只 Decode 并组合一次构建时静态确定的相邻迁移链，再返回经过校验的当前逻辑事件。只读 open 直接使用这份内存结果，不发布后继；写 open 则先编码、校验并在未改变源的旁边排他发布最终版本命名的后继。未被后续事件封住的普通中断尾部仍由句柄消费方修复；只有在后续 `turn/start` 已经封住一种有限的已发布 restart 时，migration 才会插入缺失的 interrupted `turn/end`。JSONL v0 使用 `session.jsonl[.zstd]`，v1 及后续版本使用小写 `session.vN.jsonl[.zstd]`；已提交 generation 路径绝不重命名、替换或删除。JSONL provider 负责物理 framing、压缩、generation 选择与排他发布，每个相邻迁移包只负责一个 `vN -> vN+1` 步骤（[决策](../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)）。

**模型可见即已记录。** 每个模型请求都必须能从日志重建。新增模型可见输入需要会话事件。修改现有消息内容的插件注册[纯消息投影](subsystems/session.zh.md#plugin-owned-message-projections)，独立读取器显式传入相同的处理器。 工具变更不依赖能力；[Session 工具历史](../packages/core/session/README.zh.md)提供提供方声明。

**投影 seam。** `dsh-session-projection` 提供 `ctx.sessionProjections`：已注册单元增量折叠已提交事件，host 消费方通过 `stateOf()` 读取单个类型化状态，载体通过 `snapshot()` 批量取得裁剪后的客户端视图。host 读取方要么在激活时要求该服务，要么在注册表或必需 key 缺席时明确失败。贡献方可以保留 `ctx.inject(['sessionProjections'], ...)` 注册，但不能为缺失的 host 值静默提供默认值。agent loop 为读取方注册共享的 `turnBoundary` 状态（[决策](../.agents/notes/implemented/architecture/2026-08-19-session-projection-mandatory-seam.zh.md)）。

[工作目录](subsystems/working-directory.zh.md) 提供用户上下文和执行路径，不改变原始项目标识、沙箱写入根目录或已有进程目录。

## 能力 seam

**seam** 是一项可替换能力：**Service Definition** 声明接口，**Service Provider** 实现接口，**Consumer** 使用它，通常是面向模型的工具。包可以合并角色；单一角色不是 seam。添加能力时须一并设计三者（[能力图](capability-seams.zh.md)）。

替换一个提供方即可改变产品。文件系统与进程提供方共享同一个执行世界：指向远程沙箱时，Bash、PTY 和 LSP 一并迁移，无需提供方专用 fork。[subagent 提供方](subsystems/subagent.zh.md)通过同一接口支持新建子 agent 和委派其他产品中的轮次。

[实验性 Agent Teams](subsystems/agent-team.zh.md) 通过显式启用的 `ctx.agentTeams`，在可继续 subagent 之上提供持久 roster、任务状态和直接 inbox 消息协作。

## 新行为的归属位置

把行为附加到已有文档记录的扩展点；改动循环时更新本映射。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册其适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册；其 schema 加入提示词组装 |
| 让某个会话拥有不同的能力集合 | 组装一个 agent preset；其中的服务行需要 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端通过 `ctx.subprocess` spawn 进程 |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端和 `dsh-tool-terminal` |
| 添加用户命令 | 在 `ctx.commands` 上注册；它无需模型轮次即可分派 |
| 管理后台任务 | 在 `ctx.jobs` 上注册；`job_*` 工具读取或停止任务 |
| 从外部 webhook 启动 Session | 在 `ctx.webhookRuntime` 上注册可信规则，并挂载提供方适配器 |
| 添加文件系统访问或策略 | 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件 |
| 限制所启动的进程 | 使用 `ctx.sandbox` 后端；消费方在启动进程前包装 argv |
| 拦截请求、工具或轮次 | 使用相应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 会停止轮次 |
| 添加模型可见上下文 | 调用 `agent.inject()`；它会落到下一次获准的请求中 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加 Web Client Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` 提供方 |
| 管理同会话目标 | 使用 `ctx.goals`；通过 `agent/*` 续跑 |
| 在轮次边界 fork 会话 | `ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })`——只有经 agent-loop 发布的会话才会持久化 |
| 在新后端存储会话 | 基于共享的句柄脚手架实现 `SessionPersistence`（`create`/`open`/`stat`/`list`/`export`） |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

[扩展实操手册](cookbook/extension-cookbook.zh.md)将功能映射到能力，并索引[包](cookbook/adding-a-package.zh.md)、[工具](cookbook/adding-a-tool.zh.md)、[LLM（大语言模型）适配器](cookbook/adding-an-llm-adapter.zh.md)和[设置页](cookbook/adding-a-settings-card.zh.md)的分步指南。[Conversation 子系统](subsystems/conversation.zh.md)负责 Chat node 组装。
