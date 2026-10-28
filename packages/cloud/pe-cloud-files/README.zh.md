---
description: "面向维护者的云端文件工作有界调度与生命周期诊断，说明账户 port、预算及生产启用前置条件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-files

[English](README.md) | 中文

## 概述

维护者可以检查账户各代文件工作的有界准入、取消与排空结果。调用者取消不会删除实际工作记录，仍被持有的结果继续占用字节预留。可信 runtime 可以准备一个图持有的 files owner；账户入口安装其真实原生 Workspace Registry 及选定的 FileSystem，默认仅授予受限 S2 元数据能力。生产就绪仍要求部署存储授权及完整账户配方。

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

`/root` 与 `/account` 是 Loader 插件入口。在 Linux 上，`/root` 要求 runtime 注册服务、经过审核的 helper 二进制（现有 S2 使用 ABI6，文本写入使用独立构建的 ABI7）及显式池限额。它在全部配置 worker 启动之后注册唯一 files 参与者。`/account` 要求 runtime 预备的 `CloudAccountFiles` owner 及空配置。它保留原生 Registry 依赖，在自己的原生子 fiber 中安装该 Registry 与选定的 FileSystem，并等待实际 default 项目。根池启动和 files 安装成功都不证明账户就绪。

如果提供可信的 `AccountFilesPreparation.createFileSystem`，它仅在原 Registry 与实际 default Workspace 存在后、安装唯一文件系统之前选择原生构造器。省略时保留仅元数据的 S2 构造器；准备失败既不回退，也不报告就绪。真实 `StaticStorageLease` 为新文本候选显式交付其绑定的 `port.createTextFileSystem` 闭包，写入要求独立 ABI7 helper。账户入口保持空配置，现有运行 R8 产物不会被本次源码修改替换。

[FilesLimits](src/types.ts) 的所有字段都必须显式提供有限的正安全整数。每个 lane 的并发数、队列容量与驻留字节不得超过对应全局限额；等待时间必须在 Node 定时器的范围内。[根配置 schema](src/root.ts) 还要求 worker 数量、最低健康数、worker 及回复预留、握手及排空期限、helper 位置和读取、路径、分块及重试限额。全局驻留限额包含固定 worker 预留及启用静态存储时的 root 预留；剩余容量限制账户工作。配置的预留必须保守覆盖缓冲区、克隆、解码及被持有的结果。

在原生账户 boot 准备阶段，可信 runtime 使用 exact installed binding、既有有限 lane 的 Registry 构造口、固定 default grant，以及分开的挂载/current 和未发布窗口核验，构造 [CloudAccountFiles](src/account-service.ts)。该输入不接受共享根池、调用者选择的路径、Workspace receipt 或插件。Loader 稳定后，`project()` 向 API/runtime 装配交付实际原生 Workspace 及其 files 持有的 `projectDirectory`。缺失或异图 owner、非空配置、竞争 provider 及旧代都会拒绝。本包不提供宿主文件系统回退。


`project()` 保持 bootstrap-default 含义。`projectFor(actualWorkspace, signal)` 仅为原 Registry 仍持有的精确对象派生目录能力，不替换文件系统，也不按路径选择项目。`createProject(use, title, signal)` 要求原始 ready borrow；存储 lease 在原 projects 父目录下固定一次 server UUID。显示标题受 `maxPathBytes` 限制，并与目录责任共用预留，持续到实际原生登记结果结算。准入后的取消不会放弃该修改。原生 ID、规范路径唯一性、成员关系及持久顺序仍归 Registry 持有。登记结果 unknown 时保留责任，不能报告干净排空。原未发布准备和 default 初始化检查保持独立。

`AccountFileSelection.directoryPreparation` 是仅供内部使用、带类型的同进程准备身份。Runtime 提供一个稳定对象，其 `assertCaller(actualContext)` 核对原 binding、精确 child scope 和仍有效的准备记录；Files 传入真实的上下文化调用方。Files 以弱引用维护独立顺序：仅一次 `resolve(root, { cwd: root })`，两个字符串都必须字面等于获批 Workspace 根；随后仅一次对该 issued target 的原生 `stat`，且目录结果之后仅一次 `processPath`。别名、额外或并发尝试、取消和失败都不能重启该身份。文件和缺失的 stat 结果保留原生含义，不能取得进程路径。准备身份不授予内容、流、列举、写入、编辑、文件 URL 或包含关系能力。异步工作沿用原 lane 和 reader，并在等待前后保留原选择、target、backend 和生命周期检查。宿主路径映射仍把真实调用方原样传给具有独立校验的原附件投影。该协议的组件检查不代表完整 Runtime／factory 集成或部署就绪。

`CloudAccountFiles.assertContentAvailable()` 要求原安装已经成功结算、唯一原 Registry/FS provider 仍有效，且通过可信准备回调。存储 lease 将回调交给原绑定池，核验当前代际、池健康、显式 content 限额和真实 ABI8 worker 握手。S2 遗漏、ABI 混用、worker 不可用或半安装状态都会拒绝。Runtime 须在安装结算后、接纳依赖内容能力的配方之前调用该断言；方法存在本身不授予就绪。

生产工厂首先通过原池的 `requireStorageOwner()` 取得实际存储 owner。可选的根配置 `staticStorage` 见 [StaticStorageConfig](src/storage-types.ts)；省略仅支持组件调用者，不授予 owner。准备核验恰好两份预置账户分配之一。工厂须在原生 Profile 读取前保留实际 lease，核验其 Profile/base 地址，再把规范的 installed runtime 代际仅绑定一次到原 projects lane。另一个仍活动的 epoch 会被拒绝。runtime 等待 native/save/execution writer 后，lease 关闭继续等待该 lane 的实际工作与持有结果；它从不归还持久容量或重新挂载存储。本地索引写入不获得授权。

静态存储计划 v1 保留关闭执行的兼容性。v2 额外要求每账户具有有限 `environmentBank`：受保护的 `bankId` 与唯一 `slotId` 条目，每槽对应本账户 environments 根下的独立 ext4 `StaticStorageDomain`。owner 经原池及 probe 核对各槽实际身份、byte/inode 几何、完整预分配 backing、arena 总量及预留。项目及环境子树拒绝未声明的子挂载，包括只读及伪文件系统。v1 计划不能通过 `assertExecutionStorageAvailable()`。

可信部署初始化须为各槽在 `private/.pe-env-<bankId>-<slotId>.json` 放置普通单链接记录。初始字段为 `schema: 1`、精确的 `bankId`/`slotId`、正安全整数 `slotGeneration` 及 `state: "free"`。绑定记录增加 `sessionId`、`workspaceId`、`environmentVersion` 并改为 `state: "bound"`；不存沙盒或命令状态。省略 `environmentBank.mode` 时，各槽仍持久绑定一个 Session。运行时不会初始化缺失的槽记录，也不会从空环境目录推断槽空闲。

Root 必须先核验精确原生 Agent/Session 与 Workspace 关系，再调用 `prepareExecutionMounts(originalProject, sessionId, environmentVersion, signal)`；项目必须是原签发对象。方法准备项目的固定 `.pe` 目录并核验 bank 的 private 记录后，才返回 `ResidentResult<ExecutionMountGrant>`。旧模式原子绑定一个明确初始化的 free 槽。记录缺失、无效或重复会关闭 bank 准入；发布 unknown 保留原操作及预留。读取/probe 的已确认取消不会封闭 bank。观察者取消后的迟到确认写入仍持久保留。bank 私有元数据及附件原件保持私有；grant 仅描述所选项目及环境、实测硬限、当前绑定与只读 `.pe` 策略。execution 仍须独立核验实际挂载和进程停止。

显式配置 `environmentBank.mode: "session-directories"` 时，相同的固定 ext4 槽作为存储池。每个 Session 在一个池内取得独立的 UUID 目录，因此两个池不会限制终生只能创建两个 Session。选池使用实测可用块数及空闲 inode；原文件系统的 byte/inode 硬限仍由本账户的 Session 目录共享。私有 [schema2 绑定](src/environment-directories.ts) 通过 `bankId` 和原生 Session ID 的 SHA-256 定位。准备先以 `identity: null` 持久记录 UUID，再用原关闭描述符的 leaf/layout 操作及 private CAS 固定实际设备/inode。重用时核验相同 Session、Workspace、版本、池代际及目录身份。每次调用只读取有限的原池记录及当前 Session 记录。影响 unknown 时关闭当前 bank 准入，不另选 UUID、不擦除记录，也不声称已完成清理。

Session 目录模式逐字保留旧槽记录。旧 bound Session 必须先完成同池显式迁移，并具有记录其正向目录身份的 schema2 记录，才能执行；迁移缺失或未完成时拒绝，不返回空环境。部署负责停止原写入者，在原文件系统内移动保留的 `home`、`venv`、`tmp` 目录，并记录新父目录身份。新的 epoch 可对未完成的新 Session 绑定核验相同 UUID 与真实关闭描述符的观察事实；这不证明此前 unknown 操作已经清理。

执行存储要求 helper 实际具备独立的 `projectMetadataVersion: 1` 能力；旧 ABI8 helper 会在 SDK 创建前拒绝准备。固定原生操作核验原项目的设备、inode 和挂载身份，仅打开不跟随链接、不跨挂载的 `.pe`，并以 `0700` 模式创建缺失目录。已有目录必须具有预期 UID/GID、模式及硬存储域。目录和父目录同步、再次核验身份且全部描述符实际关闭后才成功；固定 96 字节帧向 opaque grant 提供 `.pe` 身份。该操作与私有 bank 绑定共用原修改操作、worker 及正数预留。成功的 `.pe` 目录在取消后仍保留。创建、同步或关闭 unknown 时，保留原操作与预算且不签发 grant。实际 ARM64 helper 编译及 Linux 系统调用验证仍是部署前提。

独立的实际 `environmentLayoutVersion: 1` 能力在签发 execution grant 前，仅于所选已核验环境根下准备 `home`、`venv` 和 `tmp`。每个入口必须是具有预期应用 UID/GID、`0700` 模式及相同设备/挂载身份的目录；链接、特殊入口及身份不符均拒绝且不替换。缺失目录会被创建，已有 Session 内容不会清除。固定 256 字节帧在目录/父目录 fsync、再次核验身份及全部描述符关闭后，记录各目录身份、创建和同步事实。准备共用原修改操作与完整预留；影响 unknown 时保留两者且不签发 grant。取消后的成功迟到回执保留目录，不据此宣称 execution 就绪。grant 设置 `environment.rootReadOnly: true`，将 `writablePaths` 固定为 `home`、`venv`、`tmp`，并携带三者各自的 `layout` 身份。execution 必须将环境根只读挂载，仅将同一硬域内这三个入口分别读写绑定，防止用户替换源入口。本包负责目录身份准备，实际挂载限制及启动核验仍由 execution 持有。旧 helper 仍支持原 ABI8 内容方法及关闭执行的 v1 计划；执行存储准备要求同时具备两项固定能力。

`assertExecutionMountGrant()` 只接受本 owner 原签发且未释放的对象，并复查图、provider 和原生项目成员关系。release 或图 lifetime 结束会撤销 grant 并归还其常驻内存；不会停止计算、删除数据或释放 Session 持久存储。两种存储模式下，普通计算回收均保留 Session 归属。项目改变、环境版本不兼容及删除需要明确的停止/清理证据；本包不提供环境擦除，也不自动将保留的 Session 目录重新分配给其他 Session。

可选根配置 `skillVersions` 要求已核验的 static private 域、显式版本数/内容字节/inode/驻留限额，以及使用 `DSH_FD_SKILL_ABI` 编译的 ABI8 资产。`CloudAccountFiles.skillVersions()` 返回原绑定的 [port](src/skill-versions.ts)，不返回私有文件系统路径。它只准备 `SKILL.md` 和 `resource.bin`，将版本目录封存为 `0500`、文件封存为 `0400`。原池按每个可能保留的版本句柄预留 2 KiB 全局驻留量，并从各 lane 容量扣除；准备操作在调用者归还驻留结果前先归还修改串行槽。原生清单计入每个保留版本；逻辑总量另预留 1,024 字节指针容量和三个控制 inode。独立 private 文件系统继续约束所有写入者的物理总限额。不完整或无法识别的入口会阻止新增准备，不从计费中消失。

未配置 `skillBundles` 时，准备不会选择活动版本。`commit` 在调用者原有的 API 保存 turn 内，使用原生文本 CAS 写入 `skills/current.json`；迟到的确认结果仍可观察，修改或清理 unknown 时保留原操作、预留及 lease。[只读消费](src/skill-version-work.ts) 固定到一个精确版本 inode 并校验两份哈希。消费结束后来源方法失效，重复副本共用有限输出额度。消费前归还 worker 运行槽，原驻留结果则持续计费至 release。活动图期间原件全部保留计费；只有原存储 lease 的排空后路径，在 runtime 确认 native/source/save/execution 停止和 files 结算后，才清理非 current 版本。current 数据跨重启保留。投影已配置或受保护工作副本元数据仍存在时，排空后的清理会保守保留全部原件，并继续计入原有限来源上限，避免破坏持久副本引用。该存储 port 不发布原生目录、不投影项目资源，也不开放模型/UI 管理。

可选 `skillProjection` 沿用原已核验的 private/projects 硬域和修改 lane，并要求 helper 独立声明 `skillProjectionVersion: 1`。`prepareSkillProject` 固定 `.pe/skills`，不创建沙盒；返回结果属于 allocation/export 存续期。`materializeSkillVersion` 只发布 `SKILL.md` 和 `resource.bin`，工作目录为可写 `0700`、文件为 `0600`，再用原生 FsVersion CAS 确认 private `skill-working-copies/` 中的受保护关联。完整发布、sync、描述符关闭和关联确认后，才返回项目相对 `.pe/skills/<server-version>/` 路径。记录正文遵守 `maxRecordBytes`；CAS 请求沿用原 worker 统一的 `maxReadBytes` 传输容量。已确认副本保留用户编辑及替换后的文件 inode；不可变原件哈希继续核验。

闭合的[限额及预算模型](src/skill-projection.ts) 分别计入有界项目、保留副本、父目录／操作借用、扫描和旧新记录缓冲。private 元数据计入实际已分配块、按块取整的原子写记录临时文件和有界目录增长；副本和暂存仍受原项目硬配额约束。`borrowAllSkillWorkingCopies` 从受保护记录推导项目完整关联集合；超过操作上限或缺少任一原签发来源资格时整组拒绝，并在 Root 签发执行事实前核验每个实际目录。显式副本方法对选定集合保留相同检查。驻留结果在观察者／lifetime 取消后，仍持续到原操作真实远端／本地／物理结算。释放 materialize 只结束该次 I/O 预留，files 的有界副本句柄继续持有；不会删除数据或停止脚本。发布部分完成或 unknown 时仍由原修改操作持有，不自动回滚、重放或 GC。

[关联格式](src/skill-project-work.ts) 独立于不可变版本清单和原生 Session／PG 格式。记录绑定实测来源 boot／namespace 和目录身份。普通冷读拒绝变化的范围或挂载。可选 Root 专属 `staticStorage.skillRevalidation` 提供固定受保护 `proofPath` 和 `proofSha256`，由 `maxPlanBytes` 限定大小，仅授权一条精确的 complete／pending-null 记录 SHA／原生 revision 及账号／Workspace。Root 必须绑定此前进程／写入者实际终结、owner 恢复回执和原卷／后端身份连续性。worker 在解码 workerData 时校验并保留可选 proof 选择器；省略时不提供 proof，字段错误或哈希不符时拒绝。原 owner 捕获实际核验的 plan／进程，随后已安装 lease 捕获原 factory 真实 instance／epoch／lifetime；proof 不预选未来身份，也不限制后续普通挂载。原修改 lane 在关联 CAS 和新能力签发前，核验当前已注册 Workspace、每个目录／副本 inode 和不可变来源，并保留已编辑副本。只有明确成功的重验 CAS 才在原 Root 资格对象中消费例外，该状态由其各 lease 共享；JSON 字节相同而原生 revision 已变时不会再次强制重验。unknown 或拒绝的 CAS 不消费资格。proof 缺失、pending／unknown 工作、后端变化或原生核验失败时拒绝。仅启用双文件模式时，完整集合冷借用仍会在任一历史版本缺少当前来源 issuer 精确对象时拒绝。原生 provider、签名操作、SDK 嵌套挂载和可写执行世界仍是独立前置；这些方法本身不开放模型／UI 能力。

可选 `skillBundles` 扩展同一账户 files port、原修改 lane 和 private/projects 硬域。所有[包限额](src/skill-bundles.ts) 都须显式配置；Config 校验完整归档、输入、清单、目录、请求、回包、暂存和驻留上限，并计入保留的清单句柄。helper 必须独立声明 `skillBundleVersion: 1`、`skillBundleProjectionVersion: 1` 和 `skillBundleReclaimVersion: 1`；ABI8 和原固定帧保持不变。完整文件或 ZIP／`.skill` 字节使用锁定的 yauzl 库解码，核验规范相对路径、重复项、类型、链接、实际展开大小和 CRC。脚本仅作数据。完整 ZIP 导出保留嵌套资源和空目录；不提供 URL 安装或资源执行。

`observeCatalog` 和来源选择与原修改操作串行。唯一的原 `skills/current.json` 为 schema2 目录，以原生 FsVersion CAS 覆盖全部安装项；只读 schema1 观察映射为 `sample`，不迁移数据。首次实际 schema2 提交保留该项。旧方法继续只向该槽发布 `SKILL.md` 和 `resource.bin`。托管版本保存完整哈希清单和封存文件树。`withBundleSource` 签发操作范围内的 `source.version`；回调中的物化必须消费该精确 lease，回调结束后资格失效。卸载拒绝新加载；已选定来源的操作可完成，并持续计费至 release。原件哈希覆盖每个成员。首次副本校验全部字节；已有副本保留用户内容和文件 inode 变化，原生 helper 扫描有界实际树并核验原副本根身份。完整树消费者使用 `borrowBundleWorkingCopies`、`borrowAllBundleWorkingCopies` 和 `assertBundleOperationCopies`，将实际操作借用持有至远端／本地／物理结算，独立于被动父目录 grant。

完整树的受保护副本记录使用 schema2，新实现继续读取旧 schema1。冷重验证沿用原 Root 例外，并在原生记录 CAS 前核验完整不可变来源及文件树；历史双文件来源句柄仅可根据已解析的受保护关联重签，并核验实际内容。来源准备和原 post-drain 驱动在完整扫描目录、在途来源及持久副本／冷读引用后，执行有界原生回收。仅确认删除后才释放来源句柄；pending、unknown 或无法识别的数据持续计费并阻止不安全准入。私有回收不删除、覆盖或停止用户工作副本及脚本。启用新写入方前请阅读[目录升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/managed-skill-catalog/guide.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[工作队列](src/work-queue.ts) 在准入前预留全局及每个 lane 的字节，限制并发与排队工作，取消排队任务时不启动它，并在调用者取消或超时后继续追踪运行中的工作。每次操作都要求包含自身开销的正安全整数预留。零预留在后端调用前被拒绝，因此保留的记录不能绕过驻留预算。成功结算的结果会保留其预留，直至消费者释放结果。关闭 lane 会停止新业务工作并保留未结算记录；关闭队列则封闭全部 lane 的业务准入，同时允许已有责任的清理。

配置空闲判定读取同一 lane 记录。只有已完成的 execution mount 与技能父目录 grant 使用被动 lease 保留，后续 I/O 仍须重新进入本 lane。正数驻留预算和终态排空 operation id 一直保留到原 owner 释放。普通保留结果、流、排队/运行 I/O、目录责任及未知修改结算仍为 busy；期限、观察取消或本地配置检查都不释放这些资源。

各个结算观察者独立运行：某个观察者失败会被报告，但不阻止预算释放、后续观察者或排队工作。错误报告器失败时，默认启用的诊断日志提供兜底，不暴露原始异常文本。在延迟调用后端之前，最后一次取消检查会阻止已取消工作启动。

[文件工作所有者](src/work-owner.ts) 消费 runtime 持有的账户绑定、operation-id、参与者及收据类型。它把作为内部对象能力的 lane 绑定到精确代际及可信当前 owner 回调，在原代仍持有工作时拒绝另一代，并在实际工作及被持有结果结算之前报告 unknown。生命周期取消会停止准入；排空等待超时后会移除其结算观察者，工作所有者仍继续追踪实际工作。

私有[目录责任](src/directory-responsibility.ts)在同一 lane 上原子登记长期保留的责任与准备 I/O。[预算计算](src/directory-budget.ts)在派发前预留有界意图与身份副本、记录、单个观察者、结果帧及一次完整清理所需的临时空间。实际准备结算归还 running 容量与 I/O 字节；已创建或 unknown 的责任继续持有正数预留及 operation id。观察者取消或期限到达不会取消该责任。只有原 private 责任可以通过共享 running/queued 限额调度清理，业务关闭后仍使用其预留空间。公开地址不可逆；exposed 或 unknown 责任不能假报 clean，未解决责任阻止 lane 退休或换代。基础调度接受经过审核的组件回调，它们不提供文件系统权限或内核证据。可信 root 持有的隔离 tmpfs fixture grant，或部署方持有的精确独立 ext4 mount grant，可以派生固定单 leaf port；它不是生产 grant 签发者或账户 provider。服务端选择的意图允许固定默认 leaf `default-workspace` 与新项目一次生成的 UUID；名称合法及持有 AccountLayout 对象都不授予写入权限。root 关闭先停止普通准入，保留空闲 slot 供原责任显式清理。清理可使用低于业务健康阈值的单个健康空闲 slot；零健康仍不可用。队列溢出不触发自动重试或隐藏等待队列。实际工作、持有结果及责任结算后才关闭 slot，根 effect 随后等待真实退出。

该内部工作 port 无法选择另一账户或关闭共享队列；它不是原生文件系统，也不是已签发的存储能力。队列计量预留，不在任意回调内部强制分配大小，因此只有经过审核的有界后端才可提交生产工作。

私有 [Linux worker](src/file-worker.ts) 在启动时探测必需的内核操作，不保留账户目录。[ABI 6 N-API helper](native/fd.c) 核验固定根身份，并使用 `openat2` 在该 anchor 之下操作，不回退魔术链接、跨 mount 解析或可移植后端。元数据通过 `O_PATH` FD 取得，为目录或单硬链接普通文件返回原生版本字段；路径缺失返回 undefined，特殊文件及硬链接被拒绝。非流式读取在回复前关闭 FD 及 anchor；流式读取保留单个 FD，直至实际 EOF、取消或 worker 退出。

同一绑定 lane 还提供只读 [directory port](src/directory.ts)，包含 `canonicalPath` 与 `isDirectory`。helper 有界观察 FD 的物理拼写，在同一 anchor 下重开并比较身份，复核 anchor，关闭描述符后才成功。目标 ENOENT/ENOTDIR 可以是确定缺失或非目录失败；anchor 丢失、验证失败、容量、旧代、取消及传输故障继续作为 unavailable 并保留 cause。私有 `DirectoryMetadataFailure` 记录原因与失败阶段。该 port 没有 `ensureDirectory`，不能安装为完整的原生 Workspace 目录依赖。只读 Linux 覆盖不能证明创建或清理；ABI 6 必须另行验证发布包 worker。

ABI 6 增加自持 FD 的单 leaf 准备及 exact empty-directory 清理，创建模式为 `0700`，并实际核验 tmpfs 后端。固定 64 字节帧记录变更阶段、父目录及 leaf 身份、原 mkdir errno 与实际描述符关闭。ABI 6 将 tmpfs 与 ext4 分支分开；ext4 要求精确 mount id、ext4 类型、文件系统根 inode 及同 mount 解析。持久准备同步 leaf 及父目录，持久清理在删除后同步父目录；成功帧必须明确包含 mount 和同步事实。变更后的同步失败保留 unknown 责任。这些内核观察不建立部署归属、物理容量预留或生产授权。确证未创建的失败仍拒绝业务，但结算其临时责任；完整验证成功的 created 帧之后取消仍保留身份与责任。创建后的父目录验证失败会永久禁用清理，即使路径或窗口断言随后恢复；丢回复、worker 故障及模糊结果继续为 unknown。清理要求原 private 身份和仍有效的完整 namespace 独占窗口；空目录或路径缺失本身从不证明可安全删除。close 错误先退役 FD 号，再使 worker 致命失败，避免 finalizer 重试可能已被复用的号码。本实现仍不提供通用递归准备；真实发布包 ABI 6 syscall 验证仍由主控负责。

[Workspace 适配](src/workspace-adapter.ts)在注册窗口有效时、原生初始化前固定全部三个目录方法。其构造函数及 metadata 选择要求 Context 及其独立根都持有绑定的原始 `peAccount` 代际对象。读取方法复用已有池与 lane，并在 I/O 前后检查当前图。注册窗口关闭后，读取仍可使用；未发布流程的目录准备、公开地址及责任转交仍要求该独立窗口。`ensureDirectory` 仅允许预授的 `default-workspace` leaf；公开原生默认初始化器继续决定资格、历史二次检查及持久身份。薄覆盖使用账户项目地址替换桌面 Documents resolver。窗口关闭后，原生默认初始化仍可返回已有默认项目，或其已删除／无资格状态；实际请求新目录会在登记 ticket 或 mkdir 前被拒绝。新项目接收一次选定的服务端 UUID grant，与显示标题无关，然后调用原始原生 `create` 操作。

公共 `Registry.create(path, title)` 仅解析已登记的原生对象，包括其规范 alias，并在查找后确认仍为本 Registry 的同一已登记对象。存在但未知的目录会拒绝，不调用原生创建。只有私有固定 grant 和 ready 准入准备流程可以通过原生 `create` 登记新对象；default 初始化保留原生私有路径。

仅当实际原生注册 Promise 以 Workspace 成功返回后，临时目录责任才移交。私有适配在注册前后核验原 ticket、原始未发布窗口或该操作的 ready borrow，以及每个候选的完整 namespace 窗口、匹配的物理路径与内部 FD 身份。原生缓存成员仅用于交叉检查。移交释放长期预留，不删除目录，也不保留项目到 ticket 的映射。undefined 结果、拒绝、迟到的图关闭、身份不符及准备等待丢失都保留 unknown 责任并禁止清理；随后成功的准备回复不能逆转这种不确定性。普通 prepared-leaf 控制仍仅有公开地址与清理。

原生 Registry 的内部 `createS2Project()` 取得实际 default Workspace 结果，并从同一 lane 的私有 worker 元数据派生独立项目根。[S2 provider](src/s2-project.ts) 实现完整原生 FileSystem 方法表，仅授予 `resolve`、`stat` 与 `processPath`；内容读取、列目录、预览、watch 及修改都在派发前以原生文件系统错误拒绝。其固定图持有的 `projectDirectory.prepare(cwd)` 在注册窗口关闭后通过同一个项目 reader 验证已注册目录，不会按输入地址创建目录。构造安装核验原账户根并拒绝重复 provider。Workspace 删除、旧代、anchor 被替换及伪造 target 都会被拒绝。[账户 owner](src/account-service.ts) 经 `/account` 安装这些原生 provider；该组件不签发生产存储能力。

持有图在安装唯一文件系统前，通过原绑定 port 请求 `createTextFileSystem(actualDefaultWorkspace, assertInstalled, resolveProject)`。导出的异步 `ResolveAccountFileProject` 回调先从实际原生调用者取得 `AccountFileSelection`，再解释模型路径；Files 独立核验原 provider、账户绑定和精确 Registry 对象。每个 target 私有捕获该 selection、同 lane 项目 backend 及其原 FD anchor，不保留永久项目 backend Map。同步进程路径、URL 和包含关系方法检查捕获的 selection，不查询 header。异步 target 操作在 I/O 前后同时复核原 selection 和新的调用者 selection，拒绝其他项目及失效 scope。绝对路径不授予选择其他项目的权限。规范 key 在所选项目内跨原子替换与 alias 保持稳定。[文本 provider](src/text-project.ts) 提供解析、元数据、进程路径、文件 URL、包含关系、有界文本读取／流及 `writeText`；额外原始内容方法要求下述 ABI8 能力。原 S2 provider 继续可用。

原签发 execution port 启用 Session 文件权限强制时，准备过程将同一个选择传给文本 backend。每次 `writeText` 都在 worker 派发前重新核验当前调用 Session 的原生权限；同一 Workspace 中另一 Session 先前解析的 target 不授予写权限。当前原始 `AccountFileSelection.assertMutationPolicy` 必须存在。只读 Session 即使收到直接的每次调用 workspace-write override，也返回原生 `FS_SANDBOX_DENIED`。仅在强制关闭时，省略配置才保留 legacy provider；显式传入的每次调用策略不会被静默忽略。该路径沿用原 worker lane、硬配额和修改结算。

显式配置 ABI8 `content` 且真实 worker 握手通过后，同一 router 授予路径级不跟随最终链接的 `lstat`、`listDir`、完整 `readBytes` 及定位窗口 `readByteRange`。选择 scope 先于解释 lstat 路径。目录项取得同 provider、同捕获项目 backend 签发的有效 target；链接和特殊项映射为 `other`，其 target 永久仅授予元数据观测，不能据此读取、写入或列目录。完整字节读取复用既有 worker read 的上限加一字节探测，返回精确 backing buffer；实际 cap 取调用者 cap、`maxReadBytes`、`maxReplyBytes` 减 128 字节封装三者的最小值。range 长度须满足两项配置字节限额，完整文件可以更大。派发前，同 lane 的一份正数预留覆盖 native/path 临时空间、回复与名称／元数据副本、展开后的目录 target 和字节结果，持续到交付。算术溢出或单 lane 容量不足会拒绝；取消后原操作继续持有到 worker 实际回复或退出，不新增池或 backend 缓存。`editText` 仍不可用，`watch` 明确以 unsupported 拒绝。

helper 默认构建仍为 ABI6。使用 `-DDSH_FD_TEXT_ABI` 构建并独立命名的资产报告 ABI7，增加有界文本发布能力；它不得覆盖正在运行的 ABI6 资产。worker 接受两者，但 ABI6 文本写入在派发前拒绝。现有 `maxReadBytes` 限制完整原始文本读取、UTF-8 写入输入及可选旧内容上下文；上下文达到上限或包含二进制／非法 UTF-8 时返回 `before: null`。结果上下文规范化换行，存储和读取的文本保留输入字节。本切片不新增文本限额配置。

独立命名的 ABI8 资产要求同时使用 `-DDSH_FD_TEXT_ABI` 与 `-DDSH_FD_CONTENT_ABI`；默认 ABI6 及 ABI7 的导出保持不变。ABI8 worker 要求显式 `content` 限额：`maxEntries`、`maxNameBytes`、`maxReplyBytes` 及 `operationTimeoutMs`。传输层增加 `lstat(root, path, signal)`、`list(root, path, maxEntries, maxBytes, signal)` 及 `readRange(root, path, offset, length, maxBytes, signal)`；ABI6/7 在派发前拒绝这些命令。这些私有方法不安装或授予原生 FileSystem 能力。

ABI8 `lstat` 移除尾分隔符后以 `O_PATH | O_NOFOLLOW` 打开最终目录项，报告 file/directory/symlink/other 元数据及确定的目标缺失，并保留普通文件的单链接规则。`list` 在已核验项目 anchor 内逐项遍历直接子项，不跟随各子项的最终链接，关闭描述符后返回按 UTF-8 字节排序的名称及元数据。配置中的名称／条目限额及调用者的完整元数据回复限额在超额时拒绝，不静默截断。原生准入在保留每项之前计入 128 字节封装、512 字节元数据及原始名称字节数的六倍，worker/client 还核对完整回复的 UTF-8 JSON 大小。非法 UTF-8 名称及含路径组件歧义的名称拒绝。列出的 symlink 仅授予目录项元数据 target，不授予跟随目标或内容权限。`readRange` 仅读取安全位置窗口，包含 EOF／零长度的空结果，不要求完整文件大小落在窗口上限内。完整字节回复在 `maxReplyBytes` 下另计 128 字节封装；完整读取仍沿用上限加一字节的规则。

内容操作检查取消及单调时钟期限，复核原始 anchor，在回复前关闭文件／目录描述符。目录枚举还会重新打开选定目录以比较身份。阻塞 syscall 的责任保留至其返回或 worker 实际退出；期限不表示内核操作已经中断。关闭未确认或原生回复畸形会使 worker 致命失败，client 将 pending 工作保留至实际退出。内容方法不创建目录、不发布附件，也不启动 watch。按需运行的 [Linux 内容检查](tests/linux-content-interop.mjs) 通过新构建的 worker 验证独立编译的 ABI8 helper；生产部署及 pool/provider 接线需要各自的证据。

文本修改先进入原有有界队列，再等待执行顺序；同一绑定 lane 的全部写入串行执行，包含别名。ABI7 事务要求规范父目录已经存在，以 `0600` 模式创建独占的同目录临时文件，写入并同步它，复核根／父目录／目标身份及版本，以 rename 发布并同步父目录。仅缺失时创建及匹配版本替换沿用原生意图与错误分类。成功前复核发布结果并关闭描述符。确证发布前失败时，仅移除自身精确临时身份并同步清理。原生写入取消和队列期限仅向实际 I/O 发停止信号，不会抢在回复之前结束原生等待；发布后取消仍在收到确认后返回实际结果。排队写入可以在后端调用前取消。原任务持有结果预留，直至原生消费者释放它。丢回复、发布不确定、清理失败或关闭含糊都会保留原 operation id 及完整正数预留，拒绝后续写入并阻止账户排空报告 clean。自动重试或恢复不会将此类工作声明为 clean。此文本 API 不授予递归创建父目录、外部 writer 的比较并交换或 `editText`；二进制暂存使用下述独立 companion。

可选 `staging` 在同一有界 worker 上选择独立 ABI1 companion，不替换 ABI6/7/8。helper 路径、文件及批次字节数、引用数量、原生源块、时限和完整 `reservationBytes` 均须显式提供。一个已准入修改批次在预算内惰性收集已授权原生引用，逐文件消费原件流，以单块 credit 和精确转移帧复制，独立验证大小、摘要和真实 EOF 后，持久化且不覆盖地发布到 `.pe/attachments/<digest>/<name>`。已有副本须完整复核；损坏或链接对象拒绝且不替换。源与接收两侧实际关闭后才能确认结算。成功结果释放运行槽，原队列继续持有字节预算直到 release；发布或清理未知则保留原任务并阻止账户后续修改。Root 继续负责源收集、当前 Agent/Session 授权、原生收据退休、硬磁盘/inode 限制及有限元数据预算。

可选账户附件 provider 继承原生本地存储、原件持久化、流和图片处理；同步文件路径查询只暴露活跃请求已验证的项目副本，文件系统将这个相同宿主文件映射成进程路径。私有根前缀和相同摘要均不授予权限。普通文件系统文本写入拒绝 `.pe/attachments`。上传在原生存储开始前进入同一修改 lane；原生清理未知不能释放原实际工作预算。

图持有的账户 owner 通过一个安装 Promise 保留实际稳定结果。在等待安装工作后，它复核 exact binding、原原生 provider 及未发布窗口。同一入口重复安装会加入该 Promise，另一入口会拒绝。部分安装或失败不会返回项目，也不证明清理完成。原生 fiber 持有 provider 拆卸，既有 lane 持有不确定目录责任，runtime 保留图 drain 和共享池所有权。交付的目录能力在真实同 lane 目录验证前后复核两个原 provider，注册窗口关闭后仍然如此。

绑定 port 暴露内部 [reader](src/read-only.ts)，提供 account-instructions 所需的原生 `resolve`、`stat`、`streamText` 及 `processPath` 方法签名。解析只在预先授权的根内进行并签发 opaque target；每次后续操作核验精确签发 reader 与当前 epoch。绝对路径不能选择另一项目。该适配不提供完整文件系统服务，也不签发可信根。

`withInstructionReaders` 要求账户持有者的精确已注册 Workspace，以及存储持有者签发的 private 父目录。该父目录只授予元数据观测：存在的 `instructions` 目录必须解析为独立核验的根，才能签发账户内容 reader；只有确定缺失才省略该来源。项目和账户 reader 共用一份正数快照预留及一个借用 worker，不嵌套进入队列。源读取及关闭实际结束后才返回成功结果，完整预留继续保留到 release。调用者仍负责精确活跃 Agent/Session 准入，账户持有者在操作前后复核原 provider 与 Workspace。

[共享根池](src/worker-pool.ts) 预建固定数量的 worker，并在绑定账户之间复用。绑定及读取不创建 worker；失败的 worker 不自动替换。每次操作只从队列申请一次请求及结果缓冲区预留。文本流在两次 pull 之间保留 slot，只授予一块 credit，以 `readChunkBytes` 限制每块，并以 `maxReadBytes` 限制完整原始内容。它最多读取总上限加一字节，跨块解码 UTF-8，并沿用原生严格解码与前 8192 字节 NUL 采样规则。消费者提前返回会取消操作，不宣告 FD 已关闭。 I/O 关闭后，暂停的迭代器继续为其解码块保留同一预算，直至迭代结束或返回。消费者必须结束或返回其迭代器。[传输层](src/worker-client.ts) 在取消后等待真实回复或实际退出；畸形回复及 worker 错误停止准入，迟到回复不能逆转传输失败。账户排空关闭该代际并向实际 I/O 发出停止信号，同时保留共享池。

[根 effect](src/root-lifecycle.ts) 保留 root 预留及 files 参与者，直至 root probe 实际结束、全部 worker 退出、全部账户工作及被持有结果结算。有界关闭可以报告 unknown；effect 继续持有清理责任，并在实际关闭之前保留注册与根服务。池的生命周期本身不授予项目根。


[静态存储 owner](src/storage-owner.ts) 通过独立只读的 [probe ABI1](native/storage-probe.c) 读取 root 持有、hash 固定的部署记录。Root 在实际分配、同步并持续持有 backing 资源后才写入记录。既有 slot 测量 ext4 身份、有限字节与 inode 容量、backing 元数据、arena 可用 reserve、受保护祖先和应用权限。root 初始化要求应用根只读、记录的非 root UID/GID、全部 capability 集合为零、NoNewPrivs 及 seccomp。这些观察不识别 seccomp filter 或设备策略：可信 Root 装配必须持续持有该限制，并实际验证 mount/device/loop/execute 尝试被拒绝。宿主或整个 VM 存储失败属于基础设施故障；账户获准写入导致另一账户或 control 失败仍属于部署失败。hash 及要求值不能替代实时观察或 Root 对资源的持有。

`/root` 入口还向可信部署装配提供同一份 `parseStaticStoragePlan` 和 `accountEnvironmentBank` 解析及选择函数。它们解析受保护记录，不签发 files 授权，也不证明实时存储可用；执行消费者仍须取得原当前账户授权，并实际测量来源。

root probe 配置在账户准入前，从全局预留有界记录、proc、资产副本、native 临时空间及持有事实。同一时间仅运行一个账户核验。两组固定分配最多保留两条准备／lease 记录，并串行等待核验；重复的同代输入共享原 Promise。核验失败会关闭准入，root 关闭或排队代际被取消时，会在后续 I/O 前拒绝。等待中的核验责任一直保留到实际结算。观察超时后，busy slot、root operation id 及预留持续保留，直至实际回复或退出。组件传输及 macOS 均不能签发真实存储 owner。ABI6 及其 S2 行为保持独立；Linux helper 编译、实际权限限制、字节与 inode 耗尽后 control/其他账户持续写入，均须由部署验证。

files 静止查询观察原有精确 epoch lane、待处理工作及 root probe 责任。驻留结果仍计为工作。查询不释放结果、不 retire lane，也不提供排空回执。

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

入口不注册工具、提示词或模型上下文。已准备的 `/account` 默认安装仅授予 S2 元数据方法的原生文件系统；可信准备 factory 可以显式选择有界文本 provider。未授予的文件操作会拒绝。缺失 runtime 准备会阻止安装，根池启动不会启用模型文件操作。

#### Token 影响

不直接增加 token。

#### KV Cache 影响

本包不增加模型请求内容，也不改变可复用的请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

完整 S3 文件能力的生产启用仍要求以下集成。

- 共享根池在可信隔离图内提供完整 Workspace 元数据适配。注册移交要求原未发布窗口或实际 ready borrow；发布后的图仍为当前图时，元数据读取可以继续。这项生命周期区分不提供生产存储授权。静态准入覆盖恰好两组由 Root 预置、独立的 private/projects 域及有界辅助挂载。动态分配、通用递归准备及 live 并发注册与删除仍不可用。显式的文本与指令 reader 路径不代表完整 S3、完整 target／写入覆盖、链接竞态或完整分配计量已经验收。后端字符串或 statfs 结果不能提供实际部署归属、权限隔离或全部 writer 的字节及 inode reserve。
- 账户绑定与收据类型来自 runtime 包。根入口在 worker 启动后注册 files 参与者，但投入生产前，可信工厂仍须在 Profile I/O 前持有实际存储 owner/lease，并接通完整获准配方。
- 默认 S2 FileSystem 仅授予元数据方法；可信准备可以选择上述有界文本 provider 及固定来源的 `withInstructionReaders`。ABI8 内容准备还授予上述有界只读方法。附件接收／暂存、原生技能 provider／可写执行世界集成、editText 和 watch 仍不可用；完整链接竞态与分配验收仍要求独立证据。这些显式增量不证明完整 S3 或真实 Web 流程已经验收。选用的每份 helper 二进制必须由已审核的 Linux 部署配方构建并固定；本包不分发已经验证的二进制。
- Workspace 源码测试使用真实原生 Loader、JSONL 与 JSON StorageDomain，配合仅供测试的 Node-backed worker 传输；它们不建立内核或配额事实。独立的发布版 ABI 6 Linux 检查验证精确 ext4 mount 身份，拒绝错误 mount id 及同设备的嵌套 bind，并在干净卸载及新容器/Node 进程中恢复同一原生 Workspace 与 Session JSONL event hash。这些组件检查不验收账户入口的完整产品配方。目录同步故障注入、原生 WorkingDirectory/SessionController 装配、生产全部 writer 的隔离与硬配额、总物理 reserve、崩溃/断电恢复及 Web 流程仍是独立要求。
- 文本源码测试也使用该测试专用 Node 传输。按需运行的 [ABI7 Linux 检查](tests/linux-text-interop.mjs)要求独立构建的 helper、发布 worker 入口及获准测试父目录。它检查原生创建／更新／版本结果、有界上下文、链接拒绝、发布前取消、临时清理及描述符关闭。它不建立部署隔离、运行中取消的故障覆盖、同步失败恢复或崩溃／断电耐久性。使用新候选之前仍须验证发布 ABI7；此处不提供已验证二进制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
