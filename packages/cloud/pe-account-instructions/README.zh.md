---
description: "配置有限指令来源预算，并确认账户文件指令保持关闭的原因。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-account-instructions

[English](README.md) | 中文

## 概述

可信账户/项目核验及受限只读文件访问接通前，文件指令不可用。缺失前置能力会在读取任何指令文件之前产生配置错误。必须保持指令配置行禁用；本包不发现宿主 home，不上溯项目父目录，也不分配沙盒。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`/session` Loader 入口始终以 `cloud/invalid-config` 拒绝激活：账户/项目适配和受限只读 files 适配尚未接通。部署必须禁用此配置行，并排除原生自动指令发现；空结果或等待注入的警告均不能启用指令。根入口只导出配置及指令数据类型，不挂载行为。

### 最小配置

持有者适配接通前，不存在可成功挂载的配置。[配置 schema](src/config.ts) 要求显式提供下列五个限制；值必须为正安全整数。这些限制不替代 files 持有的全局/账户准入、流 credit 或实际存储隔离。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxFiles` | 必填 | 声明的候选目录上限，含文件缺失的目录。 |
| `maxFileBytes` | 必填 | 单个获选文件可接受的 UTF-8 字节上限。 |
| `maxTotalBytes` | 必填 | 一次加载保留的全部源正文 UTF-8 总字节上限。 |
| `maxSnapshotBytes` | 必填 | 完整原生消息的 UTF-8 JSON 字节上限，含元数据与重复正文。 |
| `maxResidentBytes` | 必填 | 准备与交付期间可用的单快照保守字节/文本存储预算。 |

读取源文件前，`maxResidentBytes` 必须覆盖 `32 × maxSnapshotBytes + 4 × maxTotalBytes + 2 × maxFileBytes`。该计划包含十六份完整消息按 UTF-16 上界计算的等价副本，以及源分块/拼接和 hash 缓冲。它计入标签、hash、元数据、包装、原生冻结、日志/请求交付及序列化暂存，不测量 JavaScript 对象开销或整个进程的 RSS。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

包内读取器只接受 API/files 持有者已授权的目录目标，再按平台、账户、项目排序。项目标签必须构成完整的项目根至 cwd 链；该展示检查不授予目录目标权限。对每个目录，存在 AGENTS.md 时，即使为空，也不读 CLAUDE.md。仅确认缺失才允许后备候选。provider 故障、特殊文件、取消和超额均使整个操作失败，不返回部分结果。不直接访问宿主文件系统，不发现 home，不创建项目，不上溯父目录，也不分配沙盒。

快照构建器在拼接渲染文本或克隆最终消息之前，计算完整编码消息的大小。每个来源的 hash 对应实际保留的正文，完整快照保存在原生生产者来源字段中。`snapshot.totalBytes` 计入模型可见渲染文本及其标签和包装；`maxSnapshotBytes` 还覆盖全部 JSON 元数据和重复内容。

pre-step 适配先调用 waterfall 后续处理，为每个真实 Session 的每轮准备一次不可变原生消息。仅在精确消息进入原生 `user/message` 日志后才标记已接受；decision 中被丢弃的快照可在后续步骤再次提交同一份内容。每个准入步骤重新检查持有者的准入状态。取消信号合并本轮、账户代际及插件生命周期；`turn/end` 清除派生缓存，包括失败的准备 Promise。退出会取消准备并等待可观察工作实际结束。files 仍持有实际全局预留及 I/O 排空责任；这些 helper 不新增授权协议或上下文队列。

| 源码 | 职责 |
| --- | --- |
| [session.ts](src/session.ts) | Loader 激活及缺失适配时的明确失败。 |
| [load.ts](src/load.ts) | 有序候选选择和有界源正文读取。 |
| [snapshot.ts](src/snapshot.ts) | 完整 C-09 内容与原生不可变消息构造。 |
| [budget.ts](src/budget.ts) | 编码消息大小及保守副本计量。 |
| [injection.ts](src/injection.ts) | 原生 pre-step 接线及准备工作生命周期。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

以下参考文档说明本包使用的原生生命周期与上下文。

- [架构与扩展点](../../../docs/architecture.zh.md) — 插件状态归属及原生轮次流程。
- [Session 子系统](../../../docs/subsystems/session.zh.md) — 持久消息与生产者。
- [工作目录](../../../docs/subsystems/working-directory.zh.md) — 当前目录与原始项目身份。

-----

<a id="model-experience"></a>
## 模型体验

### 指令上下文

#### 模型所见

正式 `/session` 入口仍拒绝激活。包内 fixture 使用的原生消费者每轮追加一次 instructions 形式的上下文，在元数据与标题中保留平台/账户/项目来源。空来源集合在同一介绍之后使用 `No optional instruction files are present.`，使下一轮明确替代此前的可选指令。完整包装如下：

##### 完整快照包装

```markdown
Complete instruction snapshot for the current turn. Earlier instruction snapshots are historical.

[<kind> "<relativeName>"]
<verbatim source text>
```

#### Token 影响

正式禁用入口不增加 token，也不调用模型。包内消费者在每个进入的轮次添加一次完整且有界的渲染文本；工具后续步骤和请求重试沿用同一快照。

#### KV Cache 影响

包内消费者追加当前快照，不改写旧消息或系统提示词。新轮次追加更新后的指令；provider 缓存可用性不由本包保证。正式禁用入口不改变模型前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

下列约束阻止文件指令启用。

- **持有者接线** — API 持有的可信 Agent/Session 项目解析器，以及 files 持有的私有指令只读能力尚未接通。通用原生 FileSystem 不满足这些前置要求。快照数据使用 runtime 持有的 AccountBinding 类型与原生 WorkspaceId，持有这些数据不代表获得权限。
- **共享预算与 I/O** — 单快照文本计划是保守值，不是 RSS 测量或进程上限，也不取得 root files 的全局/账户预留。真实 port 必须预留声明的字节、落实有限流 credit 与 FD/版本限制，并将实际 I/O 追踪到排空结束。files worker 缓冲、实际硬配额及其他消费者不在此 fixture 的证明范围内。
- **验收** — [包内原生日志 fixture](tests/fixtures/recorded/session.v4.jsonl) 使用有界内存 reader 核对编码消息及原生重建。它不是发行 Profile 的快照，也不证明真实 files 授权边界。账户/Preset 装配、完整恢复/子会话流程、发布包消费，以及 V-24/V-26/V-28 验收仍是启用指令的前置条件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
