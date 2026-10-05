---
description: "浏览器客户端与可信平台共用的 PowerEvolve 协议记录。"
kind: "package-library"
---
# PowerEvolve 协议记录

[English](README.md) | 中文

## 摘要

此私有库提供账号、文件下载与执行对账校验、响应记录、路由名和品牌化标识符。浏览器客户端与可信平台消费相同的定义。它不导入平台服务或 Node API，也不注册 DSH 插件。

## 目录

- [使用此包](#use-this-package)
- [实现](#implementation)
- [限制](#limits)
- [开发说明](#dev-note)

## 使用此包 {#use-this-package}

从 `@power-evolve/contracts/account` 导入账号记录。Zod 解析器拒绝无效协议值，其推导类型描述已校验的值。[账号源码](src/account.ts) 定义字段与路由。消费者声明对此包的工作区依赖和 TypeScript 项目引用。

从 `@power-evolve/contracts/file-download` 导入下载请求及同源 URL 构造函数。[下载源码](src/file-download.ts) 定义规范相对路径、元数据摘要和协议上限。部署限额与授权仍由平台负责，见[文件切片](../S2-COMPLETION.md)。

从 `@power-evolve/contracts/office-preview` 导入 Office 预览请求、任务视图与隔离解析器记录。这些记录绑定稳定请求键、源摘要与转换器代次，不接受用户身份、物理根、命令或镜像选择。明确的解析器预算受固定源文件／PDF 协议上限约束。结果标记不是 Pod 终止证明；释放容量前，消费者须独立核对字节摘要、当前授权和精确解析器终止事实。

从 `@power-evolve/contracts/artifact-document` 导入规范原生产物路径。路径只标识一次发布和其字面文件名，不标识可变工作区源文件。Office 来源受理解析器接受原工作区请求，或固定发布身份、文件名与 SHA-256 的产物请求；混合来源会被拒绝。平台消费者须核验原会话、归属、元数据和已验证字节。路径解析不授权发布内容访问，也不允许相对资源解析。

从 `@power-evolve/contracts/execution-files` 导入 Runner 观察、已核验执行文件记录和条件发布请求。平台通过获授权工作区重新读取候选，再持久化其大小与 SHA-256。记录标识执行后观察到的版本，不证明命令是唯一写入者。扫描缺失或不完整会明确标示。带预期摘要的发布会拒绝已变化的源字节。

从 `@power-evolve/contracts/workspace-binding` 导入私有存储选择与工作区绑定恢复记录。目标只标识本人存储空间及规范相对目录，不包含物理根路径。恢复携带稳定请求 ID 和预期绑定代次；只有完成回执将代次增加一。解析不提供存储归属或旧写入者已停止的证明。

从 `@power-evolve/contracts/execution-resolution` 导入云端与 Device 执行对账请求和回执。请求选择执行提供者，标识原执行、稳定重试 ID 和平台计算的写入者指纹。未指定目标的检查及状态请求保留原云端路由；明确的目标不会回退到另一存储。请求不提供结果、替代命令或停止证明。Host 只读路由与独立审批路由保持分离。完成回执必须确认旧写入者已停止；`closed_unknown` 保留副作用结果不明的事实。Device 结案要求平台已有完整且相互匹配的停止记录。

从 `@power-evolve/contracts/device-execution` 导入 Device 派发、容器登记与停止报告。登记标识持久 Device；每次领取绑定独立进程代次和平台分配的派发 ID。精确容器登记后，启动许可只发放一次。停止报告携带原派发、稳定重试 ID 和非运行状态观察；命令副作用结果不明与写者已停止仍是不同事实。这些记录不认证本机 OS 或 Docker 守护进程。

从 `@power-evolve/contracts/device-lifecycle` 导入私有父进程／Device 生命周期记录。请求关联一个所属启动代次、预期服务实例和稳定请求 ID。就绪要求 Profile 成功启动，且父进程核对实际子进程 PID 与固定 loopback URL。静默快照描述本机异步工作已停止；剩余条目分别携带已持久化的精确容器停止观察、永久禁止启动回执或未确认事实。这些 IPC 记录不携带本机路径、nonce、凭据或命令，不授予资源操作权限，也不是浏览器 API。

Device 派发记录接受可选的 `materials` 不可变技能引用。缺省时保留原 JSON 表示和请求摘要；提供时绑定已受理技能、版本、归档、manifest 和指令。包读取标识原执行、登记、进程与派发，不接受用户 ID、存储路径或下载 URL。单个响应保留原 manifest，最多包含 256 个普通文件，展开总量不超过 8 MiB；JSON 响应的传输上限为 20 MiB。执行前消费者必须校验每个解码文件的字节摘要；解析不提供权限。旧 Worker 不支持这些引用，不能消费此类派发。

## 实现 {#implementation}

运行时仅依赖 Zod 和上游品牌类型工具。TypeScript 一并生成兼容浏览器的 ESM 和声明文件。包构建还生成 `lib/browser/execution-resolution.js` 与 `lib/browser/office-preview.js` 中的独立 ESM。可信审批页通过平台白名单导入前者；隔离解析器将后者作为固定物理资源消费。消费者须先构建包，这些模块没有外部运行时导入。应用为现有内部导入重新导出这些账号定义。此包没有进程状态、凭据存储、授权检查或独立的生命周期不变量。

## 限制 {#limits}

解析不确立身份、归属或权限。可信平台须验证凭据，并在资源事务内检查当前账号。浏览器中的角色或能力字段只控制展示。[账号切片](../S3-ACCOUNT-COMPLETION.md) 定义集成与验收要求。

## 开发说明 {#dev-note}

账号与应用消费者共用同一个 `UserId` 类型。修改协议记录时，须在同一次交付中更新可信页面与平台处理器。
