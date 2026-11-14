---
description: "按 Session 寻址上传浏览器文件，提供流式接收、进度、取消和供后续 prompt 使用的暂存凭证。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-file-upload

[English](README.md) | 中文

## 概述

本包让浏览器功能为一个 Session 存储 `Blob`、精确字节或 `ReadableStream<Uint8Array>`，并取得供后续 prompt 使用的不透明凭证。普通服务页面发送 Blob 和 stream 请求体时，不会在页面线程聚合全部字节；Host 位于其他执行上下文中的页面会在 Cordis 启动前提供 Fetch 形式的载体。调用方可以观察已消费字节并取消活动操作。stream 请求体只能消费一次，跨 Worker 边界时会转移所有权。图片上传会暂存一张规整后的 prompt 图片，供后续 prompt 凭证引用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

省略插件配置时，原合并回执/接收容量会在激活前规范化为128；显式配置在服务 effects 之前经过同一有限 Schema 校验。文件回执解析为原 `file` 分支及其确切 attachment 引用，而不是裸 attachment 对象。

Host 的 `Config.maxPendingReceipts` 使用目标 Schemastery schema，保留原默认 128 个活动 intake 与暂存回执合计名额，零字节文件和图片同样计入；只接受正安全整数。intake 在源工作前预留，只有确认回执交接后才转交原 Session 记录。回执退休或 Session 释放只归还已知名额；存储、清理或交接未知时保留计费、关闭准入，并在所有者清理时报告不确定性。`AttachmentError.settlement` 只携带显式 unknown 标记，缺失标记不能独立证明清理完成。

受保护 `storeFileStream(agent, input, workspaceDirectory?)` 钩子保留确切文件源、信号和原生存储所有者；调用方等待准入及实际发布，未知工作必须抛出 `FileUploadIntakeUnconfirmedError`。默认 Native 钩子不授予工作区发布能力。`uploadWorkspaceStream` 沿同一钩子执行，不保留对话回执。原始路由接收文件目录/仅工作区请求，保留目标图片路由，不把图片暂存与工作区发布组合。原读取器 return 等待实际 cancel、终态和已开始读取；即使锁释放，源取消失败仍保留，实际 wire 关闭继续由 Connection 持有。

页面可在激活前提供 `ctx.fileUploadHooks`，优先于旧全局 carrier。其可选 `promptImageUploads: false` 经 `FileUploadService.supportsImageUploads` 投影为仅文件草稿；Native Conversation 此时将图片 MIME 文件作为普通文件发送，不创建图片预览或宣称视觉能力。省略时保留 Native 图片草稿与归一化。页面标记不授予 Host 权限，部署必须执行自己的上传策略。

在注入 `fileUpload` 的消费方之前挂载本包，再调用 `ctx.fileUpload.upload(sessionId, body, name, signal, onProgress)`；prompt 图片则调用 `ctx.fileUpload.uploadImage(sessionId, blob, mediaType, name, signal, onProgress)`。Session 标识同时用于寻址原始路由和生成的 Remote 兜底；调用方不组装这两种请求。

```yaml
- id: file-upload
  name: '@deepseek-ai/dsh-client-file-upload'
```

本包没有 Cordis 配置字段。`Blob` 在专用 Worker 内通过 XMLHttpRequest 发送，因此服务可以报告浏览器上传进度，并在浏览器提供总量时一并报告。`ReadableStream` 会转移给该 Worker，再增量传入 Fetch；进度只报告已消费字节，不包含总量。`AbortSignal` 会终止专用 Worker，或传递给页面自己提供的载体。精确字节使用生成的 Remote。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client 插件提供 `ctx.fileUpload`。其 `upload()` 方法接收所属 Session 标识，组装原始路由请求，并为精确字节调用生成的 Remote。提供方只读取一次可选的 Cordis 启动前 `__DSH_FILE_UPLOAD__` 钩子。没有该钩子时，每个 Blob 或 stream 请求拥有一个短期 Worker，并在完成、失败或取消后释放。存在该钩子时，服务通过页面自己提供的 Fetch 载体发送请求体；Web Worker runtime 会通过请求帧转移 stream 请求体，再以带背压的分片形式交给 Host HTTP bridge。

Host 插件提供 `ctx.fileUploads`。它拥有经过认证的流式路由、编码 Remote 兜底、命令凭证解析器与暂存凭证生命周期；编码准入、附件错误识别与字节存储仍由 `ctx.attachments` 提供。带 `mediaType` 查询参数的原始上传最多读取部署配置的单张图片与单条消息图片字节上限中较小的一个，并通过 `ctx.attachments.saveImages` 存储图片；该凭证记录上传的字节数，在 prompt 准入时解析为这张图片，这些字节计入单条消息的图片总字节上限；命令只接受文件凭证。取消的图片上传不会取得凭证：存储开始前取消不存储任何内容，已开始存储的图片会保留。Host 调用方传入具有运行时所属上下文的 Agent；凭证表以该 Agent 的准确 Session 对象为键。Session Controller 注册可恢复休眠普通 Agent 的解析器，并在 prompt 准入时消费凭证。Prompt 投递通过可释放事务持有每个凭证绑定。成功投递提交事务前，释放会恢复原绑定；提交后，队列或历史观察会退休该凭证。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 流式路由、附件服务准入与 Session 所属的凭证生命周期 |
| [`src/types.ts`](src/types.ts) | 编码请求、凭证与持久结果类型 |
| [`src/client/contract.ts`](src/client/contract.ts) | Client 上传、进度与页面钩子类型 |
| [`src/client/runtime.ts`](src/client/runtime.ts) | 专用 Worker 与页面自有载体实现 |
| [`src/client/index.ts`](src/client/index.ts) | Client 插件注册与 `ctx.fileUpload` 声明 |

</details>

每个上传凭证只属于一个准确的 Session，每个请求只使用一个已选定载体。载体不支持的 stream 会在发送请求体前失败。

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connection](../connection/README.zh.md)——认证 RPC、Host 精确路由与 connection generation。
- [Session Controller](../../api/session-controller/README.zh.md)——消费暂存凭证的 prompt 准入。
- [Web Worker runtime](../../experimental/webworker-runtime/README.zh.md)——页面到 Host Worker 的请求隧道。
- [客户端组地图](../README.zh.md)——浏览器服务与 UI 功能包。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只传输浏览器请求体，不提供模型输入。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于传输操作本身。

- **上传不能断点续传**：失败或取消后的重试会从第一个字节开始。
- **stream 请求体只能使用一次**：转移 `ReadableStream` 会锁定调用方的对象，因此重试必须重新创建 stream。
- **stream 进度没有总量**：stream API 不携带字节长度，因此调用方只能收到已消费字节数。
- **浏览器 Worker 必须自包含**：其源代码由函数字符串生成。如果实现需要运行时 import，就必须迁移为由 tsdown 打包的独立 Worker 入口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
