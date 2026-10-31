---
description: "面向云端装配维护者的 runtime 参与者登记、本地容量限制及不可变账户代际输入说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-runtime

[English](README.md) | 中文

<a id="summary"></a>
## 概述

本包通过预期 epoch CAS 保存 PostgreSQL 账户归属，记录进程登记观察，拒绝不完整的排空参与者登记，并限制本地装配和排空预留。它提供云端 provider 共用的不可变代际输入及实际工作证据类型。账户入口要求私有工厂交接，不从配置接受账户身份。领取 owner 仅返回 mounting 元数据，不发布可用账户图。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

根 Loader 入口为 `/root`，包入口重导出其具名 `name`、`inject`、`Config` 和 `apply`，没有 default 导出。具名 `PeAccountRuntime` 类仍可用于容量/参与者组件装配，其 `Config` 只解析容量。`/account` 仅接受空配置，拒绝身份或其他 JSON 字段，并核验私有工厂安装的不可变 `peAccount` 贡献。`/types` 提供共享数据声明，`/schema` 分别导出容量与完整根部署解析器。

### Configuration

组件要求下列三个限制均为正安全整数。实际 Loader 入口还要求 [Host 部署 schema](src/root-config.ts) 的全部字段；只有容量的配置不能启动根控制面。两者均不推断部署默认值。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxMountedAccounts` | 必填 | 账户槽位，以及在途/未知 owner 写入责任记录的上界。 |
| `maxConcurrentMounts` | 必填 | 尚未实际结算的装配操作。 |
| `maxConcurrentDrains` | 必填 | 尚未实际结算的排空操作。 |
| `subagentCapacity` | 省略时关闭子级预留 | 显式的 `maxActivePerAccount`、当前 Root 实例的 `maxActiveTotal` 与实际子级 `maxDepth` 硬上限；独立于原生 subagent Settings。 |

实际根配置包括 `recipeVersion`、`internalAddress`、明确的心跳/启动/停止/账户观察预算、凭据解析时间和字节限制、PostgreSQL 连接字段及 `passwordRef`、有限 `pg`/`factory`/`saves` 容量、规范化的共享/本地路径，以及固定原生配方位置、必需条目和诊断上限。根要求正式 `credentials` 服务，先预检引用，再为每次实际 PG 连接重新解析；不读取 `process.env`，不使用账户凭据提供者。等待被放弃后，解析仍计入容量直至实际结算。

函数入口创建唯一既有容量持有者、PG executor、进程登记组件、owner store、账户 factory 和 API 配置保存 coordinator。它先迁移两张控制表并登记生成的进程身份，再提供 active 根控制面。初始化不等待下游 files/execution 贡献；参与者检查归账户领取，避免 Loader 注入环。原生准备期间，factory 从精确安装的 binding 签发该 coordinator 的屏障，并在实际保存及其余账户排空检查完成前持续持有。

`controlDatabase(participant)` 向精确登记且实现 `closeRoot()` 的根拥有者提供不可变参数化查询能力，共用 runtime 的有界 PG executor；不暴露凭据、目标选择或驱动关闭权，也不向账户图提供数据库能力。根关闭先等待账户排空和保留的根工作结束，再关闭 executor；参与者撤销也等待其实际根关闭。关闭待定或失败时保留登记和数据库责任。既有借用者可在排空期间完成清理；撤销完成后的查询在提交前拒绝。`wasNotSubmitted(cause)` 仅识别实际适配器已结束且未提交 SQL 的错误，不引入对 Host 实现的依赖。

`locateAccount()` 读取实际 PG 元数据；`acquireAccount()` 在领取 owner 或创建原生图前要求当前配方已封口，再用根选定输入进入保留型 factory。`borrowAccount(binding)` 要求配方封口，并为登录 Peer 独立借用精确的 ready 代际；它不会领取 owner、装配账户或替换为较新的图。`assertMountCurrent()` 检查已安装的准备期/当前身份；`assertBusinessCurrent()` 还要求配方封口和 factory 的 ready 状态。根控制面 active 或原生 mounted 均不发布账户 ready。

Provider 经根服务登记必需的 `files` 和 `execution` 参与者。登记归调用 fiber 所有，重复项会被拒绝。缺参与者时拒绝装配容量预留；通过此检查不等于配方封口。配置保存使用 API 单独持有的屏障，不是第三个参与者。

账户工厂持有容量预留，直至实际工作结算。`settleMount()` 释放并发装配槽并保留账户槽。装配或排空仍持有账户时，`releaseAccount()` 拒绝释放。请求超时不授权这两种释放。根卸载先关闭新准入，并等待实际控制清理后再关闭容量。观察过期会报告不确定状态并保留实际关闭 Promise。

### Root recipe admission

`sealRecipe()` 核验实际 Root Loader 条目、原始模块 namespace、唯一服务实现及其所属 fiber、API provider 持有的精确冻结 manifest，以及 files/execution 登记与实际 provider 的对应关系。它检查原生配置快照和 provider 健康状态，不接受 ready 标记。认证健康还要求实际 ingress 保持已安装且当前有效；仅资源初始化不能满足 Root 准入。11 项角色目录固定入口作用域：5 项在 Root 激活；账户、Session 和客户端角色仅声明各自图的作用域，不为此审核而激活。

`inspectRecipe()` 返回冻结的计数和有限问题标识，不暴露路径、凭据或 provider 对象。Loader 变化、provider 替换或关闭、参与者移除、显式 `revokeRecipe()` 及 runtime 关闭都会使保留的审核失效。`assertRecipeSealed()` 要求完整审核及原始 files pool/storage owner 持续有效。缺少实际存储仍以 `storage-root-capability-missing` 拒绝。既有 AppReady 回调在原生启动成功后尝试完整审核；该通知自身不授予准入。

AppReady 缺失、封口尝试正常返回或拒绝时，Root 还向 stderr 写入原审核的状态、计数及固定问题码。首次转为 revoked 时，还记录固定事件、进程 id、先前状态及内部原因；provider 身份或健康检查拒绝时，只附带固定 provider key。不记录配方配置、版本、错误或路径。日志失败不改变原封口、启动或拒绝结果。

有界 `ordinary-profile-ready` info 事件仅在原 `onReady` 回调成功完成配方封口后产生，只证明普通 Root 启动，不宣称所有账户均已 ready，且不含 Key 或数据体。

### Account policy

实际 Root request 向 Controller、AgentLoop 和 LLM 准入提供同一套项目/model/Preset 策略。必需的 `accountPolicy` 字段选择精确部署数据；这些字段本身不开放业务准入。

| 字段 | 含义 |
| --- | --- |
| `maxModelRoutes` | 非空 `models` 列表的正数有限上界。 |
| `models` | 唯一且精确的 `{provider, model}` 对；不推断 provider、model 或通配符匹配。 |
| `maxPolicyStringBytes` | Provider/model、Preset id 和两个原生 entry id 的正数 UTF-8 上界。 |
| `presetId` | 唯一批准的原生 CloudPreset，且须为配置的默认值。 |
| `presetEntryId` | 实际 Loader 声明，由原生 `agent-preset` 实现。 |
| `agentLoopEntryId` | 实际受保护的原生 AgentLoop 入口，其启动 agents 保持为空。 |
| `presetConfigSha256` | 可信已解析声明的规范 JSON 摘要，精确为 64 个小写十六进制字符。 |
| `maxPresetConfigBytes` | 规范 UTF-8 摘要输入及遍历的正数上界。 |

声明摘要使用 SHA-256、排序后的对象键和原数组顺序。函数、JS 表达式、非 JSON 对象和别名均拒绝。有界编码器在遍历期间拒绝超量输入。批准还要求原始 ACTIVE Loader 条目、未变化的原生配置 plan、实际 Preset inventory，以及 Agent 保留且无服务泄漏的组合。

业务回调从同一原生 Registry 选择原始 Workspace。`project()` 仍只表示 bootstrap 默认项目；显式 create 请求可选择另一个已登记 Workspace。历史、prompt 和 resume 在读取私有 Session 前要求唯一原始成员关系，并保留完整 persisted header、投影、目录和固定 Preset 校验。显式创建仅接受账户 Registry 中非成员 id 的原生 notfound；成员日志缺失及其他查询错误继续传播。独立账户可在各自存储创建相同 SessionId。普通 JSONL 冷恢复保留 SessionId；导入/分叉身份仍被拒绝。下述可选原生 child 路径单独核验 subagent 身份。精确模型路由要求原始已登记 provider，并通过原生模型解析及 await 前后 current 检查。Guard 构造不读取未完成的 files 项目。

在撤销账户 graph 前，账户 stop 关闭云端 Office 准入，等待所保留的原生转换，再销毁原 provider。既有 `stopTimeoutMs` 限制对此工作的观察时间；到期不会中止或释放所持有的真实关闭操作。转换临时目录、转换器销毁未确认或 provider 意外卸载会使 stop 拒绝，由现有 factory 将账户槽保留为 unknown。迟到完成不能恢复准入或释放该账户。配置空闲检查包含所保留的转换及未知 Office 清理。

显式选中的原生 `officeToPdf/render` invocation 使用与 `workspaceFiles` 相同的 Session 成员及项目选择，不授予原始绝对路径权限。账户 Office provider 和两个原生 Remote 方法必须在发布前通过 API 清单审核。

账户持有的 `workspaceFileScope` lookup 在读取冷持久化 header 前检查原 Session 成员关系；未知、外账户及未挂载的 ID 不触发该元数据读取。lookup 使用账户生命周期，并在观察后复核原 provider。

唯一账户 FS 接收惰性的共享选择回调。 原 `workspaceFiles` invocation 先按所选 RPC/stream 类别经原 API owner 准入，包含当前唯一的原生注册检查；未选中或已撤销的注册在共享项目选择前拒绝。原生工具调用要求精确已发布的 Agent、Session 和成员关系，带 scope 标记的调用方，其不透明 scope key 必须属于该 Agent 保留的原生 scope 链；共享账户服务可以没有标记，仅继承因果父 Agent 不授予带独立标记的子 Agent 文件访问。原生 `workspaceFiles` 调用使用原 invocation 的 SessionId。冷文件选择先核验成员关系，再只读取实际持久化 header，检查固定 Preset 及当前 owner，不加载完整 Session 消息，也不以目标路径授予项目权限。返回的 selection 继续核验同一原始 Workspace、owner 和成员关系。文件调用没有可变 active project 或默认回退。

同一策略通过惰性闭包提供 API 的只读 bootstrap 断言。 若选中任何 `workspaceFiles` 端点或 `officeToPdf/render`，它还会在异步检查前后要求原 Files owner 的 `assertContentAvailable()`；仅具元数据能力的 S2 无法通过启用文件端点的 ready 检查。未选择文件端点的配方保留原先前提。Root 将既有 `native.maxEntries` 作为选中开放清单条目及实际遍历的原生 runtime/fiber 的共享上界，不新增部署值或默认值。它核验原 Workspace、固定原生 Preset/default/composition、当前默认模型元数据和实际 native handler，并在 await 后复核 provider 与选择。它不准备目录、不创建或恢复 Session/Agent、不解析凭据，也不请求模型推理。构造不读取未完成的 files 项目，不捕获请求级 `AccountUse`。该断言不替代生产存储交接或 Root seal。

可选 `native.firstScreen` 选择固定只读首屏切片。提供时，`maxHomeBytes`、`maxCollectionItems`、`maxFrameBytes`、`maxQueuedEvents`、`maxQueuedBytes` 均须显式为正数、有限安全整数；省略时保持关闭，不补默认值。Root 通过配方传递原始预算，并从同一账户的规范 Profile 得到预期 home，在原生 boot 前核对一致。既有 `native.maxEntries` 继续限制原生 owner/marker 清单。元数据或配置条目名称不能满足实际 prepared 审核。

私有 builtin 只提供受守卫的 Workspace/Settings 构造器和保留的原事件注册 Loader scope。构造器不读取未完成的 files 项目。Unpublished bootstrap 先取得实际 files project，要求原共享 Session 只读策略，向真实 Gateway 注册事件源，再执行 `auditPrepared`；business-ready 发布及之后的 `assertBootstrapCurrent` 仍独立。共享策略允许在 Workspace 关联前检查实际 live Session/Agent 元数据，按原 Workspace 关系核对冷列表元数据，不新增 Session 库、成员缓存，也不从 id/cwd 签发 ProjectScope。Stop 先等待事件撤销，再调用原 `AgentLoop.stop()`、检查原生 idle 并刷新持久化。源或 disposer 失败仍为未确认，不能证明 clean release。Integration 将既有 `maxQueuedEvents`、`maxQueuedBytes` 和 `maxFrameBytes` 同时交给受守卫 reader 与原 Gateway 注册。Reader 捕获这些值，供原 protected control-buffer hook 使用；每个原生 control 代际和事件 client 都沿用原有界队列。下游慢读超限只终止对应流，实际 source 失败仍保留既有审核撤销与未确认清理语义。不增加配置字段、预算默认值或队列。

原生权限控件要求实际签发的 execution port 强制 Session 文件策略，并从同一 port 派生 Files 的强制选择。原权限服务、目录、`/permission` 命令与默认设置继续作为权威；云端配置表只包含 read-only 和 workspace-write，两者审批均为 `never`。切换前，原 owner 检查保留命令、unknown 结果及 service 工作，Runtime 核验实际存活的 child 所有权。只读委派不能在 child 准备或后续权限切换时扩大。选中模式沿用原 Session 事件，不新增权限数据库、进程服务或更大的账户配额。

原 files 持有者存在时，账户图准备还会创建图内的 `AccountInstructionSources` 服务。其回调复用共享活跃 Agent 的项目、模型与 Preset 检查，并使用 files 持有者的独立来源 reader 和完整快照预留。固定 Preset 通过已准备的 builtin 加载原 `/session` 命名空间。适配器准备不启动来源 I/O，缺少该 Preset 配置行时也不启用指令。

可选原生 child 装配让 `SubagentRuntime` admission 与唯一云端工厂共用同一策略。在等待前后，它核验精确 live parent、原 Workspace、当前目录、批准模型路由，以及原生 Preset generation、模块 namespace 和所属 fiber。原生 Workspace 成员关系在 setup commit 前持久化；cold resume 核验同一原历史。当前目录批准仅限选中的 Workspace 根。显式 `subagentCapacity` 同时选择原 AccountFactory 资源回调；省略时 child 入口继续关闭。回调在向同一 RuntimeCapacity 预留前，要求精确 ready 图及原生产 storage/native owner。unknown 同步关闭该 slot，并持有原 owner 的 quarantine Promise 和延后启动的原生排空。原 slot 等待其在途 metadata CAS 后再执行 quarantine；SQL 结果未知或响应丢失都保留所有权，不自动重试或清除。原生销毁在 settlement 当前轮次之后启动，保留调用者原错误。child 清理 confirmed 只释放其 child 预留；账户释放仍要求所有原排空证据。

工厂通过共享策略的 `withChildPreparation` 包裹原 child setup；缺失时关闭 child 入口，普通 root 保留原 setup。准备记录绑定精确的未发布 child、parent、原生 scope 和 Workspace，并返回同一个冻结的 `directoryPreparation.assertCaller(caller)` 对象，原样交给 Files 核验受限目录。Files 必须执行该 selection 的操作限制，它不授予普通文件访问。取消或 scope 关闭即拒绝新操作，setup 实际结算后在原完整 `prepareChild` 与发布检查前撤销 selection。实际 setup、Files I/O 和 child 预留仍由原 owner 持有，不以额外 timer 或停机预算替代其结算。

原生 generation 审计核验 Loader Entry 的规范根 fiber。插件和注入 fiber 若从父 fiber 继承同一 Entry，不增加组合条目；所属根仍须通过精确的活动 fiber、模块 namespace、callback 与配置 plan 核验。

可选 `native.attachments` 显式提供 surface 节点、引用及元数据上限、prompt 和上传容量、上传预留及原生待处理收据数；省略时两个附件 builtin 保持关闭。保存返回后若账户选择复检失败，files 队列以未确认状态保留。原生流式文件发布失败若标记为未确认，会保留上传责任而不会报告为已确认拒绝；自定义回调吞掉或替换此错误不在该保证范围内。准备阶段选择唯一原生存储及 FileUploads 服务，将 Controller 可等待文件钩子委托给原来的同 Agent 收据。前置 pre-step listener 在 files 预算内收集有界原生 Session surface 与本次 claimed 消息，先于其他 listener 的路径计价和消费。最终原生 LLM 请求只能使用该准备集合，原始消息与持久引用不改写。两个同步路径映射均检查当前实际 Agent、项目与调用者。结果仅保留到该请求，拒绝、idle、销毁或 lifetime 结束时撤销，释放前继续占用原驻留预算。当前宿主文件系统将已验证副本映射为自身；后续沙盒 backend 的相同文件映射须单独验收。

### Account layout

`/types` 声明唯一的 `AccountLayout`，包含共享 private/Profile/patch、凭据、Session、storage、附件原件、技能、指令、项目、环境及进程本地 Session 索引地址。`AccountMountInput` 将这些地址与既有 binding、启动 InstanceId 及原生 `LaunchEnvironmentSnapshot` 配对。这些是可信装配数据；路径不授予目录访问、ready 或配额证据。凭据只交给需要的原生消费者。

私有[地址 helper](src/account-layout.ts)接受显式、词法规范的 POSIX 共享根/缓存根及正数有限 UTF-8 字节上限。它先限制字符数，再扫描 UTF-8，并核验每项输出。固定 v1 域及明确字节长度框定认证 id 的精确字节后作 SHA-256；不将原始 id 或标题用作目录片段。共享路径跨 epoch 和进程重启保持稳定，只有可重建本地索引含启动 InstanceId。

默认项目候选使用固定的 `default-workspace` basename，保留原生标题处理。是否初始化仍由原生资格、历史复查及默认删除标记决定。新项目候选使用一次服务端 UUID；调用方在实际准备期间保留该候选。Helper 不创建目录或 Workspace 记录。真实父目录保护、FD 能力、配额及当前代际检查归 files/部署与 runtime 生命周期持有。

### PostgreSQL owner storage

私有 owner store 接受根持有的 PostgreSQL query adapter 及服务端生成的实例身份。该实现归包内账户工厂持有，不是导出的账户管理 SDK。Adapter 绑定参数，并限制连接、statement 及 query 预算。`migrate()` 执行 `pe_account_owners` 的原子 DDL；并发迁移在 PostgreSQL 内串行，既有字段或约束不兼容时拒绝，不重置记录。

私有 [pg 适配](src/owner-pg-executor.ts)使用 `pg@8.16.3`，每个连接仅执行一条语句，不使用隐藏连接池。显式构造参数限制连接、排队提交、队列/连接/服务端 statement/锁等待时间、被观察的实际 Promise 及并发等待者；实际根要求在 `pg` 下提供同样的值。`ClientConfig.query_timeout` 为零；pg 共享 query-timeout 默认值非零时，在创建连接前拒绝。Query 持有槽位直到真实 driver 结算且连接结束；连接不复用。服务端 `statement_timeout` 限制执行，已提交写入失败对 store 仍属于结果未知。

`observe(actual, deadlineAtMs, signal)` 只限制本次等待。超时/取消移除该等待者，并在实际 Promise 结算前保留唯一且有界的结算订阅。它不拒绝实际 SQL，也不释放连接。`close()` 关闭准入并拒绝从未提交的排队 SQL，随后持有同一个关闭 Promise，直至全部已启动连接结束。只有可信 adapter 确认的提交前失败才允许 store 丢弃该在途写入责任；SQL 从未发送时，队列耗尽、过期及连接初始化失败不会隔离该账户。

`claim()` 对不存在的行要求 null，对 unowned 行要求精确旧 epoch。parked 行仅可由保留的实例领取。每次成功领取递增保留的 bigint epoch，并返回 mounting 元数据。相同的本地在途领取共享一次数据库 Promise，数量受 `maxConcurrentMounts` 限制；账户工厂仍须合并完整图装配。Heartbeat 只更新观察时间，不授权接管。

私有工厂只有在实际图、provider、保存及暴露清单审核成功后，才能调用 `ready(expected, recipeVersion)`。CAS 只接受账户、进程实例、epoch 和配方精确匹配的 mounting 元数据；旧代、重复或不匹配提交均拒绝。它不执行这些审核，也不发布 `AccountUse`。已提交写入失败时保留未知结果责任。

`beginDrain()` 接受 ready 图或 mounting 图的已知清理，不发布 ready 或解除隔离。之后，`release()` 和 `park()` 要求完整且匹配的 runtime 证据：原生 idle、配置保存 confirmed、两个参与者 confirmed、持久化已 flush、Context 已 dispose 且无销毁错误。匹配但不完整的证据改为隔离 owner。隔离态没有普通释放或领取出口。Store 保留 unowned 行，不删除或重置 epoch；epoch 从不转为 Number。

被拒绝的 mutation 可能已经提交而结果未知。Store 保留该账户及尝试的 epoch，关闭该账户后续写入，并允许读取状态，不重放或自动解除未知。其他账户继续受正常 CAS 及容量规则约束。每次 mutation 前预留责任记录；未知记录保留在配置上界内，耗尽时拒绝新观察，不丢弃旧记录。迁移失败使整个 store 保持关闭。完整 runtime 必须经可信生命周期完成对账；构造存储 adapter 不代表获准恢复。

崩溃恢复是独立的私有操作。构造器可选捕获接手实例固定的 `local-original-process-and-provider-v1` verifier 及显式 proof/审计上界。Root 提供只读 callback，核验受保护的核验发布物及当前 kernel/进程事实；`recoverReleased()` 的调用者只传精确旧账户、instance、epoch 和稳定审计引用。缺少 authority 时恢复关闭。`migrateRecovery()` 显式调用，并要求原 owner 与 execution allocation 迁移已完成；它新增版本化 `pe_recovery_audit` 和固定的 invoker 权限 SQL 函数，不改原 owner 数据。

Verifier 必须证明旧进程真实死亡、writer 失效、全部分配销毁，以及 late-create/spawn 永久失去生效能力。返回值包含有界证据引用、旧 epoch 全部保留 allocation ID、`databaseRole` 及在进程死亡后签发的 `writersVerifiedAt` 截止时间。固定 PostgreSQL 调用锁定审计容量与 allocation 写入，拒绝任何非终态或未覆盖分配，复核 `current_user`、同角色旧 client backend 及同角色 prepared transaction，然后在同一原子操作中只把精确 ready/draining/quarantined/mounting owner 改为 unowned 并写不可变审计/后镜像。epoch、recipe 不变，普通下一次 claim 才递增 epoch；不伪造正常 flush/dispose 收据。

成功审计引用的重复调用先只读检查，不再调用 verifier，也不重放 SQL/provider 动作。历史审计的后镜像若已不再匹配当前 owner，只作为历史结果。提交/解码未知时保留原有有界 owner-write 责任；`inspectRecovery()` 只读精确审计和当前后镜像，不重试、不自动清除此责任。Root 负责后续责任解除、实际 allocation 对账、启动/入口集成及另行限定范围的旧实例关闭。heartbeat 或单账户 proof 均不授予整实例关闭权限。

`closeRecoveredInstance()` 是另一个私有 CAS，锚定同一精确账户审计、旧 instance 和 epoch。它再次核验选定 proof，锁住全部 owner 写入，要求审计账户在该 epoch 仍为 unowned，且不存在任何指向旧实例的 owner。旧注册行的地址、recipe、registered 阶段必须精确匹配；已匹配 closed 后镜像时幂等返回。`inspectRecoveredInstance()` 提供精确只读对账；关闭结果未知时保留同一有界账户/epoch 责任。Root 必须保持普通准入关闭，直到两步恢复及维护 CLI 关闭均已结束。

现有 Root 入口仅在维护装配中接受显式 `recovery` 配置，关闭 acquire、borrow、mount 与业务准入，并只通过原执行 drain participant 登记选定 verifier。恢复复用原 owner store 及其保留的未知写入责任；普通 Root 不提供恢复 port。维护进程必须等待实际对账完成并关闭，之后才能恢复普通启动。

### Process instance metadata

私有[实例组件](src/instance-control.ts)在 `pe_instances` 保存启动身份、可信部署地址、配方版本、观察阶段及 heartbeat 时间。其原子迁移遇到不兼容字段或约束时拒绝，不重置记录。组件在内部生成并冻结身份；持有者在每次 Node 启动时构造唯一组件，并将同一个身份交给 owner store。构造器不接受外部提供的实例 id。地址是不透明的部署元数据，不用于选择网络目标。

登记合并相同的本地调用，遇到已有的持久化 id 时拒绝，不覆盖其元数据。单行读取区分行不存在、读取失败及无效结果。Heartbeat 仅更新组件自身的 registered 行。`registered`、`closed` 或过期 heartbeat 均不代表账户 ready、进程死亡或获准回收 owner。实例操作不修改账户 owner 或 epoch。

每个组件最多持有一个实际 mutation。Close 关闭本地 mutation 准入，等待实际 schema/登记/heartbeat 工作，然后仅将自身登记标为 closed；账户排空及共享 executor 关闭由根单独持有。等待复用 adapter 的有界观察，不结算实际 SQL。已提交结果未知会保留类型化责任，读取或观察超时均不自动解除或重放；其他组件仍可继续。只有确定的提交前失败允许显式重试，重试 close 仍保持本地准入关闭。 仅当原实例组件确认已结算的 `heartbeat`/`not-submitted` 失败时，Root 调度器才按既有间隔再次发起心跳。既有登记及 owner 守卫保持原样；PostgreSQL owner 读取及新领取 CAS 保留原调用者检查。停机等待正在执行的心跳，不把该已确认零提交的拒绝保留为清理故障。未知、已提交、冲突及观察超时仍撤销 Root 准入、保留实际工作，且不自动重试。固定 stderr 记录只报告操作、结果和代码，不序列化错误、凭据或部署地址；此行为不能重新激活已撤销的 Root。

普通 active Root 向可信 Host 装配提供 `ownerResolver?.resolve(accountId)`。该 facade 通过原 owner store、实例 registry 和 `PgOwnerExecutor` 执行 owner → instance → owner 单行读取；元数据缺失、非 ready、已停止、不一致或变化时拒绝。它保留十进制字符串 epoch 和原读取失败分类。完整读取链共用现有 `pg.maxConnections + pg.maxQueued` 上限，不增加队列、缓存或重试。Root 关闭立即撤销 facade，并在既有实例及 executor 关闭前等待实际读取结束。组件、维护及已停止 Root 不提供它。返回的记录对只是经过复查的观察，不是原子快照、`AccountUse`、ready、恢复或网络准入；原 owner 仍须为每个业务操作重新核验。

`activeInstanceId` 仅在普通 Root active 时读取原 startup identity；组件、维护、失败和停止 Root 不提供。可信 Host 装配可用它比较内部接收实例，`borrowOwnedAccount` 仍独立复查同一原本机身份。它不授予账户准入，也不属于公开 bootstrap 数据。

`borrowOwnedAccount(expectedOwner)` 仅借用本机 Root 已持有的原 ready 图。它核对原 active control、business seal 和参与者，读取与期望精确一致的 account／instance／十进制 epoch／recipe，再选择既有 factory binding，不领取或装配。返回前再次读取 owner 并核对 current；失败时释放已取得的 borrow。consumer 在工作结算后释放返回的原 `AccountUse`。`acquireAccount` 保留普通首次登录领取逻辑。

`registerIngressClose(owner)` 在认证或转发开始前，将唯一原 Access ingress 关闭 owner 保留在调用方 effect 中。`owner.closeActual()` 同步关闭 ingress 准入，并返回原实际 carrier／auth／pool 关闭结果；它不得等待 Runtime Root 关闭。撤销等待同一结果，成功后才允许替换。Root 关闭同步触发它，并按 ingress、resolver、既有 factory／participants／instance／executor 顺序等待。关闭失败或不确定时保留登记与 Root 责任，不能报告 Root 已干净关闭。该登记独立于 drain participants，不授予 seal、数据库、账户或恢复能力。

-----

显式的获批 Settings 字段策略要求 `native.firstScreen`，并复用模型 Key 和 skill 操作使用的原认证 consumer。Runtime 将不可变的获批字段交给共享原生 Settings 适配器；每次保存仍由原生 schema、revision 和 none/live 更新计划决定。即使仅选择此策略，也接入既有可变保存隔离路径；不新增 participant、owner 或队列。

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部机制 — 点击展开</summary>

每个根独立持有参与者表和容量计数。每个独立账户根接收冻结的 binding，其中包含无精度损失的 epoch 字符串和图 lifetime。内部交接拒绝子 Context、仅结构相似的对象和已结束的 lifetime；没有公开构造器将浏览器 JSON 转为 binding。原生队列、Session、设置及执行状态仍由各自包持有。

[根服务](src/root.ts)、[PostgreSQL owner store](src/owner-store.ts)、[容量记录](src/capacity.ts)、[私有 binding 交接](src/binding.ts)和[共享类型](src/types.ts)定义已实现行为。[组件 Loader 测试](tests/runtime.spec.ts)覆盖容量/登记输入；[实际根测试](tests/root-control-postgres.spec.ts)使用单独分配的 PostgreSQL 数据库验证函数 Loader 的迁移、登记、心跳、factory 拒绝及关闭；[PostgreSQL 测试](tests/owner-postgres.spec.ts)在显式指定的测试库执行 CAS 及迁移场景，排空证据使用测试夹具。

私有[原生 Profile 适配](src/native-boot.ts)通过公开 app boot 创建独立根，在 `prepare` 中提供复制的 ProfileContext、显式启动环境及不可变 binding，并且只装配一次 root Include。所有保存/files/execution port 均须在 `prepare` 内使用同一个已安装 binding 构造、核验及注入，并保留其图 lifetime。等待 setup 完成后，prepare 在返回 boot 前再次核验已安装代际的寿命及关闭请求。若 setup 期间代际结束或收到关闭请求，不启动任何 Include entry，并继续等待实际清理。已装配图仍由 runtime 驱动销毁。它不安装账户 CLI、信号处理、代理、watcher 或代码 HMR。调用者必须先核验真实根能力和固定配方。装配结果仅说明原生装配完成。适配持有 boot/disposal Promise，并有界观察错误，覆盖部分启动和异步 disposer 失败；错误或观察溢出均阻止原生销毁 confirmed。该观察不代表业务工作排空或账户 clean。

工厂与原生 boot 及准备期审核共享[私有启动观察器](src/startup-observation.ts)，每次启动最多尝试输出一条 stderr JSON 记录，上限为 512 UTF-8 字节。`cloud/startup-failure` 表示捕获到的启动失败；`native-error-event` 和 `observation-expired` 分别表示既有原生 error 日志及原装配等待截止，后二者均不能认定启动失败。记录只包含固定阶段、可选的已批准入口 ID 及最多三层白名单 code/name 原因，不读取错误 getter、message 或 stack。观测失败保留原结果、清理、ready 判定及容量预留。

通过原 logger 的 debug 设置启用有界 owner 观测。Factory 报告其保留的账户 Context；`workspaceRecords` 统计该 Context 的公开 Registry 投影，读取时的分配随 Workspace 数量增长，不测量私有缓存或堆。Registry 不可用时保留未知；原生 dispose 已确认后，保留的根 fiber 仍可能为 ACTIVE。仅凭根 fiber UID 无法识别账户图。观测不授予 ready 或释放权限。记录不包含凭据、原始 C02 generation、消息正文或路径。

私有[装配桥](src/account-mount.ts)将 Profile 目录、patch、home 和默认项目候选与唯一布局核对，并把同一个原生 `LaunchEnvironmentSnapshot` 对象交给 boot。私有[工厂](src/account-factory.ts)为每个账户保留一次实际操作。即使每次创建新的 request 外壳，只要账户/实例/配方值及可信资源引用一致，调用仍会合并；不同 binding、配方、环境或部署输入会拒绝。有界、可撤销的等待者共享一次结算订阅；截止或观察者取消均不停止装配或释放其容量。

Factory 的[原生集成](src/account-native-integration.ts)在 Include 前创建公开 `CloudAccountApi` owner 并安装实际 Root 签发的 closed execution port。 固定私有 `ACCOUNT_NATIVE_ENTRIES.workspaceFiles` builtin 只在配方显式安装该入口时激活。它保留原生 WorkspaceFiles 的 Config 和全部 inject，额外要求 `peCloudApi`，并经原 API owner 构造不变的原生服务。配方须安装真实 sandbox-policy provider，显式选择部署模式和 fallback root；该 fallback 不授予项目权限。固定私有 builtin 消费 API 的原生 editor/credentials provider、Controller、AgentLoop 和 LLM guard。受限 files lane 构造原始 `CloudAccountFiles`，其 `/account` 入口持有原生 Registry/default/FS 安装。API 业务准入后，目录准备从原始已登记 Workspace 派生 `projectFor(workspace)`，并在 await 后复核 binding、owner 和 Workspace；新派生能力 wrapper 不要求对象身份相同。指令准备先选择 Agent 的 Workspace，再保留完整 snapshot 预算，并在 reservation 内使用同步共享检查。原生依赖可能在 files 初始化期间激活，必需入口检查与业务准入仍阻止不完整发布。缺 files 或共享 guard 时保持关闭。

原认证拥有者提供 Root Fetch 检查时，私有账户准备过程捕获该拥有者，只向 API 传入其只读注册回调。更换或撤回会拒绝下一次检查；账户图中不安装 Root 服务或 Context，此读取也不创建请求或分配。

API 目录显式选择 `modelKey` 时，Root 按有限批准的 provider/entry/module/ref bindings 在 boot 前屏蔽所有选中引用，将同一选择用于原凭据保存白名单，并捕获原认证 owner 的 `withModelKeyPeerUse` 回调。私有 `ACCOUNT_NATIVE_ENTRIES.modelKey` builtin 要求原生 Typert registry、credentials、Settings 和 LLM；配方须包含该入口及原生成 API Typert 贡献。只有 bootstrap 可在不发现凭据的情况下核验实际配置的批准 provider/ref/model，以便首次设置 Key；原生模型解析及分派仍检查凭据。保存结果未解决时同步关闭原槽并委派给 `stopNative`；drain 容量满仍保持准入关闭。原失败记录、图、保存 hook 及容量继续保留，不产生 clean 收据或释放 owner。

选中清单包含 `cloudProjects/create` 时，准备阶段要求原始 `borrowAccount` 回调。处理器检查 Root 和业务 current，借用精确 ready account，完整等待原 files owner 的创建，核验返回的原生 Workspace，并返回原生 WorkspaceValue。创建 Promise 结算后才在 `finally` 释放原 borrow，包含 abort 和错误路径。不选中该端点时无需创建 borrow。

普通 Factory 关闭时先关闭准入和图 lifetime，等待原保存屏障，调用原 AgentLoop 服务的终态 `stop()` 并保持其 fiber 及持久化 provider 已挂载，核对原 AgentRegistry 为空并 flush SessionPersistence，再撤回原生 hook 和销毁图。它等待剩余借用及实际 execution/files 参与者后才关闭原 storage lease。Clean owner 释放还要求 confirmed 原生销毁、保存和参与者证据，以及实际 PG drain/release CAS。工作或元数据结果未知时保留容量和归属；账户排空未知时 Root 继续持有控制资源。

装配容量随实际启动及已开始的原生清理结算。仅原生销毁不能证明完整排空，因此账户预留仍保留。工厂关闭外部准入时仍保留内部排空预留及原生销毁责任；清理未知继续持有排空容量。只有确定在 claim 前或从未提交的失败且没有原生资源时，才释放未启动账户槽。已提交结果未知保留原槽，不盲目重启。

实际根在配方未封口时于 PG 领取前拒绝 acquire。其私有 request 保留原 storage owner，以及原生集成消费的同一 coordinator、exposure policy、execution issuer 和[具体账户策略](src/account-policy.ts)。Factory 在任何 Profile/patch 或原生配置读取前取得原 storage lease，先记录规范的已安装 binding，再执行唯一一次 files bind，并在未发布阶段审核实际项目、closed execution 和原生 API。实际 ready CAS 前后均复核 Root、lease 和 binding。此后精确且有效的图才能签发 `AccountUse`；release 幂等且不 cancel Agent。独立 native-only 路径不授予 `AccountUse`。

批准的本地插件更新复用现有 factory slot 和 PostgreSQL owner 的 `ready → reconfiguring → ready` 转换，保持 root 与 epoch。关闭观察者或写配置前，真实 Agent driver、inbox、启动任务、持久化、files 和 execution 观察必须全部静止。保存屏障本身不能证明 idle。缺少 idle producer 时拒绝本地操作。已完整结算的 warm execution session 与被动 files lease 可以保留；在途工作或未知清理仍拒绝。Factory 在 PostgreSQL 转换后及原生修改检查点再次复核。终态配置复用完整 stop 路径。原生、保存、files、execution 实际结算并 flush 后，一次本地 hook 通过仍挂载的旧 writer 和已停止的保存 owner 提交已检查 intent，等待原生应用及清理后才撤回 hook、abort lifetime 并销毁。替代图申请新 epoch，按已持久化配置装配审核，不在启动时重写。固定请求及结果语义见 [API 策略](../pe-cloud-api/README.zh.md#understand-the-implementation)。 PostgreSQL begin 的可信从未提交拒绝，仅在原审核、保存确认及空闲检查通过后恢复同代；已提交的不确定结果继续封闭。终态重建仅在 drain 准入实际开始后不可逆；旧代已确认 clean release 且替代创建尚未开始时移除旧 slot，未知排空或新 claim 的责任继续保留。

私有 `scheduleConfigurationRebuild` 的接收结果还保留唯一 `completion` Promise。`ConfigurationRebuildReceipt` 仅在 `finishBootstrap` 内的替换 intent 核验及原 PostgreSQL ready CAS 完成后，记录实际原生持久化结果和不同的替换 epoch。核验失败不授予业务准入，并拒绝保留的操作，不重放旧提交。该 Host 收据不增加公开收据查询接口。完整生产 storage、execution、files 和 PG 验收仍由集成负责。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [应用装配](../../../docs/architecture.zh.md)
- [原生 app boot](../../boot/app-boot/README.zh.md)
- [生命周期审核规则](../../../docs/defensive-patterns/general.zh.md)

-----

<a id="model-experience"></a>
## Model Experience

### Runtime admission

#### What the model sees

本包不贡献提示词或工具 schema，`AccountBinding` 及 owner 元数据保留在模型上下文之外。

#### Token effect

直接 token 影响为零；本地登记及容量错误不注入模型上下文。

#### KV Cache effect

本地容量记录不更改模型请求前缀或保留的 Session 历史。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

生产准入要求完整的实际 Root/存储/原生组合；组件夹具不能确立生产 ready。

显式的 `approvedConfiguration.skills.mode: managed` 使用原 files issuer 和登录 Peer consumer 安装固定原生 `pe-cloud-skills` 条目。它要求现有 legacy 发布限额及全部四项管理 API 限额；仅 sample 的装配会在领取 owner 前拒绝。Root 从原健康 files pool 读取已配置的 18 项物理 bundle 限额，并要求完整源与投影 helper 支持。策略或 helper 缺失时拒绝，不以 runtime 回退值扩大存储限额。同一原生技能服务在原 AccountSaves 回合中恢复完整持久目录，再暂停保存并进行最终清单审核。技能发布和模型密钥编辑均要求原工厂故障收容回调；unknown 保存继续保留该图原有责任。

资源加载在项目 I/O 前要求精确已发布 Agent、原 WorkingDirectory 和共享 Workspace 守卫。adapter 将当前 `withBundleSource` 回调内精确的 `snapshot.version` 租约传给原 files owner，准备项目父目录并投影完整树，保留可编辑副本。files owner 将持久副本版本规范化；返回以 Workspace 根目录为基准的绝对 `.pe/skills/<version>/` 指引前，由真实的单副本操作借用核验已签发对象身份。源、父目录、materialize 和 operation 结果在原 resident 预算中重叠保留。观察者取消不能在实际复制 I/O 结束前释放父借用；materialize 结果未知时保留父借用和原 files 责任。共享策略仍拒绝离开精确 Workspace 根目录的 cwd 变化。完整 Linux 投影、冷恢复及执行准入仍须集成验收。

- **账户工厂** — 生产链要求原 files storage owner、准备期原生审核及实际 PostgreSQL ready CAS。账户持久化恢复、认证 Web 和完整 Linux 配方仍须集成验收；组件文本回合或冷读取不授予生产 `AccountUse`。
- **根封口** — 原 files owner 必须直接复核受保护部署记录、当前 mount、写入者 namespace 及 bytes/inodes/private-reserve 上界。存储缺失或被撤销时准入关闭。非 Root 声明仍须在实际账户、Session 和客户端装配中核验。
- **布局接线** — 私有原生桥已核对 layout/Profile 一致性，但布局数据不能创建 files 能力或验证存储。已包含 environments 父根，尚无按 Session 的环境派生。
- **数据库集成与恢复** — 实际根持有 PG 部署配置、迁移、登记及串行实例 heartbeat 调度。私有恢复 CAS/审计为显式 opt-in；开放恢复入口前仍须完成实际 verifier/见证签发、分配对账、Root 启动集成及 PostgreSQL 执行验收。
- **必需证据** — 参与者存在不验证存储配额、进程停止或完整账户销毁。Private Profile/patch 读取及所有原生配置/JSONL 写入都须在 boot 前取得真实的所有写入者存储授权；prepare 期间才核准目录已经太晚。容量预留不执行参与者排空。
- **账户交接** — 只有包内工厂 helper 安装 binding。Helper 要求可信 owner 输入，自身不核验 PG 归属；测试提供 binding 夹具，不据此宣称账户图 ready。
- **关闭顺序** — Clean 账户释放要求完整原生/保存/持久化、execution/files 及 owner-store 结算。账户工作未知时保留 Root 控制资源。保留失败的恢复仍未开放；仅原生销毁不能释放生产 owner。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
