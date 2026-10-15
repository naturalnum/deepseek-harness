---
description: "在浏览器和 Platform 消费者之间校验 PowerEvolve 账号、文件、Office 与云端执行请求。"
kind: package-library
---
# PowerEvolve 传输校验

[English](README.md) | 中文

## 摘要

调用者可以在浏览器和 Platform 使用相同记录校验账号、文件下载、Office 预览与云端执行消息。带品牌标记的标识符区分资源身份，Zod 解析器拒绝无效传输值。按操作导入对应的导出子路径。校验不提供身份认证、归属判断或执行权限；可信 Platform 必须执行这些决定。

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

浏览器客户端、Host 适配器、Platform 处理器和连接器 worker 导入 [package.json](package.json) 声明的子路径。将这个私有库声明为工作区依赖。它不注册插件，也没有 Profile 安装或挂载配置。

按操作选择记录类别；链接的源码拥有字段和校验规则。

| 消费者操作 | 入口 | 拥有者源码 |
|---|---|---|
| 账号身份与认证消息 | `@power-evolve/contracts/account` | [账号记录](src/account.ts) |
| 单文件规范路径与下载元数据 | `@power-evolve/contracts/file-download` | [下载记录](src/file-download.ts) |
| 本人存储与 Workspace 注册 | `@power-evolve/contracts/storage` | [存储记录](src/storage.ts) |
| 工作区文档转换请求与结果 | `@power-evolve/contracts/office-preview` | [Office 记录](src/office-preview.ts) |
| 原 Cloud 执行的检查与对账 | `@power-evolve/contracts/execution-resolution` | [对账记录](src/execution-resolution.ts) |
| MCP 图标、备注与隐藏值的环境变量引用 | `@power-evolve/contracts/mcp-metadata` | [MCP 元数据](src/mcp-metadata.ts) |
| Platform 环境变量直传元数据与字节 | `@power-evolve/contracts/stdio-environment` | [环境变量记录](src/stdio-environment.ts) |
| 有界的字面 STDIO 连接配置 | `@power-evolve/contracts/stdio-management` | [管理记录](src/stdio-management.ts) |
| 固定的 STDIO 目录、任务与首次启动许可 | `@power-evolve/contracts/stdio-mcp` | [任务记录](src/stdio-mcp.ts) |
| worker 租约、SDK 响应与清理观察 | `@power-evolve/contracts/stdio-runtime` | [运行记录](src/stdio-runtime.ts) |
| 确定性的有界 JSON 编码 | `@power-evolve/contracts/stdio-mcp-json` | [JSON 编解码器](src/stdio-mcp-json.ts) |

使用 Host cookie 的产品客户端可以从账号入口导入 `productRpcRequestInit`；调用者仍负责路由、错误处理和响应校验。

执行对账请求标识原 Cloud 执行、稳定请求 ID 与 Platform 计算的写者指纹，不提供替代命令或停止证据。完成回执需要确认写者已停止；`closed_unknown` 保留未知副作用结果。Office 任务绑定来源和转换器代次；结果标记不能证明解析器已终止。

STDIO 任务、选择和派发解析器需要部署选定的 SDK 与 JSON 预算。完整原始目录在 PG `json` 中保留原字段。解析许可、worker 租约或清理观察既不认证签发者，也不授予程序启动权限。Platform 消费者在接受结果前必须核验原派发、当前租约和准确执行器身份。

JSON 编解码器要求深度、节点和 UTF-8 字节预算均为正安全整数。它保留字面字符串和数组顺序，按代码单元顺序排列对象键，并按每次出现计量重复的无环引用。它拒绝环、访问器和非 JSON 值，不调用 getter 或 `toJSON`。无效数据或配置抛出 TypeError；超预算抛出 RangeError，不返回部分输出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>校验与消费者职责</summary>

Zod 和官方品牌工具是运行时依赖。源码模块提供共享解析器与记录，不导入 Platform 服务或保存凭据。推导类型描述已校验值；消费者仍负责资源事务、授权和持久操作状态。镜像匹配助手接收已解析的 Cloud／Linux 记录，比较架构、不可变镜像引用及准确 runtime image ID；原始 wire 值先经过严格 schema。

[构建配置](tsdown.config.ts)输出 ESM，并声明用于执行对账与 Office 预览的独立浏览器模块。可信审批和隔离解析器消费者需要准备好的产物。源码校验不能证明部署的 bundle 或镜像包含当前记录。

Node Application 与 Connector 消费者声明匹配的 Contracts peer；安装根提供生产 provider。受理比较全部 ESM 子路径、schema 引用和 Zod 入口，包括嵌套 helper。源码清单保留 Zod 生产依赖，因此必须另外拒绝私有嵌套 Zod 副本。工厂仍创建不同的 schema，并可能持有调用者可变预算。独立浏览器 bundle 拥有各自的实例；Node peer 路由不会统一这些实例。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [云端应用](../application/README.zh.md) — 授权与原生 Session 适配器。
- [连接器 worker](../connector-runner/README.zh.md) — 受控外部执行。
- [已确认迁移范围](../CLOUD-MIGRATION-PLAN.md) — 纳入能力与排除项。

-----

<a id="model-experience"></a>
## 模型体验

通过校验模型输入或工具结果的消费者间接影响模型。本库不提供自己的提示文本、工具或 Session 事件；消费者负责记录和模型呈现。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待完成工作

消费者必须遵守以下校验限制：

- 解析不建立身份、归属、权限或写者停止证据。
- 浏览器角色或能力字段控制呈现；可信 Platform 在资源事务内重新检查授权。
- 没有已配置服务和当前验收证据，记录不能启用通用 STDIO 执行或文档转换。
- Device、手动产物发布与绑定恢复 API 不属于本轮云端迁移范围。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

同步更新传输记录的消费者。实际命令和当前验收结果保存在迁移证据中；本文参考描述库的消费者义务。

</details>
