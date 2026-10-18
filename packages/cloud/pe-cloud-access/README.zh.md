---
description: "校验云端请求绑定并使用基于数据库的 Better Auth 认证；根准入缺少集成时保持关闭。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-access

[English](README.md) | 中文

## 概述

校验固定源部署输入，在原生业务执行前拒绝陈旧的账户/代际预期。`BetterAuthAccess` 将认证交给固定版本的 Better Auth 和 PostgreSQL，仅从已验证的用户及登录会话记录返回身份。`/root` Loader 入口通过 `peAuth` 持有认证资源；可选 ingress 在已有共享 Web 服务上注册。存储及账户前提未完成时，真实根 seal 仍拒绝业务准入。

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

所有配置均显式提供，示例不充当生产默认值。浏览器结构输入见 [config-schema.ts](src/config-schema.ts)；[config.ts](src/config.ts) 保留完整 Host 策略，Node IP 语义不变。根要求 [root-config.ts](src/root-config.ts)、正式 `credentials` 及已部署的 Better Auth schema。省略 `ingress` 保留仅初始化资源的路径；配置后，Loader 条目的 `inject` 必须包含 `webServer`、`peAccountRuntime` 和 `peExposure`，确保 schema 检查时这些真实 provider 已激活。缺失 provider 会使初始化失败。生产业务保持关闭。

| 字段 | 要求 |
| --- | --- |
| `publicOrigin`、`deploymentMode` | 规范 HTTPS 源；HTTP 仅限开发环境环回地址。 |
| `trustedProxyAddresses`、`authSecretRef` | 精确代理 IP；空列表表示均不信任；密钥引用由根解析。 |
| `sessionRecheckMs`、`authCheckTimeoutMs` | 正有限定时器间隔。 |
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
| 可选 `ingress` | 必填正有限值 `maxOperations`、`maxOperationsPerAccount`、`requestTimeoutMs`、`maxAuthRequestBodyBytes`、`maxRequestBodyBytes`、`maxBootstrapResponseBytes`、`maxGenerationBindings`、`maxFrameBytes`、`maxLogicalStreams`、`maxLogicalStreamsPerAccount`、`maxLogicalStreamsPerPeer`；子级容量不得大于父级。配置存在不授予 ready。 |

`peAuth` 通过 `ctx.credentials` 解析认证秘密，每个池物理连接再次解析密码。引用使用正式凭据引用语法；根不读取环境变量或默认连接。池将 schema 固定为 `public`；服务端语句/锁/事务空闲上限负责停止 SQL 工作，不用客户端查询定时器宣称提前结算。启动检查库返回的所有迁移类别，包含索引、不安全变更及 schema 问题，不编译或执行 DDL。迁移须在部署时显式执行。

`PeAuthService.observe()` 暴露资源阶段/计数及 `requestAdmission: 'closed'`。配置 ingress 后，嵌套状态记录实际保留的注册、owner/Web 身份及未结算工作；观察从不递归调用 seal。`close()` 先关闭并撤回 ingress，等待实际 handler、正文取消及原生 Peer 清理，再等待认证/秘密工作，最后执行 `Pool.end()`。超时保留工作；未知清理保留所有权并报告 `cloud/stop-unconfirmed`。仅资源模式不注册路由；两种模式都不创建监听，也不代表账户 ready。

根 `apply` 是返回 `Promise<void>` 的 async Loader effect；Loader 激活会等待认证初始化并观察其拒绝。通过 `ctx.get('peAuth')` 取得提供者，或在可信同进程装配中使用 `PeAuthService.mountRoot`。缺少秘密会使真实 Loader 入口失败并撤回提供者；原生 boot 的必需入口策略决定该入口失败是否拒绝应用启动。

### 请求绑定

向 `parseRequestExpectation` 提供载体字段的全部出现值；缺失、重复、空值、首尾空白或控制字符均以 HTTP 409 失败。真实认证后，先比较预期账户再查询 owner，取得当前图后再比较代际。纯比较通过不会授予 Peer、项目范围或业务权限；派发及每个 WS 逻辑流前仍须执行 `AccountUse.assertCurrent()`。

私有 ingress 持有 `/cloud/auth`、`/cloud/bootstrap`、`/cloud/settings`、`/api` 及原生 `/api/remote.mux` upgrade 注册。每个 handler/继续执行点均检查真实 seal；注册不等待 seal，也不形成 Loader 循环。原始头和 WS query 的全部出现值保留，不互相回退。有界 opaque 代际 token 要求真实 runtime 业务当前检查。请求借用保留到 HTTP 响应/错误结算；已升级 socket 使用独立 Peer 借用。根容量满时关闭 carrier，不排队。

原生最终分派 callback 在实际路由/envelope 选择后复核原请求、登录、Use、代际及图内 `CloudAccountApi`。每个逻辑流检查原 Peer 和每图策略。原生帧上限及 acquire/实际 settle callback 限制全局/账户/Peer 流容量；未知清理保留槽位并调度关闭，不等待自己的 transport。真实目录/能力描述及 C06 控制缺失时，bootstrap/settings 保持拒绝。

### Bootstrap 元数据

`decodeCloudBootstrap(input, limits)` 严格校验 C-11 的账户、版本、代际和能力描述，返回独立副本及深只读数据。显式传入 `maxBodyBytes`、`maxStringBytes` 和合计 `maxListItems`，不补默认值。正文预算计入完整紧凑结果的字段名、分隔符和转义后 UTF-8 字符串。调用方仍须在 `JSON.parse` 前限制原始 HTTP 字节；三项上限均可由其 `maxBootstrapResponseBytes` 派生。

未知字段、错误状态/reason 组合、非 false 的受限能力及非法预算均拒绝，错误不回显输入。解码不认证、不签发代际，也不核验 provider 或 ready。配置应用等级仅描述服务端响应，不提交变更或决定服务端实际应用方式。生产 bootstrap 路由及真实图/代际装配仍未开放。

### 认证适配器

`BetterAuthAccess.create` 要求 Better Auth 1.7.10、调用方持有的有限 PostgreSQL 池及已解析密钥。它核对已加载库版本、禁用 cookie 身份缓存，并将基础 URL/路径固定为批准源和 `/cloud/auth`。原始 cookie 交给认证库；客户端账户字段不能产生 principal。

`authenticate` 通过 `disableCookieCache` 和 `disableRefresh` 强制查库。`recheckLogin` 使用原 cookie 的固定快照；已准入的验证失败时调用传入的登录失效处理者。`assertLoginCurrent` 在派发前拒绝已到复查时间的登录。Peer watcher 必须调度复查，并在任何拒绝（含容量拒绝）时关闭精确 Peer；本适配器不安装 watcher。

内部 `authenticateForBootstrap(request, requestId, maxDisplayNameBytes)` 与 `authenticate` 共用同一认证操作及库查询，返回常规 principal 和从本次已验证用户名称产生的冻结账户投影。显式正字节上限先检查字符长度，再检查 UTF-8 字节。principal 及其登录记录不增加名称字段；后续认证可观察改名，旧投影保持不变。名称超限返回 `cloud/capacity`；非法上限在查库前返回 `cloud/account-unavailable`。两类失败均不暴露名称或账户 id。

`handleNodeRequest` 在 Host/Origin/TLS/代理检查后，将原始字节交给 Better Auth Node bridge。ingress 提供字节上限和观察者取消；标准 stream 在解析前逐 chunk 计数，并等待真实请求/响应取消。库 bridge 提前返回的 Promise 不释放响应所有权。转发头不决定身份或认证源。生产 cookie 使用 Secure、HttpOnly 和 SameSite=Lax。WS 在认证查库前要求恰好一个匹配的原始 Origin；HTTP 可省略，认证修改的 CSRF 检查仍由库负责。

`revokeLogin` 先通过库删除，再由登录会话删除 hook 通知失效处理者。`planMigrations` 返回库生成的计划而不应用。认证操作只预留一个有限名额，覆盖真实查询及失效收尾；嵌套 hook 不再预留名额。等待超时后，该名额继续计入 `pendingOperations`，直到实际工作结算。`close` 停止准入并等待，不关闭调用方持有的池。认证失败不会取消 Agent 任务。

### 失败与恢复

登录缺失、撤销或到期返回 `cloud/unauthenticated`/401；信任检查拒绝返回 `cloud/forbidden`/403；验证不可用或超时返回 `cloud/account-unavailable`/503。认证操作、登录状态或失效记录容量满时返回 `cloud/capacity`/429，不进行无界排队。线上错误不包含库原始错误、cookie 或数据库凭据。修改结果未知时须查状态；重连或 bootstrap 均不授权自动重放。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部信息——点击展开</summary>

适配器持有认证一致性；runtime 保留 owner/epoch，API 保留端点/资源规则。已验证 principal 带有适配器本地来源跟踪；伪造 JSON principal 无法复查。失效仅针对精确认证会话 ID；有界记录保留至旧实际读取结算。晚到读取不能恢复已撤销登录，其他登录的凭据仍然有效。操作本地的 hook 失败及库错误级信号，阻止已被库捕获的删除失败变成退出成功响应；诊断正文不被记录。原生 Session、队列及事件实现均不归本包。

内部 `LoginPeerRegistry` 按已验证登录、账户及 epoch 合并创建，独立借用生命周期 `AccountUse`，固定首次 principal/cookie。准备中和清理未知的记录均占 Peer 名额；单个调用者超时或退出只结束自身等待。原生 HTTP bridge 和 WS mux 复用同一个真实 `Peer`；socket 断开保留 Peer 及借用。watcher 按配置复查，任意拒绝均关闭精确登录；派发及每个逻辑流前同步检查原登录、账户借用和传入的端点守卫。

撤销或 lifetime 结束先停止准入并销毁载体，再共同等待原生 mux/Peer 及实际 HTTP 操作清理，最后释放借用。M1 失效回调只等待原生载体/Peer 关闭，不等待可能触发删除 hook 的准备、复查或载体认证。完整关闭另行等待载体实际结算及晚到借用后，才释放 Use。`cloud/stop-unconfirmed` 表示清理失败或清理等待超时；失败保留名额和借用并通知必填诊断回调，超时不代表已释放。有界标志通过公共 Cordis 日志观察 Peer 子树的错误事件；原生 disposer 兑现本身不能证明清理成功。该类及借用回调均只供同包装配，不增加 SDK、客户端授权字段或监听器。

| 源码 | 职责 |
| --- | --- |
| [bootstrap.ts](src/bootstrap.ts) | 严格有界的 C-11 解码器及独立只读元数据。 |
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

- 真实配方审核仍拒绝缺失的生产存储权；账户生产前提仍独立存在。`CloudAccountApi` 及原生分派/流 hook 已接线，不以根策略替代。已注册的 ingress 仍拒绝业务工作。库初始化及拒绝测试不代表 S1/S2 或完整 F01 浏览器/WS 成功。
- 代理转发仅限已配置固定源；转发客户端 IP 链及跨实例服务身份/选路须另行部署集成。
- 根拒绝非空库迁移计划，且从不执行迁移。真实 C11 目录/能力描述、C06 控制及批准的导航下载载体选择仍待提供；原生 HTTP 当前要求绑定头，WS 使用 query 字段。开放完整链路前，仍须正式生产者/消费者构建及真实 PG/Web 集成验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作上下文——点击展开</summary>

定向测试使用真实 PostgreSQL、原生 Connection/Gateway 和内存 socket 对验证 HTTP/WS 共用 Peer、撤销、到期及清理保留。账户借用是测试夹具，并非产品工厂；尚未通过 Loader 启动账户图或验证运行中的 Agent 任务隔离。

</details>
