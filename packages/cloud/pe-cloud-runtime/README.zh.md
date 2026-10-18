---
description: "面向云端装配维护者的 runtime 参与者登记、本地容量限制及不可变账户代际输入说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-runtime

[English](README.md) | 中文

<a id="summary"></a>
## 概述

本包通过预期 epoch CAS 保存 PostgreSQL 账户归属，记录进程登记观察，拒绝不完整的排空参与者登记，并限制本地装配和排空预留。它提供云端 provider 共用的不可变代际输入及实际工作证据类型。账户入口要求私有工厂交接，不从配置接受账户身份。领取 owner 仅返回 mounting 元数据，不发布可用账户图。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

根 Loader 入口为 `/root`，包默认入口是它的别名。`/account` 仅接受空配置，拒绝身份或其他 JSON 字段，并核验私有工厂安装的不可变 `peAccount` 贡献。`/types` 提供共享数据声明，`/schema` 导出容量解析器。

### Configuration

根入口要求三个限制均为正安全整数，不推断部署默认值。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxMountedAccounts` | 必填 | 账户槽位，以及在途/未知 owner 写入责任记录的上界。 |
| `maxConcurrentMounts` | 必填 | 尚未实际结算的装配操作。 |
| `maxConcurrentDrains` | 必填 | 尚未实际结算的排空操作。 |

Provider 经根服务登记必需的 `files` 和 `execution` 参与者。登记归调用 fiber 所有，重复项会被拒绝。缺参与者时拒绝装配容量预留；通过此检查不等于配方封口。配置保存使用 API 单独持有的屏障，不是第三个参与者。

账户工厂持有容量预留，直至实际工作结算。`settleMount()` 释放并发装配槽并保留账户槽。装配或排空仍持有账户时，`releaseAccount()` 拒绝释放。请求超时不授权这两种释放。根卸载关闭新的本地预留，不报告既有工作已停止。

### Account layout

`/types` 声明唯一的 `AccountLayout`，包含共享 private/Profile/patch、凭据、Session、storage、附件原件、技能、指令、项目、环境及进程本地 Session 索引地址。`AccountMountInput` 将这些地址与既有 binding、启动 InstanceId 及原生 `LaunchEnvironmentSnapshot` 配对。这些是可信装配数据；路径不授予目录访问、ready 或配额证据。凭据只交给需要的原生消费者。

私有[地址 helper](src/account-layout.ts)接受显式、词法规范的 POSIX 共享根/缓存根及正数有限 UTF-8 字节上限。它先限制字符数，再扫描 UTF-8，并核验每项输出。固定 v1 域及明确字节长度框定认证 id 的精确字节后作 SHA-256；不将原始 id 或标题用作目录片段。共享路径跨 epoch 和进程重启保持稳定，只有可重建本地索引含启动 InstanceId。

默认项目候选使用固定的 `default-workspace` basename，保留原生标题处理。是否初始化仍由原生资格、历史复查及默认删除标记决定。新项目候选使用一次服务端 UUID；调用方在实际准备期间保留该候选。Helper 不创建目录或 Workspace 记录。真实父目录保护、FD 能力、配额及当前代际检查归 files/部署与 runtime 生命周期持有。

### PostgreSQL owner storage

私有 owner store 接受根持有的 PostgreSQL query adapter 及服务端生成的实例身份。该实现归包内账户工厂持有，不是导出的账户管理 SDK。Adapter 绑定参数，并限制连接、statement 及 query 预算。`migrate()` 执行 `pe_account_owners` 的原子 DDL；并发迁移在 PostgreSQL 内串行，既有字段或约束不兼容时拒绝，不重置记录。

私有 [pg 适配](src/owner-pg-executor.ts)使用 `pg@8.16.3`，每个连接仅执行一条语句，不使用隐藏连接池。显式构造参数限制连接、排队提交、队列/连接/服务端 statement/锁等待时间、被观察的实际 Promise 及并发等待者；这些不是新增的根 Loader 配置字段。`ClientConfig.query_timeout` 为零；pg 共享 query-timeout 默认值非零时，在创建连接前拒绝。Query 持有槽位直到真实 driver 结算且连接结束；连接不复用。服务端 `statement_timeout` 限制执行，已提交写入失败对 store 仍属于结果未知。

`observe(actual, deadlineAtMs, signal)` 只限制本次等待。超时/取消移除该等待者，并在实际 Promise 结算前保留唯一且有界的结算订阅。它不拒绝实际 SQL，也不释放连接。`close()` 关闭准入并拒绝从未提交的排队 SQL，随后持有同一个关闭 Promise，直至全部已启动连接结束。只有可信 adapter 确认的提交前失败才允许 store 丢弃该在途写入责任；SQL 从未发送时，队列耗尽、过期及连接初始化失败不会隔离该账户。

`claim()` 对不存在的行要求 null，对 unowned 行要求精确旧 epoch。parked 行仅可由保留的实例领取。每次成功领取递增保留的 bigint epoch，并返回 mounting 元数据。相同的本地在途领取共享一次数据库 Promise，数量受 `maxConcurrentMounts` 限制；账户工厂仍须合并完整图装配。Heartbeat 只更新观察时间，不授权接管。

私有工厂只有在实际图、provider、保存及暴露清单审核成功后，才能调用 `ready(expected, recipeVersion)`。CAS 只接受账户、进程实例、epoch 和配方精确匹配的 mounting 元数据；旧代、重复或不匹配提交均拒绝。它不执行这些审核，也不发布 `AccountUse`。已提交写入失败时保留未知结果责任。

`beginDrain()` 接受 ready 图或 mounting 图的已知清理，不发布 ready 或解除隔离。之后，`release()` 和 `park()` 要求完整且匹配的 runtime 证据：原生 idle、配置保存 confirmed、两个参与者 confirmed、持久化已 flush、Context 已 dispose 且无销毁错误。匹配但不完整的证据改为隔离 owner。隔离态没有普通释放或领取出口。Store 保留 unowned 行，不删除或重置 epoch；epoch 从不转为 Number。

被拒绝的 mutation 可能已经提交而结果未知。Store 保留该账户及尝试的 epoch，关闭该账户后续写入，并允许读取状态，不重放或自动解除未知。其他账户继续受正常 CAS 及容量规则约束。每次 mutation 前预留责任记录；未知记录保留在配置上界内，耗尽时拒绝新观察，不丢弃旧记录。迁移失败使整个 store 保持关闭。完整 runtime 必须经可信生命周期完成对账；构造存储 adapter 不代表获准恢复。

### Process instance metadata

私有[实例组件](src/instance-control.ts)在 `pe_instances` 保存启动身份、可信部署地址、配方版本、观察阶段及 heartbeat 时间。其原子迁移遇到不兼容字段或约束时拒绝，不重置记录。组件在内部生成并冻结身份；持有者在每次 Node 启动时构造唯一组件，并将同一个身份交给 owner store。构造器不接受外部提供的实例 id。地址是不透明的部署元数据，不用于选择网络目标。

登记合并相同的本地调用，遇到已有的持久化 id 时拒绝，不覆盖其元数据。单行读取区分行不存在、读取失败及无效结果。Heartbeat 仅更新组件自身的 registered 行。`registered`、`closed` 或过期 heartbeat 均不代表账户 ready、进程死亡或获准回收 owner。实例操作不修改账户 owner 或 epoch。

每个组件最多持有一个实际 mutation。Close 关闭本地 mutation 准入，等待实际 schema/登记/heartbeat 工作，然后仅将自身登记标为 closed；账户排空及共享 executor 关闭由根单独持有。等待复用 adapter 的有界观察，不结算实际 SQL。已提交结果未知会保留类型化责任，读取或观察超时均不自动解除或重放；其他组件仍可继续。只有确定的提交前失败允许显式重试，重试 close 仍保持本地准入关闭。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部机制 — 点击展开</summary>

每个根独立持有参与者表和容量计数。每个独立账户根接收冻结的 binding，其中包含无精度损失的 epoch 字符串和图 lifetime。内部交接拒绝子 Context、仅结构相似的对象和已结束的 lifetime；没有公开构造器将浏览器 JSON 转为 binding。原生队列、Session、设置及执行状态仍由各自包持有。

[根服务](src/root.ts)、[PostgreSQL owner store](src/owner-store.ts)、[容量记录](src/capacity.ts)、[私有 binding 交接](src/binding.ts)和[共享类型](src/types.ts)定义已实现行为。[Loader 测试](tests/runtime.spec.ts)覆盖 runtime 输入；[PostgreSQL 测试](tests/owner-postgres.spec.ts)在显式指定的测试库执行 CAS 及迁移场景，排空证据使用测试夹具。

私有[原生 Profile 适配](src/native-boot.ts)通过公开 app boot 创建独立根，在 `prepare` 中提供复制的 ProfileContext、显式启动环境及不可变 binding，并且只装配一次 root Include。所有保存/files/execution port 均须在 `prepare` 内使用同一个已安装 binding 构造、核验及注入，并保留其图 lifetime。等待 setup 完成后，prepare 在返回 boot 前再次核验已安装代际的寿命及关闭请求。若 setup 期间代际结束或收到关闭请求，不启动任何 Include entry，并继续等待实际清理。已装配图仍由 runtime 驱动销毁。它不安装账户 CLI、信号处理、代理、watcher 或代码 HMR。调用者必须先核验真实根能力和固定配方。装配结果仅说明原生装配完成。适配持有 boot/disposal Promise，并有界观察错误，覆盖部分启动和异步 disposer 失败；错误或观察溢出均阻止原生销毁 confirmed。该观察不代表业务工作排空或账户 clean。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [应用装配](../../../docs/architecture.zh.md)
- [原生 app boot](../../boot/app-boot/README.zh.md)
- [生命周期审核规则](../../../docs/defensive-patterns/general.zh.md)

-----

<a id="model-experience"></a>
## Model Experience

### Runtime admission

#### What the model sees

本包不贡献提示词或工具 schema，`AccountBinding` 及 owner 元数据保留在模型上下文之外。

#### Token effect

直接 token 影响为零；本地登记及容量错误不注入模型上下文。

#### KV Cache effect

本地容量记录不更改模型请求前缀或保留的 Session 历史。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

该基础尚不能准入生产账户流量。

- **账户工厂** — 尚无共享图装配 Promise、`AccountUse`、围绕私有原生适配的生产配方/port 集成、配方封口及 ready 发布。数据库领取合并不等于完成账户 acquire。
- **布局接线** — 布局数据及私有地址 helper 尚未连接到原生 boot 或 files 能力创建。已包含 environments 父根，尚无按 Session 的环境派生。
- **数据库集成与恢复** — 私有 pg 适配及实例组件尚未接入根部署配置或启动。尚无根 heartbeat 调度、恢复审计、分配对账及可信 RecoveryProof 应用；本模块不能重领隔离态 owner。
- **必需证据** — 参与者存在不验证存储配额、原生 provider、配置保存 hook、manifest、进程停止或销毁成功。容量预留不执行参与者排空。
- **账户交接** — 只有包内工厂 helper 安装 binding。Helper 要求可信 owner 输入，自身不核验 PG 归属；测试提供 binding 夹具，不据此宣称账户图 ready。
- **关闭顺序** — 根卸载仅关闭本地准入。按序排空图、持久化未知结果、配置保存收据、flush 及共享池关闭仍需完整生命周期实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
