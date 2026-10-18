---
description: "面向维护者的云端文件工作有界调度与生命周期诊断，说明账户 port、预算及生产启用前置条件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-files

[English](README.md) | 中文

## 概述

维护者可以检查账户各代文件工作的有界准入、取消与排空结果。调用者取消不会删除实际工作记录，仍被持有的结果继续占用字节预留。维护者可以预建一个有界 Linux worker 池，通过绑定固定根的内部 reader 检查元数据并流式读取有界文本。在可信 runtime port、完整原生文件系统与存储证明接通之前，账户文件系统仍不可启用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`/root` 与 `/account` 是 Loader 插件入口。在 Linux 上，`/root` 要求 runtime 注册服务、经过审核的 ABI 4 helper 二进制及显式池限额。它在全部配置 worker 启动之后注册唯一 files 参与者。`/account` 因可信文件系统集成不完整而继续拒绝启用；根池启动不证明账户就绪。

[FilesLimits](src/types.ts) 的所有字段都必须显式提供有限的正安全整数。每个 lane 的并发数、队列容量与驻留字节不得超过对应全局限额；等待时间必须在 Node 定时器的范围内。[根配置 schema](src/root.ts) 还要求 worker 数量、最低健康数、worker 及回复预留、握手及排空期限、helper 位置和读取、路径、分块及重试限额。全局驻留限额包含固定 worker 预留；剩余容量限制账户工作。配置的预留必须保守覆盖缓冲区、克隆、解码及被持有的结果。

账户文件系统启用之前，必须接通可信账户及根 port 签发、完整目录 anchor 归属、原生 `FsTarget` 来源校验及配额证明。账户入口不接受客户端选择身份或路径。本包复用原生 `FileSystem` 类型，不提供宿主文件系统回退。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[工作队列](src/work-queue.ts) 在准入前预留全局及每个 lane 的字节，限制并发与排队工作，取消排队任务时不启动它，并在调用者取消或超时后继续追踪运行中的工作。每次操作都要求包含自身开销的正安全整数预留。零预留在后端调用前被拒绝，因此保留的记录不能绕过驻留预算。成功结算的结果会保留其预留，直至消费者释放结果。关闭 lane 会停止新工作并保留未结算记录；关闭队列则停止所有 lane。

各个结算观察者独立运行：某个观察者失败会被报告，但不阻止预算释放、后续观察者或排队工作。错误报告器失败时，默认启用的诊断日志提供兜底，不暴露原始异常文本。在延迟调用后端之前，最后一次取消检查会阻止已取消工作启动。

[文件工作所有者](src/work-owner.ts) 消费 runtime 持有的账户绑定、operation-id、参与者及收据类型。它把作为内部对象能力的 lane 绑定到精确代际及可信当前 owner 回调，在原代仍持有工作时拒绝另一代，并在实际工作及被持有结果结算之前报告 unknown。生命周期取消会停止准入；排空等待超时后会移除其结算观察者，工作所有者仍继续追踪实际工作。

该内部工作 port 无法选择另一账户或关闭共享队列；它不是原生文件系统，也不是已签发的存储能力。队列计量预留，不在任意回调内部强制分配大小，因此只有经过审核的有界后端才可提交生产工作。

私有 [Linux worker](src/file-worker.ts) 在启动时探测必需的内核操作，不保留账户目录。[ABI 4 N-API helper](native/fd.c) 核验固定根身份，并使用 `openat2` 在该 anchor 之下操作，不回退魔术链接解析或可移植后端。元数据通过 `O_PATH` FD 取得，为目录或单硬链接普通文件返回原生版本字段；路径缺失返回 undefined，特殊文件及硬链接被拒绝。非流式读取在回复前关闭 FD 及 anchor；流式读取保留单个 FD，直至实际 EOF、取消或 worker 退出。

同一绑定 lane 还提供只读 [directory port](src/directory.ts)，包含 `canonicalPath` 与 `isDirectory`。helper 有界观察 FD 的物理拼写，在同一 anchor 下重开并比较身份，复核 anchor，关闭描述符后才成功。目标 ENOENT/ENOTDIR 可以是确定缺失或非目录失败；anchor 丢失、验证失败、容量、旧代、取消及传输故障继续作为 unavailable 并保留 cause。私有 `DirectoryMetadataFailure` 记录原因与失败阶段。该 port 没有 `ensureDirectory`，不能安装为完整的原生 Workspace 目录依赖。ABI 4 的路径及关闭行为仍须由主控在真实 Linux 验证。

绑定 port 暴露内部 [reader](src/read-only.ts)，提供 account-instructions 所需的原生 `resolve`、`stat`、`streamText` 及 `processPath` 方法签名。解析只在预先授权的根内进行并签发 opaque target；每次后续操作核验精确签发 reader 与当前 epoch。绝对路径不能选择另一项目。该适配不提供完整文件系统服务，也不签发可信根。

[共享根池](src/worker-pool.ts) 预建固定数量的 worker，并在绑定账户之间复用。绑定及读取不创建 worker；失败的 worker 不自动替换。每次操作只从队列申请一次请求及结果缓冲区预留。文本流在两次 pull 之间保留 slot，只授予一块 credit，以 `readChunkBytes` 限制每块，并以 `maxReadBytes` 限制完整原始内容。它最多读取总上限加一字节，跨块解码 UTF-8，并沿用原生严格解码与前 8192 字节 NUL 采样规则。消费者提前返回会取消操作，不宣告 FD 已关闭。 I/O 关闭后，暂停的迭代器继续为其解码块保留同一预算，直至迭代结束或返回。消费者必须结束或返回其迭代器。[传输层](src/worker-client.ts) 在取消后等待真实回复或实际退出；畸形回复及 worker 错误停止准入，迟到回复不能逆转传输失败。账户排空关闭该代际并向实际 I/O 发出停止信号，同时保留共享池。

[根 effect](src/root-lifecycle.ts) 保留固定 worker 预留及 files 参与者，直至所有 worker 实际退出、全部账户工作及被持有结果结算。有界关闭可以报告 unknown；effect 继续持有清理责任，并在实际关闭之前保留注册与根服务。该生命周期行为不验证存储配额，也不授予项目根权限。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [原生文件系统](../../fs/fs/README.zh.md)：provider 行为及原始文件类型。
- [账户 runtime](../pe-cloud-runtime/README.zh.md)：账户标识与必需参与者归属。
- [架构](../../../docs/architecture.zh.md)：插件装配与能力归属。

-----

<a id="model-experience"></a>
## 模型体验

### 文件操作

#### 模型看到的内容

`/root` 与 `/account` 入口不注册工具、提示词、模型上下文或文件系统 provider。根池启动不会启用模型文件操作；缺少必需生产集成时，账户入口拒绝启用。

#### Token 影响

不直接增加 token。

#### KV Cache 影响

本包不增加模型请求内容，也不改变可复用的请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下集成缺失时，生产启用持续关闭。

- 共享根池提供内部元数据、只读物理目录观察及有界字节和文本读取。批准目录 ensure、创建责任及完整 Workspace 目录适配仍延期。其余原生文件系统方法、完整 target 及写入语义、链接竞态验收、完整分配计量与字节及 inode 硬配额尚未完成。
- 账户绑定与收据类型来自 runtime 包。根入口在 worker 启动后注册 files 参与者，但投入生产前，仍须由可信工厂签发经过批准的存储及根能力，并接通完整后端。
- 原生 FileSystem 适配、完整流式及目录和写入计量、附件接收与暂存、指令、技能投影及部署存储证明仍不可用。helper 二进制必须由已审核的 Linux 部署配方构建并固定；本包不分发已经验证的二进制。
- 真实 Loader 生命周期检查及 Linux tmpfs syscall 测试覆盖元数据及版本观察、跨 rename 的单 FD 文本读取、文件增长限额、UTF-8 校验、池复用、实际 worker 故障及期限内 unknown 结果。它们不证明 ext4/NFS 隔离、阻塞的 NFS syscall、硬配额、F02、F03、F05、账户就绪或 Web 流程成立。启用之前仍须检查完整生产装配及发布产物消费者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
