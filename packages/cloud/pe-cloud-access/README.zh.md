---
description: "校验云端请求绑定并使用基于数据库的 Better Auth 认证；根准入缺少集成时保持关闭。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-access

[English](README.md) | 中文

## 概述

校验固定源部署输入，在原生业务执行前拒绝陈旧的账户/代际预期。`BetterAuthAccess` 将认证交给固定版本的 Better Auth 和 PostgreSQL，仅从已验证的用户及登录会话记录返回身份。`/root` Loader 入口通过 `peAuth` 持有认证资源；可选 ingress 在已有共享 Web 服务上注册。真实 Root seal 及当前账户发布独立于认证初始化，控制每次请求准入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

通过浏览器安全的 `/schema` 使用结构 `AccessConfigSchema`、请求预期校验及唯一 `decodeCloudBootstrap` 解码器；C-11 线类型位于 `/types`。完整 Host 配置解析留在认证/root 内部。包入口和 `/root` 导出根 Loader 插件、`PeAuthService` 及 `AuthAccessError`。`BetterAuthAccess` 是同包根装配使用的内部实现，不增加 SDK 子路径。`AuthenticatedPrincipal.accountId` 直接使用 runtime 的 `AccountId` 类型。

### 配置

所有配置均显式提供，示例不充当生产默认值。浏览器结构输入见 [config-schema.ts](src/config-schema.ts)；[config.ts](src/config.ts) 保留完整 Host 策略，Node IP 语义不变。根要求 [root-config.ts](src/root-config.ts)、正式 `credentials` 及已部署的 Better Auth schema。省略 `ingress` 保留仅初始化资源的路径；配置后，会在原 Loader 的依赖作用域中等待 `webServer`、`peAccountRuntime` 和 `peExposure`，再初始化资源。缺失 provider 会使初始化失败。配置本身不授予业务准入。

| 字段 | 要求 |
| --- | --- |
| `publicOrigin`、`deploymentMode` | 规范 HTTPS 源；HTTP 仅限开发环境环回地址。 |
| `trustedProxyAddresses`、`authSecretRef` | 精确代理 IP；空列表表示均不信任；密钥引用由根解析。 |
| `sessionRecheckMs`、`authCheckTimeoutMs` | 正有限的登录最大验证年龄和认证观察超时。 |
| `ingress.sessionRecheckLeadMs` | 配置 Root ingress 时必填；正整数且小于 `sessionRecheckMs`。 |
| `maxPeers`、`maxPeersPerAccount` | 正有限上限；每账户上限不得超过全局上限。 |
| `maxPeerWaiters`、`maxPeerWaitersPerAccount` | 创建等待者的全局/每账户上限；退出等待立即移除记录。 |
| `maxPeerCarriers`、`maxPeerCarriersPerAccount`、`maxPeerCarriersPerLogin` | 实际 HTTP/upgrade 操作及存活 WS 的有限上限；子级不得超过父级。 |
| `peerCloseTimeoutMs` | 原生清理等待/告警时限；超时保留实际清理及容量占用。 |
| `maxAuthOperations` | 实际认证操作上限；超限直接拒绝，不设置等待队列。 |
| `maxTrackedLogins`、`maxTrackedLoginsPerAccount` | 已验证登录状态的有限上限，包含为旧读取保留的失效状态。 |
| `maxAuthInvalidations` | 未缓存登录 ID 的有限失效记录；数据库删除前先预留。 |
| `bindingFields` | 账户/代际使用不同专用头和 query 名称，实际名称仍须产品传输审核。 |
| `database` | 显式 `host`、`port`、`user`、`database`、`passwordRef`、`ssl`；SSL 使用系统信任验证服务端证书。 |
| `pool` | 显式正值 `maxConnections`、`connectionTimeoutMs`、`statementTimeoutMs`、`lockTimeoutMs`、`idleTimeoutMs`、`idleTransactionTimeoutMs`、`maxLifetimeSeconds`；锁超时不得大于语句超时。 |
| `startupTimeoutMs`、`secretResolveTimeoutMs`、`maxSecretOperations`、`maxSecretBytes` | 有限启动/秘密等待和实际读取容量；每个秘密的字节上限至少为 32，并按 UTF-8 计数。 |
| 可选 `servicePreview` | 固定独立 origin 与共用 DNS `cookieDomain`；协议相同，生产要求 HTTPS，开发可显式选择 localhost 子域。缺省时 Cookie 只属于当前主机。 |
| 可选 `ingress.servicePreview` | 显式 URL、字段、请求头限额及全部响应限额。只注册 GET `/cloud/service-preview`；缺省时不注册预览入口。 |
| 可选 `disableSignUp` | 委托给固定版本 Better Auth；省略时保持注册兼容，首试用部署须显式设为 `true`。 |
| 可选 `ingress` | 必填正有限值 `maxOperations`、`maxOperationsPerAccount`、`requestTimeoutMs`、`maxAuthRequestBodyBytes`、`maxRequestBodyBytes`、`maxBootstrapResponseBytes`、`maxGenerationBindings`、`maxFrameBytes`、`maxLogicalStreams`、`maxLogicalStreamsPerAccount`、`maxLogicalStreamsPerPeer`；子级容量不得大于父级。配置存在不授予 ready。 |

`peAuth` 通过 `ctx.credentials` 解析认证秘密，每个池物理连接再次解析密码。引用使用正式凭据引用语法；根不读取环境变量或默认连接。池将 schema 固定为 `public`；服务端语句/锁/事务空闲上限负责停止 SQL 工作，不用客户端查询定时器宣称提前结算。启动检查库返回的所有迁移类别，包含索引、不安全变更及 schema 问题，不编译或执行 DDL。迁移须在部署时显式执行。

`PeAuthService.observe()` 暴露资源阶段/计数及 `requestAdmission: 'closed'`。配置 ingress 后，嵌套状态记录实际保留的注册、owner/Web 身份及未结算工作；观察从不递归调用 seal。`close()` 先关闭并撤回 ingress，等待实际 handler、正文取消及原生 Peer 清理，再等待认证/秘密工作，最后执行 `Pool.end()`。超时保留工作；未知清理保留所有权并报告 `cloud/stop-unconfirmed`。仅资源模式不注册路由；两种模式都不创建监听，也不代表账户 ready。

根 `apply` 是返回 `Promise<void>` 的 async Loader effect；Loader 激活会等待认证初始化并观察其拒绝。通过 `ctx.get('peAuth')` 取得提供者，或在可信同进程装配中使用 `PeAuthService.mountRoot`。缺少秘密会使真实 Loader 入口失败并撤回提供者；原生 boot 的必需入口策略决定该入口失败是否拒绝应用启动。

`ingress.ownerForwarding` 使原 ingress 经固定 HTTPS 目标转发既有远端 ready owner。Root 显式配置有界受保护 PEM 路径、身份与 peer pin 集合、标记字节和原运输限制。准入前读取 CA／客户端证书／密钥；密钥必须是当前进程用户拥有的普通单链接文件，禁止组或其他用户权限。地址和服务身份仅来自该配置。runtime 的实际启动 id 与复查后的 PG 元数据只能选择已配置条目，PG 不能增加目标。每条实际连接发送头体前均核验 CA、hostname 和精确服务证书。

原监听器必须在 listen 前显式选择 `compression: 'none'` 与 `transportLimits`；头对捕获预算至少等于转发 `maxHeaderPairs` 并保留额外 sentinel 对。Ingress 在认证前拒绝完整已捕获头对数及字节超量。Root 客户端 CA 保留匿名公共 HTTPS；`x-dsh-cloud-owner-hop` 是保留字段，不能配置为 account／generation 头。带标记请求要求实际已授权 TLS 客户端证书命中 Root pin 集合。接收端重新认证原 Cookie，仅借用与 account、实际 recipient id、epoch、recipe 精确相符的既有本机 ready owner，不领取、重建或再次转发内部投递。普通 unowned／本机领取和 owner 原 generation producer 保持原逻辑。

远端 carrier 通过原 ingress operation 持有至实际运输及 Cookie 查询结算。登录撤销同步取消对应转发，不等待正在触发撤销的复查。成功写出 101 后停止 HTTP 握手超时，但仍持有隧道与复查。未知或可能已投递的失败会关闭并记录，不重放。在 auth／转发工作开始前登记原 `PeAuth.close`，先结算 ingress、运输、auth 与 Pool，再由 runtime 关闭 resolver 及后续原拥有者。

### 请求绑定

向 `parseRequestExpectation` 提供载体字段的全部出现值；缺失、重复、空值、首尾空白或控制字符均以 HTTP 409 失败。真实认证后，先比较预期账户再查询 owner，取得当前图后再比较代际。纯比较通过不会授予 Peer、项目范围或业务权限；派发及每个 WS 逻辑流前仍须执行 `AccountUse.assertCurrent()`。

私有 ingress 持有 `/cloud/auth`、`/cloud/bootstrap`、`/cloud/settings`、`/api` 及原生 `/api/remote.mux` upgrade 注册。每个 handler/继续执行点均检查真实 seal；注册不等待 seal，也不形成 Loader 循环。原始头和 WS query 的全部出现值保留，不互相回退。有界 opaque 代际 token 要求真实 runtime 业务当前检查。请求借用保留到 HTTP 响应/错误结算；已升级 socket 使用独立 Peer 借用。根容量满时关闭 carrier，不排队。

原生最终分派 callback 在实际路由/envelope 选择后复核原请求、登录、Use、代际及图内 `CloudAccountApi`。每个逻辑流检查原 Peer 和每图策略。原生帧上限及 acquire/实际 settle callback 限制全局/账户/Peer 流容量；未知清理保留槽位并调度关闭，不等待自己的 transport。bootstrap 还要求原目录、原生策略及实际安装包证据；C06 settings 保持关闭。

Root ingress watcher 在上次成功复查后等待 `sessionRecheckMs - ingress.sessionRecheckLeadMs`，再发起原 Cookie 的下一次复查。pending 检查不延长登录最大验证年龄；慢查询仍由原同步守卫拒绝。提前量不改变 `authCheckTimeoutMs`。HTTP 和 upgrade 准入先预留有限 carrier 容量，再加入正在进行或已到期的 Peer 原 Cookie 查库复核。派发仍须通过复核时效及原请求/账户检查；WS 逻辑流打开保留同步守卫。

可选的固定预览入口沿用原数据库登录、C02 预期和 AccountUse。请求只选择原生 Session 与服务句柄；原执行拥有者补齐五项分配身份，不准备新工作。应用路径固定为 `/`，端口为8000；响应为有界惰性文本，不传递上游 Cookie、重定向或活动内容。正常预览响应完成后，原消费者继续保留到实际结算；取消和错误仍由同一操作持有到实际关闭。`PeAuthService.inspectRootFetch()` 只向可信账户清单报告当前实际注册；配置和此观察均不发布 bootstrap 可用状态。

### Bootstrap 元数据

选中的原生会话控件要求处理器身份及资源守卫精确匹配已审核声明：模型目录／选择、命令、目标、权限目录、反馈和用户问题操作分别接受审计。producer 拒绝通过命名空间前缀扩大范围，并在发出 bootstrap 前重新检查每个账户 API 的实际注册。计划互动使用原生问题回答 RPC、定时等待流及 Gateway 事件结果 RPC；准入不会凭空提供回答方。原生会话导出仅接受处理器为 `native:sessionLogDownload`、守卫为 `account-session` 的 `GET` 和 `HEAD /api/session.export`，并可与现有精确上传和服务预览路由并存。

`decodeCloudBootstrap(input, limits)` 严格校验 C-11 的账户、版本、代际和能力描述，返回独立副本及深只读数据。显式传入 `maxBodyBytes`、`maxStringBytes` 和合计 `maxListItems`，不补默认值。正文预算计入完整紧凑结果的字段名、分隔符和转义后 UTF-8 字符串。调用方仍须在 `JSON.parse` 前限制原始 HTTP 字节；三项上限均可由其 `maxBootstrapResponseBytes` 派生。

未知字段、错误状态/reason 组合、非 false 的受限能力及非法预算均拒绝，错误不回显输入。解码不认证、不签发代际，也不核验 provider 或 ready。配置应用等级仅描述服务端响应，不提交变更或决定服务端实际应用方式。私有 producer 等待原 `CloudAccountApi.assertBootstrapCurrent`、files/project 成员关系、已安装执行 provider 及有界 Loader/包检查。发送有界 JSON（`no-store`）前再次检查原登录、Root、Use、代际和安装。目录元数据导入在每个 await 前后保留登录、图和 provider 身份复核。完整端点检查在目录核验前及明确的响应发送检查时各执行一次；其间每个 await 仍保留原身份检查及 API 拥有者的原生审计。批准项本身不代表已安装；事实缺失时拒绝整个 bootstrap。

producer 只新增允许精确的 `cloudProjects/create` RPC，以及原生 `workspaceFiles/read`、`stat`、`list`、`readBytes` RPC 和 `workspaceFiles/changes` stream。这两个 namespace 的其他方法及错误的 RPC/stream 类别均拒绝。每个选中条目都经原 API owner 的当前注册审计。只有完整文件组被选中，且原 Files owner 的 `assertContentAvailable()` 通过，包含已结算的 ABI8、content 和 provider 前提时，`filePreview` 才为 available。部分文件组仍显示 disabled；任何选中的文件端点都要求该内容断言。Runtime 在 ready 前也检查相同前提。未选择文件端点的 first-trial 配方保持 preview disabled。项目元数据沿用原字段；配置及其他未批准能力保持关闭。显式 API 模型 Key 策略还可准入其四个精确、已审核 RPC。C11 原生凭据写能力仍为 false；独立服务提供实际只读元数据及编辑状态。

`sample` 和 `managed` 技能批准模式均在相同的原 Loader、包及 provider 检查通过后，投影 `configuration.skills.manage: true`。Sample 模式要求精确的 `cloudSkills/current` 与 `cloudSkills/publish`；managed 模式还要求同一 namespace 下的 `installed`、`details`、`install`、`update`、`uninstall` 和 `download`。每个选中的技能 RPC 保持 handler `native:cloudSkills` 及 guard `authenticated-account`。可选的原生 `skills/list` 在两种开启模式下均保持 handler `native:sessionSkillCatalog` 及 guard `account-session`。缺失方法、未授权声明及 closed 模式的技能端点均拒绝；bootstrap 不增加权限或修改 owner。

服务能力来自原执行拥有者的 `accountServiceAvailability(ctx)`，包含当前原始 `dev_service` 定义，以及安装和消费位置的原 Tools provider。预览还要求原应用 provider 和经 API 审计、仍有效的 GET `/cloud/service-preview` 注册。producer 允许该精确路由与原生上传并存，重新检查每条选中路由，拒绝重复和变体。这些事实仅表示能力已安装；检查不创建服务进程、分配或请求，也不产生 HTTP 就绪结果。

可选的获批 `pluginControl` 策略要求完整且精确的 `cloudPlugins/current`、`cloudPlugins/change` 一元方法组，handler 为 `native:cloudPlugins`，guard 为 `authenticated-account`。producer 在清单读取前后及响应发出前核验两个方法的成员关系和原生当前审计；缺失或越权声明拒绝整个 bootstrap。此校验保留多技能完整八方法、模型 Key 方法组、原账户／图／文件／执行身份、有限预算及关闭的原生配置写入口。它不新增安装／卸载端点、原始 plugin-manager 写入、流或任意后端权限；真实原生就绪仍由原清单和 API owner 确认。

禁用的可选 entry 按各目录项的批准启停许可和实际原生身份检查。bootstrap 不通过固定插件 id 选择特权模块。

Root 解析器可批准有限的原生命名空间／字段对。producer 要求精确的完整 `allowedSettings` 集合，以及 handler 为 `native:settingsController`、guard 为 `authenticated-account` 的原生 `settings/mutate` writer。原生清单要求当前可写的 Settings 表单包含每个获批标量字段；缺失、结构化或 secret 字段拒绝。发出 live 字段能力前仍执行原生 RPC、安装与当前性审计。未经批准的字段和其他 writer 保持关闭，producer 不新增修改 owner 或权限。

### 认证适配器

`BetterAuthAccess.create` 要求 Better Auth 1.7.10、调用方持有的有限 PostgreSQL 池及已解析密钥。它核对已加载库版本、禁用 cookie 身份缓存，并将基础 URL/路径固定为批准源和 `/cloud/auth`。原始 cookie 交给认证库；客户端账户字段不能产生 principal。

`authenticate` 通过 `disableCookieCache` 和 `disableRefresh` 强制查库。`recheckLogin` 使用原 cookie 的固定快照；已准入的验证失败时调用传入的登录失效处理者。`assertLoginCurrent` 在派发前拒绝已到复查时间的登录。Peer watcher 必须调度复查，并在任何拒绝（含容量拒绝）时关闭精确 Peer；本适配器不安装 watcher。

Bootstrap 在账户定位／挂载、目录／原生异步读取及完整投影返回后，通过同一原 Cookie 快照重新校验，再执行最终原生、登录及账户当前性检查。既有 ingress 操作保留真实查询完成责任，包括超时后的迟到结果。此刷新不延长有效间隔，也不替代登录、取消、generation 或账户当前性检查；登录已撤销时仍拒绝响应。

内部 `authenticateForBootstrap(request, requestId, maxDisplayNameBytes)` 与 `authenticate` 共用同一认证操作及库查询，返回常规 principal 和从本次已验证用户名称产生的冻结账户投影。显式正字节上限先检查字符长度，再检查 UTF-8 字节。principal 及其登录记录不增加名称字段；后续认证可观察改名，旧投影保持不变。名称超限返回 `cloud/capacity`；非法上限在查库前返回 `cloud/account-unavailable`。两类失败均不暴露名称或账户 id。

`handleNodeRequest` 在 Host/Origin/TLS/代理检查后，将原始字节交给 Better Auth Node bridge。ingress 提供字节上限和观察者取消；标准 stream 在解析前逐 chunk 计数，并等待真实请求/响应取消。库 bridge 提前返回的 Promise 不释放响应所有权。转发头不决定身份或认证源。生产 cookie 使用 Secure、HttpOnly 和 SameSite=Lax。WS 在认证查库前要求恰好一个匹配的原始 Origin；HTTP 可省略，认证修改的 CSRF 检查仍由库负责。

`sign-in/email` 和 `sign-up/email` 先通过库查询原 Cookie，禁用身份缓存和刷新。有效登录或仍携带旧 session Cookie 的请求返回结构化 `cloud/login-active`/409、`retry: never`，要求真实 sign-out；查询失败不等于匿名。超时或取消后的迟到查询不能进入修改。最初匿名的请求没有共享的服务端转换标识，因此不宣称新 Cookie 签发在跨标签页/跨节点间有原子顺序。

`revokeLogin` 先通过库删除，再由登录会话删除 hook 通知失效处理者。`planMigrations` 返回库生成的计划而不应用。 其 TypeScript 返回类型提供只读发现项分类，以及原始 `runMigrations(): Promise<void>`、`compileMigrations(): Promise<string>` 回调；直接返回库的实际计划对象，发现项记录保持不透明。认证操作只预留一个有限名额，覆盖真实查询及失效收尾；嵌套 hook 不再预留名额。等待超时后，该名额继续计入 `pendingOperations`，直到实际工作结算。`close` 停止准入并等待，不关闭调用方持有的池。认证失败不会取消 Agent 任务。

只有显式预览配置才会为已校验的固定后缀启用 Better Auth 跨子域 Cookie；认证 base URL 和可信 origin 仍为管理域。单独的内部预览认证方法在同一无缓存登录读取前，检查原 Host 和精确 GET 路径；认证写入、bootstrap、原生 HTTP 和 WS 保留管理域传输检查。

### 失败与恢复

Ingress 失败也向 stderr 写入有界请求 id、阶段、错误码及最多六处已编译 Cloud 代码位置。记录不包含错误消息、请求值、cookie 或私有路径，使未安装日志接收器的部署也能定位故障。

在 `ingress.current` 阶段，同一记录仅额外包含原 Root 配方审核的状态、计数和固定问题码，不包含配置和配方版本。审核观察不可用时，仍保留原失败记录，也不改变准入和清理。

登录缺失、撤销或到期返回 `cloud/unauthenticated`/401；信任检查拒绝返回 `cloud/forbidden`/403；验证不可用或超时返回 `cloud/account-unavailable`/503。认证操作、登录状态或失效记录容量满时返回 `cloud/capacity`/429，不进行无界排队。线上错误不包含库原始错误、cookie 或数据库凭据。修改结果未知时须查状态；重连或 bootstrap 均不授权自动重放。

-----

Bootstrap 经同一原清单检查，将每个获批原生字段投影为 `{namespace,path,application:"live"}`。此元数据不授予写权限；原生 Settings 准入负责精确值、版本及当前 Peer 检查。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部信息——点击展开</summary>

按[运行时 debug 观测约定](../pe-cloud-runtime/README.zh.md#understand-the-implementation)，ingress 记录已检查的本机准入或固定 owner 选择及入站 socket 元数据。选路不证明送达；完成记录要求实际传输已完成结算。浏览器是否收到仍需单独观测。

适配器持有认证一致性；runtime 保留 owner/epoch，API 保留端点/资源规则。已验证 principal 带有适配器本地来源跟踪；伪造 JSON principal 无法复查。失效仅针对精确认证会话 ID；有界记录保留至旧实际读取结算。晚到读取不能恢复已撤销登录，其他登录的凭据仍然有效。操作本地的 hook 失败及库错误级信号，阻止已被库捕获的删除失败变成退出成功响应；诊断正文不被记录。原生 Session、队列及事件实现均不归本包。

内部 `LoginPeerRegistry` 按已验证登录、账户及 epoch 合并创建，独立借用生命周期 `AccountUse`，固定首次 principal/cookie。准备中和清理未知的记录均占 Peer 名额；单个调用者超时或退出只结束自身等待。原生 HTTP bridge 和 WS mux 复用同一个真实 `Peer`；socket 断开保留 Peer 及借用。watcher 按配置复查，任意拒绝均关闭精确登录；派发及每个逻辑流前同步检查原登录、账户借用和传入的端点守卫。

可信 `PeAuthService.withModelKeyPeerUse` 经当前 ingress 委派给 `LoginPeerRegistry.withOriginalUse`。精确原 Peer 身份选择已有 Entry 和 AccountUse；复制 id 及其他图的 Peer 均拒绝。Entry 在可重入 callback 前登记实际 task，在原生保存回合内重复原登录/代际/Use 检查，失效后仍保留 Use 到实际结算。不增加借用、释放 owner、账户表或保存队列。

撤销或 lifetime 结束先停止准入并销毁载体，再共同等待原生 mux/Peer 及实际 HTTP 操作清理，最后释放借用。M1 失效回调只等待原生载体/Peer 关闭，不等待可能触发删除 hook 的准备、复查或载体认证。完整关闭另行等待载体实际结算及晚到借用后，才释放 Use。`cloud/stop-unconfirmed` 表示清理失败或清理等待超时；失败保留名额和借用并通知必填诊断回调，超时不代表已释放。有界标志通过公共 Cordis 日志观察 Peer 子树的错误事件；原生 disposer 兑现本身不能证明清理成功。该类及借用回调均只供同包装配，不增加 SDK、客户端授权字段或监听器。

固定预览 GET 在后端 I/O 前通过私有载体回调加入同一登记器。在载体准入内再次认证原请求，正文及外层账户返回均使用 canonical Peer 的登录守卫；登录失效只取消原 HTTP observer/request/response。载体容量及 Peer Use 保留至原 ingress actual 实际结束，包含响应传输及请求 Use 释放；清理未确认时仍保持 blocked。载体正文不等待包含自身的 actual，失效回调仍只等待原生清理。

| 源码 | 职责 |
| --- | --- |
| [bootstrap.ts](src/bootstrap.ts) | 严格有界的 C-11 解码器及独立只读元数据。 |
| [bootstrap-producer.ts](src/bootstrap-producer.ts)、[bootstrap-inventory.ts](src/bootstrap-inventory.ts) | 原图断言、实际 Loader/包清单和有界 C11 投影。 |
| [config-schema.ts](src/config-schema.ts) | 浏览器安全的结构配置 schema。 |
| [auth.ts](src/auth.ts) | 真实库调用、固定登录复查及实际工作保留。 |
| [peers.ts](src/peers.ts) | 内部登录 Peer、独立借用、原生载体和清理保留。 |
| [auth-trust.ts](src/auth-trust.ts) | 固定源传输检查。 |
| [binding.ts](src/binding.ts) | 客户端预期解析与比较。 |
| [root.ts](src/root.ts) | 根持有认证资源的 Loader 入口。 |
| [root-config.ts](src/root-config.ts) | Host 数据库及秘密预算。 |
| [auth-root.ts](src/auth-root.ts) | 真实池/库初始化、schema 检查及实际清理。 |
| [ingress.ts](src/ingress.ts) | 私有共享 Web 所有权、真实 seal 检查及请求保留。 |
| [expectation.ts](src/expectation.ts)、[generations.ts](src/generations.ts) | 原始出现值及有界 runtime 绑定 token。 |
| [body-stream.ts](src/body-stream.ts)、[stream-capacity.ts](src/stream-capacity.ts) | 实际取消及原生流预留。 |

批准配置的交接消费原 invocation Peer 及其实际持有的 AccountUse。本地操作在释放该 Use 前拒绝并行的非观察 carrier；原 registry 等待纯观察 Peer 结束，并且仅在同一原 root/epoch 恢复业务就绪后重新借用 Use。终止接收持有发起 carrier 的实际结算，完整 Peer 关闭在其 RPC 可以返回后才开始。该交接不证明 runtime idle，也不持有配置持久化。 观察 Peer 与发起者 mux 的关闭共用有限 `peerCloseTimeoutMs` 预算。到期返回 `cloud/stop-unconfirmed`，并永久撤销本次交接的写入/恢复检查资格；迟到清理仍由原 Entry/mux 持有，不伪造 Use 释放，也不延后继续写配置。

原 HTTP ingress 独立持有账户引用，直至准确且已认证的配置 Peer 接纳本地交接。仅服务器可访问的回调只释放当前请求自己的引用；原 Peer 任务及工厂操作继续保留实际工作，覆盖响应传输、取消和迟到完成。交接后的检查仍要求同一绑定处于业务可用状态。Peer busy 拒绝保留原 code 和 message，可在 `details.peerWork` 中附带当前账户相关 Peer 的计数：未就绪、准备中、认证复查中、清理异常、存在业务流或其他任务。每项计数均受原每账户 Peer 上限约束，不包含身份或请求正文。

批准的原生 bundle id 复用现有有限 bootstrap 插件元数据列表。`installable: true` 表示预安装的账户选择，不授予包安装接口。实际选择状态及完整成员审核仍由原账户 API 负责；重建接收后须重连并读取当前状态。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Better Auth 登录会话](https://better-auth.com/docs/concepts/session-management)——权威登录查询及撤销。
- [Better Auth PostgreSQL](https://better-auth.com/docs/adapters/postgresql)——数据库集成及迁移。
- [Web 服务器](../../host/webserver/README.zh.md)——共享根监听。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型可见内容

认证、绑定检查及 `decodeCloudBootstrap` 不添加模型可见内容或工具 schema，也不派发 Agent 请求。

#### Token 影响

本包新增的模型输入和输出 token 均为零。

#### KV Cache 影响

请求认证及绑定检查不改变提示前缀或模型缓存输入。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 生产准入要求真实存储权、配方审核及账户发布；这些前提独立于元数据投影。`CloudAccountApi` 及原生分派/流 hook 已接线，不以根策略替代。未 sealed 的 ingress 拒绝业务工作。库初始化及拒绝测试不代表 S1/S2 或完整 F01 浏览器/WS 成功。
- 部署必须对齐监听器 parser／buffer 限制、固定 HTTPS 元数据地址、客户端 CA 及精确 node／service pin。组件测试不签发两个原生 ready 实例或原 factory 借用／释放竞态资格。
- 内部[预览请求](src/preview-access.ts)及[响应](src/preview-response.ts)辅助函数保留原账户和服务借用，生成有界文本及固定响应头；它们不注册路由或开启预览能力，仍须完成 HTTP 适配、origin 隔离以及真实服务与生命周期验证。
- 根拒绝非空库迁移计划，且从不执行迁移。Root 必须提供真实批准的公开控制目录；未列入目录的基础设施仍须通过原 API/files/execution 断言。C06 控制及批准的导航下载载体选择仍待提供；原生 HTTP 当前要求绑定头，WS 使用 query 字段。开放完整链路前，仍须正式生产者/消费者构建及真实 PG/Web 集成验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作上下文——点击展开</summary>

定向测试使用真实 PostgreSQL、原生 Connection/Gateway 和内存 socket 对验证 HTTP/WS 共用 Peer、撤销、到期及清理保留。账户借用是测试夹具，并非产品工厂；尚未通过 Loader 启动账户图或验证运行中的 Agent 任务隔离。

</details>
