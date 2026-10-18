---
description: "面向维护者的云端文件工作有界调度与生命周期诊断，说明账户 port、预算及生产启用前置条件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-files

[English](README.md) | 中文

## 概述

维护者可以检查账户各代文件工作的有界准入、取消与排空结果。调用者取消不会删除实际工作记录，仍被持有的结果继续占用字节预留。可信 runtime 可以准备一个图持有的 files owner；账户入口安装其真实原生 Workspace Registry 与受限 S2 FileSystem。生产就绪仍要求部署存储授权及完整账户配方。

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

`/root` 与 `/account` 是 Loader 插件入口。在 Linux 上，`/root` 要求 runtime 注册服务、经过审核的 ABI 6 helper 二进制及显式池限额。它在全部配置 worker 启动之后注册唯一 files 参与者。`/account` 要求 runtime 预备的 `CloudAccountFiles` owner 及空配置。它保留原生 Registry 依赖，在自己的原生子 fiber 中安装该 Registry 与其 S2 FileSystem，并等待实际 default 项目。根池启动和 files 安装成功都不证明账户就绪。

[FilesLimits](src/types.ts) 的所有字段都必须显式提供有限的正安全整数。每个 lane 的并发数、队列容量与驻留字节不得超过对应全局限额；等待时间必须在 Node 定时器的范围内。[根配置 schema](src/root.ts) 还要求 worker 数量、最低健康数、worker 及回复预留、握手及排空期限、helper 位置和读取、路径、分块及重试限额。全局驻留限额包含固定 worker 预留及启用静态存储时的 root 预留；剩余容量限制账户工作。配置的预留必须保守覆盖缓冲区、克隆、解码及被持有的结果。

在原生账户 boot 准备阶段，可信 runtime 使用 exact installed binding、既有有限 lane 的 Registry 构造口、固定 default grant，以及分开的挂载/current 和未发布窗口核验，构造 [CloudAccountFiles](src/account-service.ts)。该输入不接受共享根池、调用者选择的路径、Workspace receipt 或插件。Loader 稳定后，`project()` 向 API/runtime 装配交付实际原生 Workspace 及其 files 持有的 `projectDirectory`。缺失或异图 owner、非空配置、竞争 provider 及旧代都会拒绝。本包不提供宿主文件系统回退。


生产工厂首先通过原池的 `requireStorageOwner()` 取得实际存储 owner。可选的根配置 `staticStorage` 见 [StaticStorageConfig](src/storage-types.ts)；省略仅支持组件调用者，不授予 owner。准备核验恰好两份预置账户分配之一。工厂须在原生 Profile 读取前保留实际 lease，核验其 Profile/base 地址，再把规范的 installed runtime 代际仅绑定一次到原 projects lane。另一个仍活动的 epoch 会被拒绝。runtime 等待 native/save/execution writer 后，lease 关闭继续等待该 lane 的实际工作与持有结果；它从不归还持久容量或重新挂载存储。本地索引及 environment 执行写入不获得授权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[工作队列](src/work-queue.ts) 在准入前预留全局及每个 lane 的字节，限制并发与排队工作，取消排队任务时不启动它，并在调用者取消或超时后继续追踪运行中的工作。每次操作都要求包含自身开销的正安全整数预留。零预留在后端调用前被拒绝，因此保留的记录不能绕过驻留预算。成功结算的结果会保留其预留，直至消费者释放结果。关闭 lane 会停止新业务工作并保留未结算记录；关闭队列则封闭全部 lane 的业务准入，同时允许已有责任的清理。

各个结算观察者独立运行：某个观察者失败会被报告，但不阻止预算释放、后续观察者或排队工作。错误报告器失败时，默认启用的诊断日志提供兜底，不暴露原始异常文本。在延迟调用后端之前，最后一次取消检查会阻止已取消工作启动。

[文件工作所有者](src/work-owner.ts) 消费 runtime 持有的账户绑定、operation-id、参与者及收据类型。它把作为内部对象能力的 lane 绑定到精确代际及可信当前 owner 回调，在原代仍持有工作时拒绝另一代，并在实际工作及被持有结果结算之前报告 unknown。生命周期取消会停止准入；排空等待超时后会移除其结算观察者，工作所有者仍继续追踪实际工作。

私有[目录责任](src/directory-responsibility.ts)在同一 lane 上原子登记长期保留的责任与准备 I/O。[预算计算](src/directory-budget.ts)在派发前预留有界意图与身份副本、记录、单个观察者、结果帧及一次完整清理所需的临时空间。实际准备结算归还 running 容量与 I/O 字节；已创建或 unknown 的责任继续持有正数预留及 operation id。观察者取消或期限到达不会取消该责任。只有原 private 责任可以通过共享 running/queued 限额调度清理，业务关闭后仍使用其预留空间。公开地址不可逆；exposed 或 unknown 责任不能假报 clean，未解决责任阻止 lane 退休或换代。基础调度接受经过审核的组件回调，它们不提供文件系统权限或内核证据。可信 root 持有的隔离 tmpfs fixture grant，或部署方持有的精确独立 ext4 mount grant，可以派生固定单 leaf port；它不是生产 grant 签发者或账户 provider。服务端选择的意图允许固定默认 leaf `default-workspace` 与新项目一次生成的 UUID；名称合法及持有 AccountLayout 对象都不授予写入权限。root 关闭先停止普通准入，保留空闲 slot 供原责任显式清理。清理可使用低于业务健康阈值的单个健康空闲 slot；零健康仍不可用。队列溢出不触发自动重试或隐藏等待队列。实际工作、持有结果及责任结算后才关闭 slot，根 effect 随后等待真实退出。

该内部工作 port 无法选择另一账户或关闭共享队列；它不是原生文件系统，也不是已签发的存储能力。队列计量预留，不在任意回调内部强制分配大小，因此只有经过审核的有界后端才可提交生产工作。

私有 [Linux worker](src/file-worker.ts) 在启动时探测必需的内核操作，不保留账户目录。[ABI 6 N-API helper](native/fd.c) 核验固定根身份，并使用 `openat2` 在该 anchor 之下操作，不回退魔术链接、跨 mount 解析或可移植后端。元数据通过 `O_PATH` FD 取得，为目录或单硬链接普通文件返回原生版本字段；路径缺失返回 undefined，特殊文件及硬链接被拒绝。非流式读取在回复前关闭 FD 及 anchor；流式读取保留单个 FD，直至实际 EOF、取消或 worker 退出。

同一绑定 lane 还提供只读 [directory port](src/directory.ts)，包含 `canonicalPath` 与 `isDirectory`。helper 有界观察 FD 的物理拼写，在同一 anchor 下重开并比较身份，复核 anchor，关闭描述符后才成功。目标 ENOENT/ENOTDIR 可以是确定缺失或非目录失败；anchor 丢失、验证失败、容量、旧代、取消及传输故障继续作为 unavailable 并保留 cause。私有 `DirectoryMetadataFailure` 记录原因与失败阶段。该 port 没有 `ensureDirectory`，不能安装为完整的原生 Workspace 目录依赖。只读 Linux 覆盖不能证明创建或清理；ABI 6 必须另行验证发布包 worker。

ABI 6 增加自持 FD 的单 leaf 准备及 exact empty-directory 清理，创建模式为 `0700`，并实际核验 tmpfs 后端。固定 64 字节帧记录变更阶段、父目录及 leaf 身份、原 mkdir errno 与实际描述符关闭。ABI 6 将 tmpfs 与 ext4 分支分开；ext4 要求精确 mount id、ext4 类型、文件系统根 inode 及同 mount 解析。持久准备同步 leaf 及父目录，持久清理在删除后同步父目录；成功帧必须明确包含 mount 和同步事实。变更后的同步失败保留 unknown 责任。这些内核观察不建立部署归属、物理容量预留或生产授权。确证未创建的失败仍拒绝业务，但结算其临时责任；完整验证成功的 created 帧之后取消仍保留身份与责任。创建后的父目录验证失败会永久禁用清理，即使路径或窗口断言随后恢复；丢回复、worker 故障及模糊结果继续为 unknown。清理要求原 private 身份和仍有效的完整 namespace 独占窗口；空目录或路径缺失本身从不证明可安全删除。close 错误先退役 FD 号，再使 worker 致命失败，避免 finalizer 重试可能已被复用的号码。本实现仍不提供通用递归准备；真实发布包 ABI 6 syscall 验证仍由主控负责。

[Workspace 适配](src/workspace-adapter.ts)在注册窗口有效时、原生初始化前固定全部三个目录方法。其构造函数及 metadata 选择要求 Context 及其独立根都持有绑定的原始 `peAccount` 代际对象。读取方法复用已有池与 lane，并在 I/O 前后检查当前图。注册窗口关闭后，读取仍可使用；目录准备、公开地址及责任转交仍要求该独立窗口。`ensureDirectory` 仅允许预授的 `default-workspace` leaf；公开原生默认初始化器继续决定资格、历史二次检查及持久身份。薄覆盖使用账户项目地址替换桌面 Documents resolver。窗口关闭后，原生默认初始化仍可返回已有默认项目，或其已删除／无资格状态；实际请求新目录会在登记 ticket 或 mkdir 前被拒绝。新项目接收一次选定的服务端 UUID grant，与显示标题无关，然后调用原始原生 `create` 操作。

仅当实际原生注册 Promise 以 Workspace 成功返回后，临时目录责任才移交。私有适配在注册前后核验原 ticket、当前未发布图及每个候选的完整 namespace 窗口、匹配的物理路径与内部 FD 身份。原生缓存成员仅用于交叉检查。移交释放长期预留，不删除目录，也不保留项目到 ticket 的映射。undefined 结果、拒绝、迟到的图关闭、身份不符及准备等待丢失都保留 unknown 责任并禁止清理；随后成功的准备回复不能逆转这种不确定性。普通 prepared-leaf 控制仍仅有公开地址与清理。

原生 Registry 的内部 `createS2Project()` 取得实际 default Workspace 结果，并从同一 lane 的私有 worker 元数据派生独立项目根。[S2 provider](src/s2-project.ts) 实现完整原生 FileSystem 方法表，仅授予 `resolve`、`stat` 与 `processPath`；内容读取、列目录、预览、watch 及修改都在派发前以原生文件系统错误拒绝。其固定图持有的 `projectDirectory.prepare(cwd)` 在注册窗口关闭后通过同一个项目 reader 验证已注册目录，不会按输入地址创建目录。构造安装核验原账户根并拒绝重复 provider。Workspace 删除、旧代、anchor 被替换及伪造 target 都会被拒绝。[账户 owner](src/account-service.ts) 经 `/account` 安装这些原生 provider；该组件不签发生产存储能力。

图持有的账户 owner 通过一个安装 Promise 保留实际稳定结果。在等待安装工作后，它复核 exact binding、原原生 provider 及未发布窗口。同一入口重复安装会加入该 Promise，另一入口会拒绝。部分安装或失败不会返回项目，也不证明清理完成。原生 fiber 持有 provider 拆卸，既有 lane 持有不确定目录责任，runtime 保留图 drain 和共享池所有权。交付的目录能力在真实同 lane 目录验证前后复核两个原 provider，注册窗口关闭后仍然如此。

绑定 port 暴露内部 [reader](src/read-only.ts)，提供 account-instructions 所需的原生 `resolve`、`stat`、`streamText` 及 `processPath` 方法签名。解析只在预先授权的根内进行并签发 opaque target；每次后续操作核验精确签发 reader 与当前 epoch。绝对路径不能选择另一项目。该适配不提供完整文件系统服务，也不签发可信根。

[共享根池](src/worker-pool.ts) 预建固定数量的 worker，并在绑定账户之间复用。绑定及读取不创建 worker；失败的 worker 不自动替换。每次操作只从队列申请一次请求及结果缓冲区预留。文本流在两次 pull 之间保留 slot，只授予一块 credit，以 `readChunkBytes` 限制每块，并以 `maxReadBytes` 限制完整原始内容。它最多读取总上限加一字节，跨块解码 UTF-8，并沿用原生严格解码与前 8192 字节 NUL 采样规则。消费者提前返回会取消操作，不宣告 FD 已关闭。 I/O 关闭后，暂停的迭代器继续为其解码块保留同一预算，直至迭代结束或返回。消费者必须结束或返回其迭代器。[传输层](src/worker-client.ts) 在取消后等待真实回复或实际退出；畸形回复及 worker 错误停止准入，迟到回复不能逆转传输失败。账户排空关闭该代际并向实际 I/O 发出停止信号，同时保留共享池。

[根 effect](src/root-lifecycle.ts) 保留 root 预留及 files 参与者，直至 root probe 实际结束、全部 worker 退出、全部账户工作及被持有结果结算。有界关闭可以报告 unknown；effect 继续持有清理责任，并在实际关闭之前保留注册与根服务。池的生命周期本身不授予项目根。


[静态存储 owner](src/storage-owner.ts) 通过独立只读的 [probe ABI1](native/storage-probe.c) 读取 root 持有、hash 固定的部署记录。Root 在实际分配、同步并持续持有 backing 资源后才写入记录。既有 slot 测量 ext4 身份、有限字节与 inode 容量、backing 元数据、arena 可用 reserve、受保护祖先和应用权限。root 初始化要求应用根只读、记录的非 root UID/GID、全部 capability 集合为零、NoNewPrivs 及 seccomp。这些观察不识别 seccomp filter 或设备策略：可信 Root 装配必须持续持有该限制，并实际验证 mount/device/loop/execute 尝试被拒绝。宿主或整个 VM 存储失败属于基础设施故障；账户获准写入导致另一账户或 control 失败仍属于部署失败。hash 及要求值不能替代实时观察或 Root 对资源的持有。

root probe 配置在账户准入前，从全局预留有界记录、proc、资产副本、native 临时空间及持有事实。同一时间仅运行一个账户核验；额外并发核验直接拒绝，不另设队列。观察超时后，busy slot、root operation id 及预留持续保留，直至实际回复或退出。组件传输及 macOS 均不能签发真实存储 owner。ABI6 及其 S2 行为保持独立；Linux helper 编译、实际权限限制、字节与 inode 耗尽后 control/其他账户持续写入，均须由部署验证。

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

入口不注册工具、提示词或模型上下文。已准备的 `/account` 安装仅授予 S2 元数据方法的原生文件系统；未授予的文件操作会拒绝。缺失 runtime 准备会阻止安装，根池启动不会启用模型文件操作。

#### Token 影响

不直接增加 token。

#### KV Cache 影响

本包不增加模型请求内容，也不改变可复用的请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下集成缺失时，生产启用持续关闭。

- 共享根池在可信隔离图内提供完整 Workspace 元数据适配。注册移交要求其未发布窗口；发布后的图仍为当前图时，元数据读取可以继续。这项生命周期区分不提供生产存储授权。静态准入覆盖恰好两组由 Root 预置、独立的 private/projects 域及有界辅助挂载。动态分配、通用递归准备、live 并发注册与删除、S3 能力、完整 target 及写入语义、链接竞态验收与完整分配计量仍不可用。后端字符串或 statfs 结果不能提供实际部署归属、权限隔离或全部 writer 的字节及 inode reserve。
- 账户绑定与收据类型来自 runtime 包。根入口在 worker 启动后注册 files 参与者，但投入生产前，可信工厂仍须在 Profile I/O 前持有实际存储 owner/lease，并接通完整获准配方。
- 已安装的原生 S2 FileSystem 仅授予元数据方法。完整流式及目录和写入计量、附件接收与暂存、指令及技能投影仍不可用。两份 helper 二进制必须由已审核的 Linux 部署配方构建并固定；本包不分发已经验证的二进制。
- Workspace 源码测试使用真实原生 Loader、JSONL 与 JSON StorageDomain，配合仅供测试的 Node-backed worker 传输；它们不建立内核或配额事实。独立的发布版 ABI 6 Linux 检查验证精确 ext4 mount 身份，拒绝错误 mount id 及同设备的嵌套 bind，并在干净卸载及新容器/Node 进程中恢复同一原生 Workspace 与 Session JSONL event hash。这些组件检查不验收账户入口的完整产品配方。目录同步故障注入、原生 WorkingDirectory/SessionController 装配、生产全部 writer 的隔离与硬配额、总物理 reserve、崩溃/断电恢复及 Web 流程仍是独立要求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
