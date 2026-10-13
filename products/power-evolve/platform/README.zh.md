---
description: "配置可信 PowerEvolve Platform Profile，用于账号、持久云端操作、存储与带凭据派发。"
kind: package-bundle
---
# @power-evolve/platform

[English](README.md) | 中文

## 摘要

独立 Platform Profile 让云端用户认证身份、管理本人资源并授权受控动作。这个组合层将 Web 服务连接至可信 PowerEvolve 应用。运维人员通过部署启动器提供私有数据库、凭据、存储和执行设置。Platform 拥有持久操作与派发授权；独立 Host 和 worker 进程运行 agent（智能体）与用户命令。

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

[部署启动器](../deploy/README.zh.md#profile-lifecycle)使用此 bundle 准备独立具名的 Platform Profile。私有部署文档提供凭据文件路径、存储、数据库访问和条目覆盖。使用归属明确的数据库、namespace 和端口；渲染和启动前遵守启动器的归属规则。

[应用](../application/README.zh.md)拥有认证、资源事务和就绪检查。Platform 的[受保护 POSIX 文件服务](../application/src/platform/safe-posix.py)需要 Python。当前云端 schema 初始化和配置的账号准备先于就绪文件；就绪本身不认证所有外部服务。

补丁为每位用户的个人库选择 `builtin.pdf`。`enabledBuiltinSkills` 选择当前内置目录，`preinstalledSkills` 选择自动安装项。既有包资产及安装历史保留。`skillLibraryRoot` 指定私有 POSIX 存储；启用 Cloud 执行时必须等于 `sandboxLocalRoot`，且 `workspaceRoot` 必须指向该根下的 `workspaces` 目录。`maxSkillsPerUser` 限制个人库规模。预置 skill（技能）不启动执行环境。

`nativeIntentKeyFile` 指向 Platform 私有文件，内容为32字节密钥的规范 base64url 编码。该密钥随私有配置备份保留；Host 只接收 worker 凭据。四个 `nativeIntentMax*` 配置分别限制每个 Session 的请求字节、未决记录数、总记录数及存储字节。[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.1/power-evolve-retained-intents/guide.zh.md)拥有运维迁移步骤。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>可信配置与派发归属</summary>

[package.json](package.json)声明 `dsh.bundle.patch` 组合层。[cordis.patch.yml](cordis.patch.yml)将日志、Web 服务与可信应用插入独立 Profile。后续 Profile 补丁替换条目的完整配置；每个插入包拥有自己的行为和生命周期。

数据库和提供方凭据保留在 Platform。Host 适配器接收有界 API 与当前操作授权。连接器、Sandbox 和 Office 服务保留各自的执行身份；可信应用拥有受理与对账。Bundle 本身不保存持久操作状态。

`PE_NATIVE_INPUT_OWNER_ROUTING_FILE` 选择应用的私有原生输入归属映射。配置和拒绝规则由[应用参考](../application/README.zh.md#understand-the-implementation)拥有。映射必须列出各参与 Host 配置的 worker UUID 及允许的 HTTP origin；浏览器请求不能选择目的地。

生产清单为应用的 peer 依赖图显式提供 Contracts、Connector Runner 和固定版本 Zod。安装受理要求全部协议消费者（包括传递 helper）共享选定的 Node ESM 模块。链接 Profile 必须记录每个消费者根；独立 worker 需要自己的完整生产依赖闭包。Provider 变化需要新进程。浏览器校验实例彼此独立。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [云端应用](../application/README.zh.md) — 授权与持久操作。
- [Host 组合层](../host/README.zh.md) — 原生 agent 执行。
- [云端命令镜像](../sandbox/README.zh.md) — 挂载执行与清理限制。
- [部署生命周期](../deploy/README.zh.md#profile-lifecycle) — 私有配置与准确进程归属。
- [已确认迁移范围](../CLOUD-MIGRATION-PLAN.md) — 纳入能力与验收。

-----

<a id="model-experience"></a>
## 模型体验

通过[应用](../application/README.zh.md#model-experience)间接影响模型；应用授权模型请求、选定 Skills 与受控工具结果。Bundle 不添加自己的模型提示或原生 Session 事件。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待完成工作

运维人员必须满足可信应用的要求：

- 私有凭据与数据库访问只属于 Platform，不属于 Host 配置。
- 云执行、连接器和 Office 执行需要明确的私有服务配置与当前真实服务验收。
- Profile 覆盖替换完整设置块；所需字段必须保留。
- Schema 就绪不能证明物理执行隔离、备份恢复或同版本组合验收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

采用固定官方发布版与[产品指令](../AGENTS.md)。当前 schema、启动与恢复证据保存在迁移和部署记录中；历史试用结果不认证此 Profile。

</details>
