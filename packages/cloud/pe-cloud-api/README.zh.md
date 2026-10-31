---
description: "核对云端 API 的精确开放清单、绑定后的原生 Session 委派与实际模型调用准入。"
kind: "package-reference"
---
# @deepseek-ai/dsh-pe-cloud-api

[English](README.md) | 中文

## 概述

明确选择云端配方允许开放的原生 RPC、逻辑流、Fetch 路由和设置字段。未知操作保持关闭，原生清单变化会撤销先前审核。共享守卫在原生 Session 委派及实际模型调用前执行。runtime、项目和配置保存集成不完整时，账户挂载明确失败。

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

在部署方拥有的组合中挂载根入口；账户挂载需要完整的可信集成。

### When to choose it

需要执行经审核的云端开放规则，并保留原生 Session DTO 和业务操作时使用本包。认证、owner 选路、项目文件系统核验和账户就绪仍是前置条件。

### Minimal configuration

[已执行的 Loader 夹具](tests/fixtures/root.cordis.yml) 展示根配置；空清单不会开放操作。产品组合选择本包的 `/root` 和 `/account` 入口；必需集成缺失时，账户入口拒绝挂载。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `recipeVersion` | 必填 | 经审核的精确配方标识。 |
| `rpcEndpoints` | 必填 | 精确一元端点、原生处理者和资源守卫声明。 |
| `streamEndpoints` | 必填 | 精确逻辑流声明。 |
| `exactFetchRoutes` | 必填 | 精确方法、路径、处理者和资源守卫声明。 |
| `allowedSettings` | 必填 | 精确 namespace 和实际变化的字段路径。 |

清单审核将配置声明与原生已挂载处理者比较。额外注册的原生入口保持关闭。根匹配只声明部署策略；每个账户还须核对当前 runtime 绑定、实际启用处理者和资源。

`CloudAccountApi.prepareCloudProjects(owner, { createProject })` 在清单审核前安装唯一、增量的 `cloudProjects/create` Remote。请求只有可选显示标题；显式空白或超过 256 UTF-8 字节的标题在分配前拒绝。可信回调捕获账户能力，经 files 分配并返回原生 `WorkspaceValue`。原生 `workspace/create(path)` 保留既有目录登记与幂等含义。取消仍等待实际回调结算，不承诺回滚；未知结果不得重放。精确开放行为 `cloudProjects/create`、`native:cloudProjects`、`authenticated-account`。

可信账户装配可在 API 构造时保留私有 Office 生命周期能力。它安装原生 Office-to-PDF provider，并通过云端 `convert` 适配器接线，保留两个原生 Remote 方法、授权和版本复核。有界清单检查唯一的渲染器、账户文件系统和 WorkspaceFiles 注册；manifest 对 `officeToPdf/render` 选择 Session 准入，对 `officeToPdf/generation` 选择已认证账户准入。调用方取消只结束自身观察：适配器继续持有原生 reader，直至转换及临时目录清理结算，并继续占用原 reader 容量。清理结果未知时关闭转换准入并保留责任。部署必须提供匹配的引擎和字体，并将 Office 输入保持在云文件系统实际读取上限以内。

Office 清理失败仅向 stderr 输出固定的内部阶段和 provider/root 状态数值，不依赖 graph 日志链的存活。此诊断不能授权释放或恢复准入。

`CloudAccountApi.createWorkspaceFiles(owner, nativeConfig)` 在完整原生 inject 依赖就绪后，于实际 Loader fiber 构造唯一原生 WorkspaceFiles。它捕获原绑定及 fs、sandboxPolicy、sessions、typert 注册，并在清单审核及 workspaceFiles RPC/stream 准入时复核 value、fiber 和唯一性。清单由全部原生 Remote marker 及其 mode 推导，开放范围仍由 manifest 精确选择。原生类、DTO、lookup、文件 I/O 和流清理保持原义。部署必须保留要求可信 Agent 或原 Gateway invocation 的 Runtime resolver；本注册不授予路径权限，也不新增 watch 支持。

-----

可选的 `approvedConfiguration.fields` 行选择精确的命名空间／字段对及可选的有限标量 `values`。Root 要求相同的完整 `allowedSettings` 集合与唯一原生 `settings/mutate` writer。仅支持活动原生 Settings 表单的顶层标量字段；缺失、结构化或 secret 字段拒绝。可信首屏准备跨原 Controller 结果保留原登录 Peer/AccountUse。修改要求非负安全整数 `expectedRevision`，路径必须唯一且仅含获批的单个字段；其他方法及原 JSON 中的未知字段均拒绝。既有 `locale/preference` 策略仍要求精确的 `values:["zh","en"]`，且仅允许单条匹配的 `set`。原 Settings、ConfigEditor 和账户保存屏障负责持久化及 live 应用。替换前拒绝正常结算，不触发隔离；替换后的未知结果保留责任并触发原账户隔离。`hasDocument` 仍为 false，省略时保持只读。

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部机制 — 点击展开</summary>

按[运行时 debug 观测约定](../pe-cloud-runtime/README.zh.md#understand-the-implementation)，原生 `session/follow` 仅在原守卫通过后、yield 前记录实际 opening snapshot。该元数据不证明浏览器已收到或呈现；取消和清理仍由原迭代器负责。

根拥有不可变策略，并在其 fiber 销毁时撤销审核。[开放清单实现](src/exposure.ts) 使用精确映射，不解码路径或按前缀授权。[私有原生装配](src/native.ts) 注册公开 SessionController 的唯一子类，继承其 Config、DTO、Remote 标记及业务方法。Create、prompt、fork 和队列更新等待共享项目/Preset 核验，并在调用原生 super 前立即复核准入。同步 cancel 检查实际附着 Agent 的既有 scope，随后保留原生取消或 notfound，不加载 Session。

私有[账户暴露视图](src/account-exposure.ts) 从根的冻结 manifest 中选择同配方子集。RPC 与流类别、Fetch 方法/路径、handler、guard 和 settings 字段必须对应根的精确声明。每图拥有自己的 inventory 审核和销毁失效；A 的审核或失效不改变 B 或根。审核及操作准入核验实际安装的精确 AccountBinding 与可信 graph/mount-current 回调，允许在 ready 前受限挂载时审核，拒绝过期或关闭的图。现有 ExposurePolicy 消费者可直接接收该视图，不增加 Loader 服务或全局账户注册表。

可信构造准备过程向 runtime 的[私有启动观察器](../pe-cloud-runtime/README.zh.md#understand-the-implementation)报告 provider、bootstrap-policy 及 inventory 阶段。回调异常不影响审核或发布；此回调不属于 Loader 配置或 Remote 入口。

Page 和 follow 对普通 Session 地址等待共享项目守卫。Page 在原生读取前和返回结果前复核准入。Follow 要求已审核的流声明，并在每次推进原生迭代器前及交付结果前检查准入和取消。原生迭代器接收调用者与图生命周期的取消，继续独占历史、promotion 及清理责任。Subagent 历史地址在单独范围审核前继续拒绝。

Controller 准入使用实际安装的图 AccountBinding 及与实际 LLM 守卫共用的可信 business-ready 回调，独立于 HTTP/Peer AccountUse 生命周期。外部 AccountUse 也必须满足 business-ready；视图的 graph/mount-current 审核不能代替这一检查。装配须声明原生依赖、保留所属 fiber，并排除第二个基础 Controller。共享守卫失败、binding 过期、开放审核撤销或处理者停用都会阻止委派。原生进程内调用保留守卫抛出的错误；传输序列化遵循现有 Gateway 规则。原生业务结果与失败保持原义。

Controller 必须接收固定的 `NativeSessionGuards.projectDirectory` 能力，持有实际安装的精确 binding，并由可信 files 装配提供可等待的 `prepare(cwd)`。其原生 protected 覆盖在目录准备前后检查 binding、业务准入、已审核暴露和处理者可用性，关闭或被替换的图不能因迟到结果创建 Agent。能力使用既有有界 files lane，并独立核验批准项目；cwd 是输入，不是授权。S2 已有批准项目可在注册窗关闭后继续验证，新目录仍遵守 provider 原有批准要求。该适配不回退宿主 mkdir、不增加 files 池，也不重开注册窗。

可信 runtime 在准备阶段，以精确 binding、独立的挂载/业务核验、部署开放策略和根签发保存屏障构造公开 `CloudAccountApi` 服务。其 `providers` 提供固定的原生编辑器和凭据构造函数，并在显式准备时提供带守卫的 manager；原生安装方法沿用既有 Controller、AgentLoop 和 LLM 守卫。空 `/account` 入口要求这个精确准备好的 `peCloudApi` owner。服务存在和入口激活不发布账户就绪：runtime 仍负责实际 files/Workspace/Preset/模型核验、inventory 审核及 ready 发布。

可信准备过程可提供 `inspectRootFetch`，有界读取原 Root 注册。准备清单将这些实际事实与原生上传合并后，再执行既有开放审核。Fetch 分发和 bootstrap 会重读同一生产者，精确核对方法、路径、handler 和 guard；撤回、不匹配、重复或超出数量均拒绝。缺失回调不能证明已选择的 Root 路由，实际条目共用既有原生清单预算。

`auditPrepared(owner, signal?)` 要求 factory 的原始未发布权限，以及同一共享策略和有限原生清单上限。它在异步策略读取前后检查装配/未发布权限，从实际受守卫 Controller 方法及原生 Typert 标记/路由推导选中处理器，失败时撤销先前审核。继承但未受守卫的方法不能满足 manifest 声明。它不执行业务操作，也不授予 ready；业务调用仍要求独立 ready 检查。

固定可选首屏装配将 `session/list` 和 `session/control` 委派给原 SessionController，将 `workspace/follow` 委派给原 WorkspaceController，并保留原生、按 Peer 读取的 `remoteAccess/follow`。列表行与 control 帧共用原 AccountPolicy 的只读元数据检查；它可在 Workspace 关联前检查已发布 Session，不签发命令或历史权限。冷 id 只保留原批准 Workspace 的既有只读关系，原生列表行还核对实际项目、父关系和已有投影字段。Workspace 流通过共享项目守卫核验每个精确 Registry 对象，支持多个批准项目，并要求每个返回 Session 都具有唯一项目关系。原生 `workspace/create(path)` 仅复用已登记的批准项目；目录分配使用单独的云项目能力。集合数量及完整原生结果/帧字节都有显式有限上界。Reader 还必须提供 `maxQueuedEvents` 和 `maxQueuedBytes`；它验证并复制这些值及帧上界，通过 `controlBufferLimits()` 交给原生 control 队列。因此原生 baseline 检查可先于 Cloud 结果检查拒绝。这里不改变 Remote 参数，也不引入队列实现。原六个 Session 守卫继续保留。

`workspace/initializeDefault` 以拒绝目录解析器调用原 Registry helper，只能复用 files owner 持有的精确默认 Workspace。它不打开 Documents 回退、不创建目录，也不重开注册窗。`settings/describe` 与 `settings/mutate` 回包仅投影获批原生 schema 字段及其解析值／base／user 值，并保留原 revision 与 live 应用语义。没有可写字段时，describe 保留既有只读 `locale/preference` 视图；provider 或 locale fiber 缺失、替换均拒绝。默认 `writable=false` 和 `hasDocument=false` 描述此 Cloud API 可用的操作，不表示磁盘上不存在 settings 文档。未显式选择获批字段策略时，`allowedSettings` 保持为空。模型选择/目录及其他 Settings 方法保持关闭。

[只读事件源](src/first-screen-events.ts) 通过原 Gateway 公开注册接口，订阅真实 Session added/removed/activity/status/error 通知和获批表单文档更新（默认仅只读 locale）。Gateway 生成 `$events` ready/client id 和传输帧，home 必须来自实际 `profileContext.home`，并与 runtime 预期精确一致。不准入 waterfall 或 `$events/result`。Home、事件数量、驻留字节及完整 emit 帧上界均须显式提供，没有部署默认值。源队列超限保留首个错误、撤销本账户审核、卸载监听并等待原注册 disposer；stop 与 withdrawal 等待同一缓存工作。同一显式队列/帧预算会传给原 Gateway 注册的每个 client 上界。下游 client 超限只使对应实际事件流失败；source、API 审核、健康 client 和后续 ready 代际继续可用。原生退队和关闭释放该队列的驻留字节；实际清理及资源结算仍归原迭代器/载体所有。

`assertBootstrapCurrent(owner, signal?)` 要求原始共享策略回调及正数有限 `maxNativeInventoryEntries`，没有默认值。该预算在遍历前计入所有选中开放清单条目，再于单次扫描中在检查每个实际 runtime 和 fiber 前计数；超限在读取策略元数据前拒绝。它在策略元数据读取前后核验挂载/业务准入、已审核开放清单、原 Controller/AgentLoop/LLM 对象、它们唯一的 ACTIVE 拥有 fiber 和实际 LLM listener。重复安装、替换或 listener 销毁均拒绝。省略回调或预算保留一般准备能力，但此断言保持关闭。取消跟随调用者与图 lifetime。完成后返回由 API 签发的同步复核函数，核验原绑定、业务准入、原生 guard 和已审核端点；调用方在发布响应前调用。它不创建业务资源或 ready 权限。

Root 配置还可提供 `approvedConfiguration`：显式 recipe/catalog 版本，有限条目、字符串及完整字节上限，非空固定已安装 DSH 条目或 bundle 目录（禁止安装，未选择下述固定可选控制时禁止启停）、关闭技能、只读凭据及无可写字段。规范解析器先复制并冻结完整值，再由原 `ExposureService` 持有。省略时保留仅开放策略的组合，不产生 catalog。这只是批准元数据；bootstrap 投影公开 id 前，仍必须比对实际账户 Loader 条目、包版本、原模块及配置计划。基础目录不启用安装器、写入者或接口。

[私有 AgentLoop 工厂](src/native-agent-factory.ts) 检查同一实际安装的图绑定，在原生持久化创建或恢复写入 ownership 前，等待共享项目/模型/Preset 准入。安装时只检查已安装的图身份，可信 runtime 装配另行核验准备期权限；创建、恢复与发布都要求独立的业务准入检查。它保留原 setup 及其同步 commit，在 setup 后及 commit 前后核验实际准备的 Agent。普通根 Session 允许省略委托深度或深度为零。child 创建/恢复还要求原 Root 容量回调、共享 `withChildPreparation` guard 及原生 Workspace 准备；省略时 child 继续关闭。该 guard 包裹原 setup Promise，并在完整 Workspace 准备前撤销目录 selection，不结算原 I/O 或 child 容量。seeded 路径、启动 agents 及 direct AgentLoop.create 保持关闭。所属配方声明原生 AgentLoop 依赖，并排除第二个 loop。

原生持久化 append 可在 setup commit 与 registry 发布之间等待。调用者和图生命周期取消会传入原生事务。原 setup 只 commit 一次；其同步 current 复核在 append 结算后和原生发布检查点运行。成功发布后的调用者取消继续保留原生 creation-only 含义，不取消已提交的 Agent。Runtime 必须在重配置及实际 teardown 中持续持有已准入工作；仅观察者被拒绝不能证明迟到的后端 ownership 已关闭。

选中的 child 路径持续核验精确 parent、Session、Registry、账户 epoch 和图身份。它按实际运行深度向原 `RuntimeCapacity` 预留，只通过原生清理结算。Workspace 持久化失败或原生清理 unknown 都保留容量；原资源回调必须同步关闭业务准入，并保留账户 owner 以排空和隔离。结算不能中止或销毁自身尚在执行的回调。

[LLM 监听器](src/llm-guard.ts) 在原生流继续前检查账户代际及批准的 provider/model。它保留冻结请求。账户工厂必须提供与目录和模型选择共用的允许集。

Runtime 创建并持有一个[配置协调器](src/config-saves.ts)，显式限制全局/账户在途、排队、跟踪条目、嵌套工作和观察者数量。准入在调用原生 callback 前同步登记责任。同一账户的保存串行执行；必需嵌套写入归入当前操作，不排在自己后面等待。必需应用仍属于同一结果。

Pause 关闭顶层准入，但允许已登记工作完成；只有静止、无未解决失败的 pause 才能在 runtime 重新审核图后恢复。Stop 是终态。 Runtime 拥有的 coordinator 可在销毁图前，向其精确、已停止、空且无失败的 barrier 提交一次最终配置；嵌套原生 hook 复用既有有界 turn，普通准入和 resume 始终关闭。观察者取消或 deadline 到期返回 unknown，不释放实际工作或容量。失败和结果未知保留脱敏证据及跟踪容量；本包不自动清除失败。

[原生适配](src/native-save-hook.ts) 通过账户装配及同包测试使用的内部辅助函数，将公开原生 hook 接到同一屏障。`installNativeConfigSaveHook` 准入默认模型保存、Settings 写入及 legacy rename、直接 ConfigEditor 编辑；其他顶层 writer 标识被拒绝。旧的 `installNativeDefaultModelSaveHook` 保留较窄范围；每个编辑器只安装一种 hook。`installNativeCredentialSaveHook` 观察本地 provider 的 set、unset、modify-record 和 delete-record 操作，不留存地址或密钥值。原生返回值、失败、队列、必需发布及选模响应时序均保留。

两个安装器要求调用 Context 及其独立根持有与屏障完全相同的 binding，并在准入及排队后提交前复核。Runtime 必须保留每个 hook 的调用 fiber，直到终态确认静止；强制销毁 fiber 可以绕过显式 disposer 守卫撤回原生 hook。实际 Settings/editor 嵌套共用原生准入，跨服务嵌套工作仍登记到同一屏障操作。

私有[prepare 期安装](src/account-install.ts) 返回两个固定原生子类，在初始化前将 hook 绑定到实际 constructor receiver。因此本地凭据 provider 的初次扁平文档迁移及 Settings legacy 导入也被覆盖，无需复制原生队列或写入。Credentials 要求显式绝对路径及 watch=false。句柄持有实际安装的精确 binding 与根签发的屏障，暴露既有 pause/resume/stop 控制，暴露视图初始未审核。撤钩要求终态、无失败的实际结算，并等待真实原生 Loader 初始化；它不销毁账户 Context，也不释放根容量。

服务就绪后安装 hook 无法补记更早的初始化写入。Constructor 路径解决该本地迁移缺口，但 runtime 仍须在迟到结算期间保留 hook fiber 及初始化 ownership，在 resume 前重新审核，并在开放账户前提供真实图、存储授权及 I/O 预算。保存失败保留证据；观察者取消和强制 fiber 销毁不能证明 teardown 干净完成。

可选原生上传装配继承 FileUploads 的流式路由、Agent 解析、收据绑定与退休，显式选择其原待处理收据及上传容量。账户适配在原生收据发布前等待受控存储钩子。其保存回调只能使用一次，并在 preparation 结算后失效；已启动的保存会等待实际结算。如果保存成功但 preparation 或保存后的准入失败，上传结果未确认并保留名额。保存被拒绝本身不能证明没有发布。encoded 文件上传及内联编码图片保持关闭。准备审核检查唯一 ACTIVE owner、未替换原生依赖及流式路由，再开放精确 POST 路径。原生 Session Controller 在原 prompt 准入、绑定与投递前等待同 Agent 文件准备，已接受请求去重仍最先执行。账户适配不重写上传存储、收据表或 prompt 投递。

模型 Key 适配只接受 Root 批准的原生引用，原生 set/unset 仍由现有账户保存 owner 提交。严格 Typert codec 拒绝额外字段，限制 UTF-8 输入及完整回复元数据；响应只有原生脱敏状态，或确认持久化的结果及不透明版本。原请求借用、业务准入、暴露策略和匹配的屏蔽环境在原串行回合内、原生工作前再次复核。确定只读检查拒绝正常结算，不留下保存失败收据；已提交失败继续由原 owner 持有。

批准引用仍要求既有 checked edit；原生直接无版本 set/unset 继续拒绝。原生 record/OAuth 所有权不变。edit token 属于图内版本，不是磁盘 revision；持久化仍由原 credentials 文件锁、原子 writer 和通知拥有。

生产 ingress 将原请求/Peer 的只读 current 检查作为 `CloudAccountApi.modelKeyAccess` 第三个参数。适配在准入前后及原凭据保存回合内重复检查；排队期间登录关闭的请求不提交原生写入。回调不增加借用或释放拥有者，也不取消已提交工作。省略时保留可信进程内行为，不授予登录载体准入。原生持久化后的拒绝不会撤销保存，也不得触发自动重放。

显式 `approvedConfiguration.modelKey.bindings` 选择有限非空的 `{ provider, providerEntryId, moduleName, ref }` 列表。目录的条目、字符串和完整字节上限适用于这些数据；provider id 唯一。同一选择驱动 codec、环境屏蔽、原生 provider 元数据及保存白名单。每项原模块 import、活跃 fiber、可配置 provider 的 namespace/path、原生 `credential-ref` schema role 及实际 `apiKeyEnv` 值必须匹配。元数据保留原生脱敏 schema、模型配置、分层值和 revision，设置写入仍关闭。Key 策略另要求正数有限的 `maxKeyBytes`、`maxVersionBytes`、`maxReplyBytes` 和 `maxMetadataBytes`。可信准备安装唯一 `cloudModelKey` 服务，包含 `metadata`、`describe`、`set`、`unset` RPC，handler 为 `native:cloudModelKey`，guard 为 `authenticated-account`。准备期审核要求原 marker 及生成的严格 Typert descriptor。服务在保存前检查原 invocation JSON，生成的对象投影不能放行额外字段。原生 credentials/set 和 credentials/unset 保持关闭；settings/mutate 必须另有精确的获批原生字段策略。

`cloudModelKey/metadata` 从实际批准 providers 及原生 Settings descriptors 返回 `ModelKeyMetadata`。它投影每个 Root 选中 binding 的实际 provider/配置路由，以及原生脱敏 Settings schema、已解析模型配置、base/user 分层值、revision 和 secret 存在性元数据；设置写入保持关闭，省略凭据编辑版本。支持范围为使用 `apiKeyEnv` 凭据引用与 `models` 声明的原生 Models 配置路由；未扩展 OAuth/record 凭据。模块、配置或服务事实缺失、变化、撤销均拒绝。Root 在原生挂载前屏蔽全部选中引用，并把它们交给既有保存 owner。原生持久化及后续模型请求继续由原 owner 持有，不增加验证请求、自动重试或跨存储事务。认证 PostgreSQL/ready-Use 及浏览器验收仍为独立集成要求。

显式 `approvedConfiguration.pluginControl` 启用有限批准目录的通用 `cloudPlugins/current` 和 `cloudPlugins/change` unary 组，均由 `native:cloudPlugins` 持有。每个受控项固定 id、原生 entry、确切 module/package/version、entry 或 bundle `selectionTarget`、操作许可、影响上界及普通 Config 路径。reminder 元组仅作为示例数据。`current` 通过公开的原生 `createConfigProjector` 投影各批准普通路径；`configure` 在一个批准路径接收字面量 JSON 值。volatile 字段继续走独立的 Settings live-only 路径。原生 schema 和影响检查仍决定实际变化是否受支持；目录批准不证明依赖或生命周期安全性。完整 profile、请求、响应及版本字节仍有上限；不接受包安装、模块说明符、profile 文件名或原始 manager RPC。

字段返回 `writable`、可选 `readOnlyReason` 以及原生相对秘密存在标记。受保护字段使用不透明的空 schema，因此秘密默认值及 schema 常量均不进入响应；值省略，秘密存在标记复用 Settings 脱敏。整字段写入与终止式接受均在原生发布前拒绝受保护或未获证明的字段。纯普通对象与数组仍可编辑；混合容器可批准普通子路径进行编辑。此入口不开放秘密写入，volatile 编辑仍由 Settings 承担。

原保存 owner 依据原 patch 与 manifest 共同构成的受限 revision 签发并比较绑定 epoch 的 opaque 插件 edit。`if-idle` 必须取得 runtime 的实际独占窗口，通过原 Manager 或 ConfigEditor 及原生准备计划应用，再经原审核返回 `applied`。显式 `stop-and-apply` 仅返回 `accepted-rebuild`：原 factory 等待发起 carrier 完成，关闭 Peer，确认原生、files、execution 终态排空并 flush 后，在撤回 hook 或销毁前通过旧图原 writer 和已停止的保存 owner 应用已检查 intent。替代图申请新 epoch，再按已持久化的配置装配。客户端须重连读取实际状态；接收不代表生效。同代更新确认未发布的拒绝允许后续保存；原生结果未知则保留原保存及 factory 责任，禁止自动重放。

`approvedConfiguration.bundles` 批准确切的预安装 bundle 包/版本及其完整有限原生成员标识和包版本。这些项仅允许 `selected`，要求 `maxImpact: graph` 及空 Config 字段，并可与空 `plugins` 列表共存。其当前状态在 `bundle` 中保留原生 `BundleInfo`，条目项继续使用 `plugin`。显式 `stop-and-apply` 通过已停止的原保存所有者写入一次，不激活旧图。新装配在 ready 前核验原 intent、持久化版本、新鲜包版本、实际 Entry 选项及活动的提供/注入所有权。默认 `if-idle` 完整图选择保持关闭。

凭据引用、技能目录和批准插件 Profile 在同一个 `AccountSaves` 中保留各自的编辑 token。技能工作及必需应用/provider 释放继续占用该 turn，阻止独占 paused 插件修改。插件嵌套 writer 加入原 paused turn；顶层技能仍使用普通 live 准入。失败或未知保存阻止重新开放，终态 stop 不能恢复。paused 插件权限不授予原始 Settings、凭据或 manager/package writer 权限。

显式账户配方入口可通过 runtime 私有 builtin 选择原生 Commands、Goals、权限预设、UserQuestions、反馈及 Session 日志导出。这些服务保留原生注册表、投影、修订号、队列与持久化。每个实际 RPC、流或 Fetch 注册都须匹配已审核开放清单及原 provider 身份；浏览器选择控件本身不授权操作。模型目录使用与 prompt 调度相同的批准 provider/model 路由过滤，保留原生 effort 元数据，并在原生选择提交点复核准入。

Commands 在附件准入之后、原生 handler 执行之前复核原账户及 Agent。原生问答 waterfall 复用 Remote 投影器及结果协议；已交付但未回答的问答仍占用同一事件条数与完整帧字节预算，直到结算。销毁及请求取消会拒绝未决问答。反馈沿用原生排队 JSONL 写入和账户范围的匿名展示身份；已经开始的写入在准入关闭后仍保留原有 flush/close 责任。

权限控件要求实际执行限制的 Files/Shell 及原签发 execution port。仅支持 read-only、workspace-write，两者 approval 都为 never；保留的命令/服务或实时子 Agent 会阻止切换，子级不能扩大只读祖先的权限。初始权限播种要求执行限制已安装；公开目录及修改仍要求业务准入。原生日志导出在读取前及发送 ZIP 前检查账户/项目准入；请求、代际和注册取消共同管理流。ZIP 格式与清理仍由原生实现负责。

</details>

-----

<a id="further-exploration"></a>
### Controlled sample publication

`CloudSkillService` 提供八个具体 strict Remote 方法：旧 `current`/`publish`，以及 `installed`、`details`、`install`、`update`、`uninstall`、`download`。可信装配必须提供 `managed` API 上限、实际 files 包上限及原 Workspace 守卫。`skills.mode=managed` 要求八个精确的 authenticated-account 端点和显式 `management` 上限。源码不提供部署默认值。全部 DTO 从 `/types` 导出；Client 声明由这些方法生成。

一个 files 所有的 `skills/current.json` 目录和一个 `AccountSaves` 编辑版本覆盖全部安装项。普通读取将 schema1 保留为旧 sample；首次 schema2 修改保留该项及其他不可变版本。`current` 在 sample 不存在时仍观察整个目录 revision；安装、替换、移除和旧 publish 都使旧编辑版本失效。sample 替换仍使用完整两文件 `publish`；通用 `update` 拒绝旧 sample。

完整文件或 ZIP 输入交给 files，不访问宿主文件系统或执行资源。files 负责包、路径、类型、链接和展开量验证、原生 CAS、源句柄、完整 ZIP 导出、工作副本证明、计费及回收。发布前确认的技能包超限拒绝返回 `cloud/capacity`。下载先在原保存 turn 内核对当前安装项和内容版本，再进入原 files 导出借用。移除目录项拒绝后续加载，不终止脚本或删除已有可写项目副本。

原生 parser 为每个安装包发现一个技能根；资源 Markdown 和嵌套 `SKILL.md` 仍是包数据。原生 `skills.inspect()` 提供生效与覆盖关系；API 只投影公开来源，省略 rank、locator 和私有路径。可选 Workspace 经原 registry 和归属守卫核验后提供 `cwd`，不伪造 Agent scope。管理列表包含目录安装项，不授予其他项目或运行时贡献的编辑、下载权限；这些来源的原发现、批准根及优先级仍由原生实现负责。

provider 选择、源借用及完整资源准备在原保存准入后开始。prepare resident 在原生验证和目录提交期间持续持有；成功后在必需应用/provider 释放结算结束时恰好释放一次，拒绝或取消时则等待必需失败清理结束再释放。CAS 确认后同步切换可见项、使原生缓存失效并释放 resident handoff；同一保存 turn 随后等待旧原生 provider 释放。释放失败继续计费并保留失败。每个原生 provider 有有界的独立生命周期，替换或拒绝准备不积累父 abort listener。持久化已确认而应用失败返回 `persisted:true, applied:false`；原生提交未知返回 `persisted:unknown, applied:false`，保留原失败责任且不重放。

## Further Exploration

- [Runtime 输入](../pe-cloud-runtime/README.zh.md) — 账户身份与生命周期归属。
- [原生 Session API](../../api/session-controller/README.zh.md) — 命令、历史与流。
- [Gateway](../../api/gateway/README.zh.md) — 原生传输与 Peer 规则。
- [LLM](../../llm/llm/README.zh.md) — 实际流式调用。

-----

<a id="model-experience"></a>
## Model Experience

### Model-call admission

#### What the model sees

本包不添加提示词正文或工具 schema。`llm/stream` 监听器在原生 adapter 前核验 `provider` 和 `model`，被拒绝的调用不会进入 adapter。批准调用保留原生请求和会话历史。

#### Token effect

本包增加零请求 token。

#### KV Cache effect

守卫保留请求内容及可复用前缀；provider 缓存是否可用仍由 provider 负责。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

必需集成缺失时，账户入口明确失败。

- 生产原生清单提取、传输选路、项目核验和绑定签发仍需集成；本包不发布 ready。策略测试证明视图隔离；独立的原生 Loader 测试检查真实公开 handler 元数据。安装测试使用显式 runtime 绑定及自有 Node 路径，不代表生产 owner 或存储授权。
- F06 对所有可达原生 writer 的提交覆盖及 runtime 装配仍不完整。协调器和已审核的原生适配不构成完整 F06 验收；账户入口中的模型选择和未经批准的配置写入保持关闭。
- 其他凭据 provider 及任意 manager/package 写入仍在固定控制范围外。Watch 刷新和可选监听器工作保留原生语义，安装 hook 不代表它们已被核定为持久保存。
- 通用 F09 影响预检及任意 PluginManager 修改保持关闭；托管技能修改要求单独审核的目录能力，单独选择的单引用 Key 服务使用自身有限策略。
- 原生 Profile 测试覆盖默认模型、Settings、直接 editor、本地 credentials、constructor 期迁移及迟到的启动/写入结算。实际私有 Controller 装配测试覆盖原生 Gateway 派发、创建、prompt、fork、同步 cancel 及恢复尝试的先后顺序。完整账户持久化恢复、认证 Web 及完整云端配方验收仍需集成；产品构建及这些检查由主控负责。
- 历史测试使用真实 JSONL 读取和冷 follow 恢复。普通 AgentLoop 激活使用共享项目/model/Preset 策略；生产 ready 还要求原 storage owner、准备期审核及实际 runtime ready 提交。其他激活及 child 路径在单独完成作用域审核前继续拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
