---
description: "在隔离云端 worker 中校验固定 STDIO 启动包并执行有界 MCP 调用。"
kind: package-library
---
# 隔离的连接器 Runner

[English](README.md) | 中文

## 摘要

调用者可以在隔离云端 worker 中校验固定 STDIO 启动包、计算完整目录指纹，并执行一次有界 MCP 发现或调用。Worker 拥有者提供审批、当前写者授权、准确执行身份和清理证据。Platform 保留凭据与持久操作状态。本库不允许共享 Host 启动用户程序，也不能把不确定结果转化为重试。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[包导出](package.json)区分 SDK 调用器、派发校验、运行归属和摘要函数。[Sandbox Runner](../sandbox/README.zh.md)在私有镜像内装载云端库，提供配置的令牌、隔离文件系统和进程身份；共享 Host 不得执行 SDK 调用器。本库不注册 Profile 插件或挂载配置。

Contracts 是匹配的 `workspace:~` peer 与开发依赖。Host 和 Platform 在生产清单中显式提供 Contracts、本库和固定版本 Zod。独立 worker 安装必须自行提供同样完整的闭包，关闭 peer 自动安装，并核验实测 ESM 路径和身份。工作区源码测试成功不能认证生产镜像。

`runStdioV2` 接收字面程序、参数数组、绝对 cwd、完整固定目录与 JSON 参数。选项提供全部预算、准确的 `HOME`/`PATH`/`LANG` 环境，以及同步目录校验／指纹回调。不合并父环境；macOS 中 Node 可能添加自己的编码提示。`current` 保留已隔离的 UID/GID；`unix` 将校验后的身份传给 spawn。云端 runtime 要求 Unix 1000/1000。

执行器负责审批、不可变程序／镜像 pin、目录授权、prepare／permit 与持久请求身份。派发和运行叶模块校验原始包、预留唯一写者并限制完整响应；它们不认证 HTTP 调用者或保存 Platform 状态。启动程序本身可能产生效果。调用 `start` 时同步预留写者，再将控制交给 provider 任务；完全相同的重复启动只返回已保留视图。取消等待原任务及其独立清理确认。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>协议校验与执行归属</summary>

[SDK 调用器](src/stdio-v2.ts)使用公开 SDK2 Client 和显式 `legacy` 协商，仅执行一次 initialize 握手。Transport 以 `shell:false` 启动一个子进程，复用公开分帧及消息校验器，严格检查 UTF-8 JSONRPC 并计量原始协议字节。不支持的版本会被拒绝，不启动第二个进程、不重连或重试。发现读取全部分页；调用在恰好一次 `tools/call` 前比较完整固定目录。

原始 schema、metadata、annotations、content、structured content、`isError`、扩展字段和转义 NUL 保持 JSON。`readOnlyHint` 不授予批准；`isError:true` 是已完成 RPC，其工具结果由外层拥有者判定。[摘要叶模块](src/stdio-v2-digest.ts)通过共享编解码器在不同操作域散列完整原始 JSON，不启动进程。审批 HMAC 保留 Platform 持有的 32 字节密钥；执行器不接收它。

回复丢失、取消、目录变化或预算失败保留保守的效果及调用事实，不发布截断的成功结果。清理分别等待配置的 stdin、TERM 和 KILL 截止时间，记录真实子进程 `exit` 与 `close` 事件。缺少 close 时保留 `cleanupConfirmed:false`。SDK close 或直接子进程退出不能终止后代、容器、写者或目录租约；外层停止协议必须确认它们。

现有 [HTTP 函数](src/server.ts)保留单次有界 SSH 与固定只读 `whoami` 行为。`instanceId` 变化保留不确定状态；执行在 `exec` 开始后失败时保留 `effectMayHaveOccurred:true`，包括退出证据缺失。请求正文上限为 256 KiB，SSH 输出上限为 128 KiB／60 秒，固定 STDIO 文本上限为 8 KiB／30 秒。[出口就绪检查](src/egress.ts)需要三次被拒探针；没有独立健康的对照监听器时，任意端口拒绝连接都不能作为充分证据。这些函数独立于通用 STDIO 库，不能证明部署隔离。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [传输校验](../contracts/README.zh.md) — 共享协议值与消费者义务。
- [Sandbox Runner](../sandbox/README.zh.md) — 镜像、写者归属与清理。
- [可信应用](../application/README.zh.md) — 审批与持久状态。

-----

<a id="model-experience"></a>
## 模型体验

通过解释有界 MCP 结果的获授权执行器与 Platform 适配器间接影响模型。本库不添加模型提示、工具或原生 Session 事件；消费者负责展示与记录。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待完成工作

调用者必须满足执行与安装要求：

- 审批、容器／UID 清理、持久恢复和当前写者授权由执行器与 Platform 负责。
- 未知效果必须对账；直接子进程清理不能授权重放。
- Contracts／Zod peer 与源码 fixture 不能认证打包 worker 的依赖图或浏览器单例。
- 文件传输、PTY、端口转发与 Host 本机执行需要另行授权的能力。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

通过云端专用入口运行源码行为测试；源码导入与新构建生产产物分别验收。当前包、worker 和安装证据保存在迁移记录中。

</details>
