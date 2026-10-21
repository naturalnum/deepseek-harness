---
description: "校验云端浏览器限额并检查固定绑定的原生载体，不启动未绑定的客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-client

[English](README.md) | 中文

## 概述

在启动原生 `AppWebEntry` 前，通过有界、正式解码的 bootstrap 响应准备一个 Cloud 页面。`/client` Loader entry 消费这一精确 owner，并用捕获的账户／代际 carrier 安装既有原生 Connection。缺失或退役的准备状态会拒绝。本包不实现登录表单，也不证明后端账户已就绪。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

Cloud Loader 另挂载生成的 API 项目创建贡献，并向两个原生 Workspace 目录流程 slot 注册本地化标题表单。返回的原生 Workspace 路径交原 `onPicked` 回调采用，保留原生幂等登记。空白或超长标题不提交；每次打开最多上报一次成功分配。取消会中止请求 signal 并忽略迟到的采用结果，实际工作仍由原 transport 与服务端拥有者追踪。已提交创建失败或取消后，该流程实例禁止重提并提示刷新检查项目，不重放未知分配。

-----

<a id="use-this-package"></a>
## 使用本包

`/schema` 导出提供浏览器安全的公共配置校验；`/types` 包含其配置类型。Host 入口声明浏览器包，并可选地注入公开 Web 部署输入，不提供业务服务或认证路由。

### 适用场景

先从原始原生模块表导入本包公开 `/client` 命名空间，再在 Cordis 激活前调用 `PreparedCloudPage.prepare(input, signal)`。其 `ready` promise 在 bootstrap 请求结算后交付已解码页面 owner，并不证明服务端账户图就绪。用同一张表构造 `AppWebEntry(container, { ...page.nativeOptions, modules })`，随后等待 `page.start(entry)`；不能第二次调用 bootstrap facade 的 `create()`。保留 preparation，并在替换页面前等待 `preparation.dispose()`。只有 Cloud `/client` entry 安装 Connection；Host 通过 `registerClientPackages(..., { activate: false })` 声明原始 Connection 模块，使其普通插件不被激活。

### 最小配置

受控预览导航还要求显式 `client.servicePreview` policy（管理/预览源、精确 `/cloud/service-preview` 路径及字段/URL 字节上限）、bootstrap 的 `servicePreview: available` 观察，以及 `PreparedCloudPage.prepare` 中由应用拥有的 `previewNavigation` port。缺少输入时不提供可选 `servicePreviewNavigation` 回调，C11 不增加 policy。回调只接受框架 Session 与记录的 service handle，捕获原页面 C02 值并收纳导航/反馈失败；应用 port 提供同步普通 GET 导航和本地化反馈，服务端仍须执行登录、原生 Session 与原注册服务校验。

Cloud Web 应用在准备页面前捕获所属文档的导航函数，以 `noopener,noreferrer` 在独立标签页打开预览，本地拒绝显示在既有本地化页面顶栏中。浏览器插件仅在准备好的回调、能力和页面均有效时贡献原生 `dev_service` 工具行。操作使用有界的已记录任务元数据和框架 Session；历史行及进程提交均不证明授权或 HTTP 就绪。页面撤销或 slot 撤回会使已挂载回调失效。

Host 可选字段 `web` 通过一个结构化 `__DSH_CLOUD_WEB__` 全局值选择既有 `apps/web` Cloud 入口。省略时保留普通启动。`parseCloudWebManifest` 要求显式提供 `client`、`decodeLimits`、`persistenceLimits`、`fields` 与 `auth`；认证预算为 `requestTimeoutMs`、`maxRequestBytes` 与 `maxResponseBytes`。固定 bootstrap 路径为 `cloud/bootstrap`，绑定字段必须与 access 配置一致。不支持的身份、token 与当前账户字段会被拒绝。

带有 `web` 的 Host Loader row 必须显式声明 `inject: ['clientModules']`。声明使用原始 registry 及其 Loader 树的可信解析 base，以 `activate: false` 登记原生 Connection，并以 `activate: true` 登记固定的一组 BFF 浏览器服务，不加载对应 Host 服务。同一个依赖作用域拥有全部登记和公开注入。实际登记完成后 Cloud row 才激活；卸载须加入异步撤回。缺少依赖声明或登记失败时拒绝，不发布公开 manifest。没有 `web` 时，声明不要求 registry，也不登记模块。浏览器输入不能选择包名或解析路径。

固定服务包含 Conversation 依赖声明要求的原始 `fileUpload` 浏览器 provider。供应该 provider 不授予上传路由或 RPC 权限；原生 Worker 仅在请求上传时启动。UI Host 声明仍由部署选择，`PreparedCloudPage` 仍是 Connection 的唯一安装者。

应用拥有本地化 Cookie 登录与退出控件。它丢弃有界认证响应正文，再使用原始动态 factory 和正式准备流程。`/client` 重导出同一 factory 的 `ClientFailure` 与 `ClientFailureCode`。退出先撤销并加入原页面清理，再执行真实 sign-out。未知 mutation 不会重放；显式状态恢复通过重载执行只读 bootstrap。有效登录 Cookie 仍存在时，服务端必须拒绝身份替换，包括跨标签页替换。 普通刷新保留本代际缓存。BFCache 保留的文档停止旧原生图，并要求显式检查状态后恢复。

原生浏览器 Loader 用 `{ name }` 创建 entry，不传每项配置，因此 `/client` 接受空配置并拒绝覆盖。将下表全部字段显式传入准备输入的 `config`；`/schema` 负责校验，不提供生产默认值。准备还要求显式 `decodeLimits`、`persistenceLimits`、绑定字段名、真实存储、fetch 和 WebSocket 工厂。在 `prepareContext` 绑定准备好的 owner 前，不准入原生缓存读取或 Connection。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `bootstrapPath` | 必填 | 文档相对路径的静态 bootstrap 路由，不含 query 或 fragment。 |
| `bootstrapTimeoutMs` | 必填 | 结果截止时间；实际请求清理仍独立追踪。 |
| `maxBootstrapResponseBytes` | 必填 | 解码前最多读取的 bootstrap 响应字节数。 |
| `maxErrorResponseBytes` | 必填 | 最多检查的 HTTP 409 响应字节数。 |
| `maxPendingFetches` | 必填 | 等待响应头或本包错误正文处理的 fetch 数量上限。 |
| `maxSockets` | 必填 | 单个固定载体拥有的 socket 数量上限。 |
| `closeTimeoutMs` | 必填 | 关闭观察截止时间；到期不代表清理已确认。 |
| `maxDownloadBytes` | 无默认值 | 可选的正安全整数下载接收上限；省略时不注册两个下载动作。 |

-----

Cloud entry 仅在显式提供 `maxDownloadBytes` 且 bootstrap filePreview 为 available 时，向原生文档预览 actions 和 unpreviewable slots 安装下载动作。注册适配器以框架注入的 SessionId、owner.absolutePath 和原生 `sessionFileAddress` 构造地址，捕获唯一原 readBytes 方法及已准备 transport 的 signal，不读取全局选中 Session。其独立 `CloudFileDownload`/`FileDownloadButton` 只请求完整字节并保存 `application/octet-stream` Blob。更小的消费者接收上限不替代原生读取及 body 内存限制。每次读取保留至结算；页面撤销、声明退出、替换和卸载均丢弃迟到结果，并回收临时锚点/Blob URL。文案归 cloud-file-download namespace，并随 Cordis scope 撤销。发起浏览器保存不证明操作系统已写入文件，也不能回滚已发出的请求。旧七字段输入仍合法且不注册下载；原生预览与服务端授权保持权威。

<a id="understand-the-implementation"></a>
## 理解实现

本包将 bootstrap 请求结果和原生载体生命周期与权威账户、Session 状态分开。

`/client` 为 Cordis 启动前的拥有者导出 `PreparedCloudPage`，以及它复用的既有 `CloudPageLifetime` 和 `CloudPagePersistence` 组件。准备流程调用 access 的正式 `decodeCloudBootstrap`，只创建一个固定生命周期和缓存端口，并提供包含必需端口、激活前 owner 绑定和销毁前同步撤销存储与 carrier 准入的原生选项。真实 Loader 的 `apply` 核验 owner 后，以捕获的 hooks 调用公开 `installConnection`；不写全局当前账户或全局 transport。

缓存接受有限正安全整数 `maxKeys`、`maxKeyBytes`、`maxValueBytes`、`maxTotalBytes` 和 `maxNamespaceBytes`。字节预算按 UTF-8 计算；总量包含物理命名空间键和序列化 envelope。键保持逻辑形式，枚举只暴露该命名空间。账户／代际元组使用不会发生分隔符碰撞的 JSON 编码。不恢复旧的未分区缓存。每次变更原子替换一个有界 envelope；同账户／同代际页面并发使用后写覆盖的完整快照，可能丢失独立更新。撤销仅作用于已签发的本地端口，不宣称跨标签页全局撤销。

`dispose()` 同步撤销旧端口，停止捕获的 carrier 与原生图，等待其实际清理，然后仅移除并核验旧命名空间。自动 401／stale-generation 关闭和缓存失败进入同一流程。迟到原生订阅不能通过已撤销端口写入或删除。停止失败时保留命名空间；移除失败时保留未确认状态。原生 disposer 挂起时继续等待。清理错误通过返回的 promise、页面／缓存快照和默认启用的控制台报告保持可观察。相同账户／代际刷新恢复自己的缓存；不同代际获得另一个命名空间。

<details>
<summary>实现细节 — 点击展开</summary>

内部 bootstrap attempt 只发起一次同源、文档相对路径的 GET，不自动重试。调用者提供类型拥有者的解码器；本包不定义替代 bootstrap DTO。取消或超时使结果拒绝，而 `settled` 追踪实际 fetch/body 结束，`cleanup` 独立记录已确认或仍不明的清理结果。晚到数据不能调用解码器。响应有显式字节上限。

内部原生 transport 捕获 access 包的 `RequestExpectation` 和 `BindingFieldNames`。它保留原生 RPC 正文及请求关联，为 HTTP 添加专用头，为原生 WS 和导航 URL 添加专用 query 字段。预期值冲突、外部源或应用挂载路径外的请求在发送前拒绝。HTTP 401 和 `cloud/stale-generation` 使原绑定生命周期失效；其他 409 响应保留原字节供原生处理。它不替换旧请求预期值，也不重放修改。transport 开放期间，每次 socket 关闭都会请求一次正式 bootstrap 身份复核；同时最多保留一个检查，直到其实际 fetch 与正文清理结束。HTTP 401 响应头立即撤销旧页面，解码后账户或代际不符同样使旧绑定失效。身份一致或网络错误、超时、HTTP 503 等暂时失败时，保留捕获的绑定和原生重连策略。响应清理未确认仍会停止载体并保留清理失败。

关闭时立即拒绝新操作、取消在途 fetch 和身份复核，并请求 socket 关闭。关闭会等待每个检查的实际结束，包括迟到响应的取消，而不把检查结果的提前返回当成清理完成。缺少结束确认时状态为 `unconfirmed`；实际工作仍被追踪，稍后结束可确认关闭。这只说明载体清理，不证明 Agent 已取消或账户已排空。限额覆盖等待响应头的 fetch、socket、bootstrap 字节及检查的错误字节；成功响应正文和原生订阅生命周期仍由原生应用持有。

fetch 正文已被捕获 signal 的同一个取消原因置为 errored 时，按其终态确认，不再调用源取消。实际 source cancel 拒绝仍保留清理未确认，即使返回同一个原因；区分依据为原 reader 的 closed/errored 结算，实际取消工作仍被等待。

| 源码 | 职责 |
|---|---|
| [浏览器入口](src/client/index.ts) | 消费已准备的 owner，并安装原始 Connection。 |
| [Bootstrap attempt](src/client/bootstrap.ts) | 分开追踪结果、实际结束和清理。 |
| [固定载体](src/client/transport.ts) | 在原生载体外添加 access 预期值。 |
| [行为测试](tests/transport.client.spec.ts) | 检查原生 Connection envelope 与生命周期拒绝。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

账户检查与原生浏览器行为由以下页面所属模块持有，本包只消费相应能力。

- [Cloud access](../pe-cloud-access/README.zh.md) — 请求预期值与认证的职责归属。
- [原生 Connection](../../client/connection/README.zh.md) — 原生 HTTP/WS 载体与连接代际。
- [Web Client 架构](../../../docs/subsystems/web-client.zh.md) — 原生应用启动与状态归属。

-----

<a id="model-experience"></a>
## 模型体验

### 不提供模型上下文的浏览器传输

#### 模型所见

本包不向模型提供任何内容。`/client` 不注册提示词或工具，`BoundTransport` 只向 HTTP 头或 WS/导航 query 字段添加一致性值，并保持原生 RPC 正文不变。

#### 令牌影响

直接令牌开销为零。bootstrap 校验、绑定捕获和载体清理不添加系统文本、工具声明、保留的 Session 内容或独立模型请求。

#### KV 缓存影响

本包不追加或替换模型请求令牌，也不发起独立模型请求。它不添加改变前缀的内容；模型装配、提供方缓存可用性与复用由包外负责。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下限制仍超出本地 bootstrap 与原生入口接线的范围。

- 正式解码器校验元数据，不验证认证、代际签发或 provider 实际可用性。Root 必须在真实认证账户准入后才提供 bootstrap。
- 原生 Web kernel 必须在 `bootClient` 前等待 `prepareContext`。缺失 owner、错误端口、重复 Connection provider 或退役页面生命周期均被拒绝；插件字面顺序不授予准备权限。
- resources、upload Worker 和 downloads 仍须通过同一绑定协调准入。本包不新增独立 mux 或替代 Session UI，也不发布完整 Web 验收结论。
- 生产浏览器装配和 S1/S2 验收需要独立集成证据。组件清理与缓存测试不能证明完整账户准入或服务端排空。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

云端客户端通过 access 包的 `/types` 消费现有绑定类型。根源码别名、编译聚合、锁文件登记、公共 bootstrap 字段及构建产物由包外统一协调。

</details>
