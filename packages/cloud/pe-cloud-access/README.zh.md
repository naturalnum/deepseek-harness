---
description: "校验云端请求绑定并使用基于数据库的 Better Auth 认证；根准入缺少集成时保持关闭。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-access

[English](README.md) | 中文

## 概述

校验固定源部署输入，在原生业务执行前拒绝陈旧的账户/代际预期。`BetterAuthAccess` 将认证交给固定版本的 Better Auth 和 PostgreSQL，仅从已验证的用户及登录会话记录返回身份。runtime、生命周期及传输准入尚未完成集成时，`/root` Loader 入口拒绝装配。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

通过 `/schema` 使用纯配置及请求预期校验。包入口和 `/root` 导出根 Loader 插件及 `AuthAccessError`。`BetterAuthAccess` 是同包根装配使用的内部实现，不增加 SDK 子路径。`AuthenticatedPrincipal.accountId` 直接使用 runtime 的 `AccountId` 类型。

### 配置

所有配置均显式提供，示例不充当生产默认值。完整 schema 见 [config.ts](src/config.ts)。根入口目前也会拒绝合法配置，因此本包不提供可成功挂载的示例。

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

### 请求绑定

向 `parseRequestExpectation` 提供载体字段的全部出现值；缺失、重复、空值、首尾空白或控制字符均以 HTTP 409 失败。真实认证后，先比较预期账户再查询 owner，取得当前图后再比较代际。纯比较通过不会授予 Peer、项目范围或业务权限；派发及每个 WS 逻辑流前仍须执行 `AccountUse.assertCurrent()`。

### 认证适配器

`BetterAuthAccess.create` 要求 Better Auth 1.7.10、调用方持有的有限 PostgreSQL 池及已解析密钥。它核对已加载库版本、禁用 cookie 身份缓存，并将基础 URL/路径固定为批准源和 `/cloud/auth`。原始 cookie 交给认证库；客户端账户字段不能产生 principal。

`authenticate` 通过 `disableCookieCache` 和 `disableRefresh` 强制查库。`recheckLogin` 使用原 cookie 的固定快照；已准入的验证失败时调用传入的登录失效处理者。`assertLoginCurrent` 在派发前拒绝已到复查时间的登录。Peer watcher 必须调度复查，并在任何拒绝（含容量拒绝）时关闭精确 Peer；本适配器不安装 watcher。

`handleNodeRequest` 在 Host/Origin/TLS/代理检查后，将未经通用解析的正文交给 Better Auth Node bridge。转发头不决定身份，也不动态决定认证源。生产使用 Secure cookie；所有 cookie 均为 HttpOnly、SameSite=Lax。仅显式可信代理可声明固定转发 host/protocol；客户端 IP 跟踪使用实际 socket 地址。WS 握手在认证查库及原生 upgrade 前，要求恰好一个原始 Origin 且等于 `publicOrigin`。普通 HTTP 仍可省略 Origin；认证修改请求的 HTTP CSRF 检查仍由 Better Auth 负责。

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
| [auth.ts](src/auth.ts) | 真实库调用、固定登录复查及实际工作保留。 |
| [peers.ts](src/peers.ts) | 内部登录 Peer、独立借用、原生载体和清理保留。 |
| [auth-trust.ts](src/auth-trust.ts) | 固定源传输检查。 |
| [binding.ts](src/binding.ts) | 客户端预期解析与比较。 |
| [root.ts](src/root.ts) | Loader 入口及明确的未完成装配拒绝。 |

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

`BetterAuthAccess` 及绑定检查不添加模型可见内容或工具 schema，也不派发 Agent 请求。

#### Token 影响

本包新增的模型输入和输出 token 均为零。

#### KV Cache 影响

请求认证及绑定检查不改变提示前缀或模型缓存输入。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 根仍拒绝装配：真实 runtime 借用工厂、manifest/原生选路及有限根请求准入尚未集成；内部 Peer 组件尚未接入根。库级认证检查不代表 S1/S2 或完整 F01 浏览器/WS 流程成立。
- 代理转发仅限已配置固定源；转发客户端 IP 链及跨实例服务身份/选路须另行部署集成。
- 生成的认证 SQL 须经过部署迁移审核及打包。根激活不会运行迁移。调用方须提供有界池配置，并对未知操作继续承担清理责任。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作上下文——点击展开</summary>

定向测试使用真实 PostgreSQL、原生 Connection/Gateway 和内存 socket 对验证 HTTP/WS 共用 Peer、撤销、到期及清理保留。账户借用是测试夹具，并非产品工厂；尚未通过 Loader 启动账户图或验证运行中的 Agent 任务隔离。

</details>
