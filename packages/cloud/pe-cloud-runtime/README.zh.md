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

实际根配置包括 `recipeVersion`、`internalAddress`、明确的心跳/启动/停止/账户观察预算、凭据解析时间和字节限制、PostgreSQL 连接字段及 `passwordRef`、有限 `pg`/`factory`/`saves` 容量、规范化的共享/本地路径，以及固定原生配方位置、必需条目和诊断上限。根要求正式 `credentials` 服务，先预检引用，再为每次实际 PG 连接重新解析；不读取 `process.env`，不使用账户凭据提供者。等待被放弃后，解析仍计入容量直至实际结算。

函数入口创建唯一既有容量持有者、PG executor、进程登记组件、owner store、账户 factory 和 API 配置保存 coordinator。它先迁移两张控制表并登记生成的进程身份，再提供 active 根控制面。初始化不等待下游 files/execution 贡献；参与者检查归账户领取，避免 Loader 注入环。原生准备期间，factory 从精确安装的 binding 签发该 coordinator 的屏障，并在实际保存及其余账户排空检查完成前持续持有。

`locateAccount()` 读取实际 PG 元数据；`acquireAccount()` 在领取 owner 或创建原生图前要求当前配方已封口，再用根选定输入进入保留型 factory。`borrowAccount(binding)` 要求配方封口，并为登录 Peer 独立借用精确的 ready 代际；它不会领取 owner、装配账户或替换为较新的图。`assertMountCurrent()` 检查已安装的准备期/当前身份；`assertBusinessCurrent()` 还要求配方封口和 factory 的 ready 状态。根控制面 active 或原生 mounted 均不发布账户 ready。

Provider 经根服务登记必需的 `files` 和 `execution` 参与者。登记归调用 fiber 所有，重复项会被拒绝。缺参与者时拒绝装配容量预留；通过此检查不等于配方封口。配置保存使用 API 单独持有的屏障，不是第三个参与者。

账户工厂持有容量预留，直至实际工作结算。`settleMount()` 释放并发装配槽并保留账户槽。装配或排空仍持有账户时，`releaseAccount()` 拒绝释放。请求超时不授权这两种释放。根卸载先关闭新准入，并等待实际控制清理后再关闭容量。观察过期会报告不确定状态并保留实际关闭 Promise。

### Root recipe admission

`sealRecipe()` 核验实际 Root Loader 条目、原始模块 namespace、唯一服务实现及其所属 fiber、API provider 持有的精确冻结 manifest，以及 files/execution 登记与实际 provider 的对应关系。它检查原生配置快照和 provider 健康状态，不接受 ready 标记。认证健康还要求实际 ingress 保持已安装且当前有效；仅资源初始化不能满足 Root 准入。11 项角色目录固定入口作用域：5 项在 Root 激活；账户、Session 和客户端角色仅声明各自图的作用域，不为此审核而激活。

`inspectRecipe()` 返回冻结的计数和有限问题标识，不暴露路径、凭据或 provider 对象。Loader 变化、provider 替换或关闭、参与者移除、显式 `revokeRecipe()` 及 runtime 关闭都会使保留的审核失效。`assertRecipeSealed()` 要求完整审核及原始 files pool/storage owner 持续有效。缺少实际存储仍以 `storage-root-capability-missing` 拒绝。既有 AppReady 回调在原生启动成功后尝试完整审核；该通知自身不授予准入。

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

业务回调从原 files owner 读取当前 Workspace 和目录能力。Create 请求只解析到该 Workspace；历史/恢复读取实际原生 Session observation 和经过头校验的 Workspace 成员关系。普通 JSONL 冷恢复保留其 SessionId 并被接受；导入/分叉或 subagent 身份仍拒绝。精确模型路由必须存在已注册的原生 provider，create/resume 使用原生模型解析并在 await 前后复核。LLM 派发保持同步路由/provider 检查。Guard 构造不读取部分完成的 files 项目。

同一策略通过惰性闭包提供 API 的只读 bootstrap 断言。Root 将既有 `native.maxEntries` 作为选中开放清单条目及实际遍历的原生 runtime/fiber 的共享上界，不新增部署值或默认值。它核验原 Workspace、固定原生 Preset/default/composition、当前默认模型元数据和实际 native handler，并在 await 后复核 provider 与选择。它不准备目录、不创建或恢复 Session/Agent、不解析凭据，也不请求模型推理。构造不读取未完成的 files 项目，不捕获请求级 `AccountUse`。该断言不替代生产存储交接或 Root seal。

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

### Process instance metadata

私有[实例组件](src/instance-control.ts)在 `pe_instances` 保存启动身份、可信部署地址、配方版本、观察阶段及 heartbeat 时间。其原子迁移遇到不兼容字段或约束时拒绝，不重置记录。组件在内部生成并冻结身份；持有者在每次 Node 启动时构造唯一组件，并将同一个身份交给 owner store。构造器不接受外部提供的实例 id。地址是不透明的部署元数据，不用于选择网络目标。

登记合并相同的本地调用，遇到已有的持久化 id 时拒绝，不覆盖其元数据。单行读取区分行不存在、读取失败及无效结果。Heartbeat 仅更新组件自身的 registered 行。`registered`、`closed` 或过期 heartbeat 均不代表账户 ready、进程死亡或获准回收 owner。实例操作不修改账户 owner 或 epoch。

每个组件最多持有一个实际 mutation。Close 关闭本地 mutation 准入，等待实际 schema/登记/heartbeat 工作，然后仅将自身登记标为 closed；账户排空及共享 executor 关闭由根单独持有。等待复用 adapter 的有界观察，不结算实际 SQL。已提交结果未知会保留类型化责任，读取或观察超时均不自动解除或重放；其他组件仍可继续。只有确定的提交前失败允许显式重试，重试 close 仍保持本地准入关闭。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部机制 — 点击展开</summary>

每个根独立持有参与者表和容量计数。每个独立账户根接收冻结的 binding，其中包含无精度损失的 epoch 字符串和图 lifetime。内部交接拒绝子 Context、仅结构相似的对象和已结束的 lifetime；没有公开构造器将浏览器 JSON 转为 binding。原生队列、Session、设置及执行状态仍由各自包持有。

[根服务](src/root.ts)、[PostgreSQL owner store](src/owner-store.ts)、[容量记录](src/capacity.ts)、[私有 binding 交接](src/binding.ts)和[共享类型](src/types.ts)定义已实现行为。[组件 Loader 测试](tests/runtime.spec.ts)覆盖容量/登记输入；[实际根测试](tests/root-control-postgres.spec.ts)使用单独分配的 PostgreSQL 数据库验证函数 Loader 的迁移、登记、心跳、factory 拒绝及关闭；[PostgreSQL 测试](tests/owner-postgres.spec.ts)在显式指定的测试库执行 CAS 及迁移场景，排空证据使用测试夹具。

私有[原生 Profile 适配](src/native-boot.ts)通过公开 app boot 创建独立根，在 `prepare` 中提供复制的 ProfileContext、显式启动环境及不可变 binding，并且只装配一次 root Include。所有保存/files/execution port 均须在 `prepare` 内使用同一个已安装 binding 构造、核验及注入，并保留其图 lifetime。等待 setup 完成后，prepare 在返回 boot 前再次核验已安装代际的寿命及关闭请求。若 setup 期间代际结束或收到关闭请求，不启动任何 Include entry，并继续等待实际清理。已装配图仍由 runtime 驱动销毁。它不安装账户 CLI、信号处理、代理、watcher 或代码 HMR。调用者必须先核验真实根能力和固定配方。装配结果仅说明原生装配完成。适配持有 boot/disposal Promise，并有界观察错误，覆盖部分启动和异步 disposer 失败；错误或观察溢出均阻止原生销毁 confirmed。该观察不代表业务工作排空或账户 clean。

私有[装配桥](src/account-mount.ts)将 Profile 目录、patch、home 和默认项目候选与唯一布局核对，并把同一个原生 `LaunchEnvironmentSnapshot` 对象交给 boot。私有[工厂](src/account-factory.ts)为每个账户保留一次实际操作。即使每次创建新的 request 外壳，只要账户/实例/配方值及可信资源引用一致，调用仍会合并；不同 binding、配方、环境或部署输入会拒绝。有界、可撤销的等待者共享一次结算订阅；截止或观察者取消均不停止装配或释放其容量。

Factory 的[原生集成](src/account-native-integration.ts)在 Include 前创建公开 `CloudAccountApi` owner 并安装实际 Root 签发的 closed execution port。固定私有 builtin 消费 API 的原生 editor/credentials provider、Controller、AgentLoop 和 LLM guard。提供受限 files lane 后会构造公开 `CloudAccountFiles`；其实际 `/account` 入口持有原生 Registry/default/FS 安装。Controller 构造只捕获固定 binding 和原 files owner，不读取部分完成的项目。API 业务准入通过后，目录操作要求唯一 ACTIVE 的 files/account 入口，并读取该 owner 当前的 `project()` 能力；操作后再次核对同一个项目。Guard 构造也必须延迟项目读取。Files 初始化仍在途时，原生 provider 依赖可能已激活；必需入口检查和业务准入仍阻止发布不完整的图。Factory 装配/未发布登记检查与 Root 封口/业务 ready 检查保持独立。缺 files 或共享项目/model/Preset guard 时不会改用宽松回调。

Factory 关闭时先关闭准入和图 lifetime，等待原保存屏障，销毁所属 AgentLoop fiber，核对原 AgentRegistry 为空并 flush SessionPersistence，再撤回原生 hook 和销毁图。它等待剩余借用及实际 execution/files 参与者后才关闭原 storage lease。Clean owner 释放还要求 confirmed 原生销毁、保存和参与者证据，以及实际 PG drain/release CAS。工作或元数据结果未知时保留容量和归属；账户排空未知时 Root 继续持有控制资源。

装配容量随实际启动及已开始的原生清理结算。仅原生销毁不能证明完整排空，因此账户预留仍保留。工厂关闭外部准入时仍保留内部排空预留及原生销毁责任；清理未知继续持有排空容量。只有确定在 claim 前或从未提交的失败且没有原生资源时，才释放未启动账户槽。已提交结果未知保留原槽，不盲目重启。

实际根在配方未封口时于 PG 领取前拒绝 acquire。其私有 request 保留原 storage owner，以及原生集成消费的同一 coordinator、exposure policy、execution issuer 和[具体账户策略](src/account-policy.ts)。Factory 在任何 Profile/patch 或原生配置读取前取得原 storage lease，先记录规范的已安装 binding，再执行唯一一次 files bind，并在未发布阶段审核实际项目、closed execution 和原生 API。实际 ready CAS 前后均复核 Root、lease 和 binding。此后精确且有效的图才能签发 `AccountUse`；release 幂等且不 cancel Agent。独立 native-only 路径不授予 `AccountUse`。

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

- **账户工厂** — 生产链要求原 files storage owner、准备期原生审核及实际 PostgreSQL ready CAS。账户持久化恢复、认证 Web 和完整 Linux 配方仍须集成验收；组件文本回合或冷读取不授予生产 `AccountUse`。
- **根封口** — 原 files owner 必须直接复核受保护部署记录、当前 mount、写入者 namespace 及 bytes/inodes/private-reserve 上界。存储缺失或被撤销时准入关闭。非 Root 声明仍须在实际账户、Session 和客户端装配中核验。
- **布局接线** — 私有原生桥已核对 layout/Profile 一致性，但布局数据不能创建 files 能力或验证存储。已包含 environments 父根，尚无按 Session 的环境派生。
- **数据库集成与恢复** — 实际根持有 PG 部署配置、迁移、登记及串行实例 heartbeat 调度。恢复审计、分配对账及可信 RecoveryProof 应用仍未提供；本模块不能重领隔离态 owner。
- **必需证据** — 参与者存在不验证存储配额、进程停止或完整账户销毁。Private Profile/patch 读取及所有原生配置/JSONL 写入都须在 boot 前取得真实的所有写入者存储授权；prepare 期间才核准目录已经太晚。容量预留不执行参与者排空。
- **账户交接** — 只有包内工厂 helper 安装 binding。Helper 要求可信 owner 输入，自身不核验 PG 归属；测试提供 binding 夹具，不据此宣称账户图 ready。
- **关闭顺序** — Clean 账户释放要求完整原生/保存/持久化、execution/files 及 owner-store 结算。账户工作未知时保留 Root 控制资源。保留失败的恢复仍未开放；仅原生销毁不能释放生产 owner。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
