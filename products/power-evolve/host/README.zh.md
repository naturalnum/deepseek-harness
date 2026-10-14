---
description: "在独立云端 Host Profile 中组合 PowerEvolve 原生会话、Skills 与有界 Platform 访问。"
kind: package-bundle
---
# @power-evolve/host

[English](README.md) | 中文

## 摘要

独立云端 Host Profile 让用户使用获授权的模型、Skills 和受控工具继续原生 DSH 会话。这个组合层将原生 agent（智能体）服务与 PowerEvolve 的 Platform 适配器组合。运维人员通过产品部署启动器准备它，并与 Platform 分别配置。Host 依赖可信 Platform 完成受理、历史访问和外部动作；它接收操作授权，不持有数据库或提供方凭据。

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

[部署启动器](../deploy/README.zh.md#profile-lifecycle)使用此 bundle 准备独立具名的 Host Profile。私有部署文档拥有 Host origin、Platform URL、worker token 文件和条目覆盖。渲染或启动 Profile 前，先阅读启动器的归属与恢复规则。已构建的应用与原生 Web 产物必须与部署匹配。

Host 通过[应用适配器](../application/README.zh.md)提供原生 agent 执行与已认证浏览器访问。登录和独立审批保留在 Platform。Bundle 声明原生 skill（技能）服务及作用于单个 agent 的 Platform 提供器；它不扫描 Host 文件系统的 skill，也不在 Host 装载用户包代码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`nativeRuntimeRouting=true` 时，此 Host 提供原生 UI、已认证 RPC 路由、PG 字节读取和 Office 适配。它不创建或启动共享 Scheduler 或云 Shell。Platform Runtime pool 选择账号拥有的子进程；原始浏览器 bearer 与 broker 凭据保持独立。默认 `false` 保留此 bundle 独立共享 worker 的执行行为。

<details>
<summary>Profile 组合与操作授权</summary>

[package.json](package.json)声明 `dsh.bundle.patch` 组合层，[cordis.patch.yml](cordis.patch.yml)在独立 Profile 上插入原生 agent 服务和应用适配器。这个组合层不继承原生本机执行 Profile。每个插入包拥有自己的服务行为和生命周期。

后续 Profile 补丁替换条目的完整配置，不合并单个字段。运行时适配器发起有界 Platform 请求，持久化和模型适配器将持久状态与带凭据的请求保留在 Platform。Platform 不可用会阻止这些操作；单独运行 Host 进程不能证明云执行已就绪。

`PE_HOST_WORKER_ID` 提供 runtime 条目的 `workerId`，其运维选定 UUID 必须与 Platform 私有原生输入归属映射一致。省略时生成新的进程本地 UUID，不具有静态路由条目。每个同时运行的 Host 需要不同的已配置 UUID。原生队列接收端只通过当前操作已登记的 Coordinator 接受命令；归属不可用或已替换时拒绝。

八类原生变更在执行前将完整原请求持久化至 Platform。Scheduler 领取任务前对账共享请求，包含上一 Host 身份的原请求。历史回执不安装 Grant，不重放模型或工具。generation 成功退役或 Writer 成功关闭后，确认已经验证的本地回执，再通过有界维护清理。冷清理要求原操作不可恢复且 Session 没有活动 Writer。`nativeIntentReconcileLimit` 默认每次扫描32条，`nativeIntentMaxLocalReceipts` 默认最多65,536个待确认回执。Host 和 Platform 同步升级要求见[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.1/power-evolve-retained-intents/guide.zh.md)。

Scheduler 通过 `nativeInputPollMs`（默认100毫秒）和 `nativeInputBatchSize`（默认16）限制受理输入 polling。每个活动 Session 在操作交接间保留同一个独立 Writer。云端 Agent 在创建前选择 `disposeOptions.keepInbox`，使调用者、factory 及结构 owner 的销毁保留持久 pending 输入；普通原生调用者保持默认取消行为。

生产清单为应用的 peer 依赖图显式提供 Contracts、Connector Runner 和固定版本 Zod。使用链接包的开发 Profile 必须在正式 resolver 中记录每个消费者根；打包安装必须为全部协议导入保留同一个物理 ESM provider。只有 peer 声明不能证明安装满足这些要求。Provider 目录或版本变化需要新进程。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [云端应用](../application/README.zh.md) — 原生 Session 行为与授权。
- [可信 Platform 组合层](../platform/README.zh.md) — 身份、存储与受控派发。
- [部署生命周期](../deploy/README.zh.md#profile-lifecycle) — 归属明确的启动与恢复。
- [已确认迁移范围](../CLOUD-MIGRATION-PLAN.md) — 纳入能力与验收。

-----

<a id="model-experience"></a>
## 模型体验

通过插入的原生服务和[应用适配器](../application/README.zh.md#model-experience)间接影响模型。它们的包拥有模型说明、工具与原生 Session 事件。Bundle 补丁选择系统提示配置；受理操作授权限定模型和工具选择。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待完成工作

Profile 组合有以下运行限制：

- 可信 Platform 必须可用，才能完成受理、任务领取、历史访问、模型调用、个人 Skills 和受控外部动作。
- 覆盖替换条目的完整配置；运维人员必须重新列出所需设置。
- 云执行、Office 和连接器路径需要私有部署配置与独立真实服务验收。
- 这个云端组合层不提供 Device、Desktop 或 Host 本机执行 Profile。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

采用固定官方发布版与[产品指令](../AGENTS.md)。Profile 安装、启动和集成结果保存在当前试用证据中。本文不认证正在运行的部署。

</details>
