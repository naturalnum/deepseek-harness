---
description: "面向组合维护者的显式关闭云端执行、原生拒绝提供方及能力诊断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-opensandbox

[English](README.md) | 中文

## 概述

组合维护者可以明确关闭云端执行，同时装配必需的原生拒绝提供方。每个 Shell 和子进程请求都会在执行准备前失败，不创建沙盒或联系后端。启用执行仍不可用，只有空需求列表不能使账户就绪。

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

在 `dsh` profile 组合中挂载 `/root` 和 `/account`。显式 `mode: closed` 会注册实际根执行拥有者，并为每个账户装配各一个原生 ShellExecutor 与 SubprocessRuntime。没有配置能够开启执行；省略关闭模式或声明非空必需能力都会以 `cloud/execution-unavailable` 阻止启动。

### 配置与失败

两个入口都要求显式关闭模式和空能力声明。[schema](src/config.ts) 唯一持有允许的取值；声明不能验证执行能力。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | 省略时启动失败 | 仅支持 `closed`，全部执行保持禁用。 |
| `requiredCapabilities` | 必填 | 关闭模式下必须为空；任何必需能力都会阻止装配。 |
| `maxBoundAccounts` | 根入口必填 | 同时开放准入的精确账户代际数量，必须为有限正整数。 |

runtime 先在独立账户图中安装不可变绑定。原生 prepare 期间，可信工厂将安装后的精确对象及图当前性检查传给根协调器的 `bindAccount`，再在账户入口之前调用 `installAccountExecutionPort`。绑定或 port 缺失、复制、跨图或被影子替换都会失败；重复提供方或容量耗尽也会失败。关闭登记不替代其他账户就绪检查。

可信 bootstrap 装配可调用 `assertClosedAccountExecution(ctx)`，确认原始有效 port 仍持有原始且活跃的原生 Shell 和子进程提供方。缺失、未安装、影子替换、更换或已停止的提供方均被拒绝；此读取不会执行命令、停止 port 或签发 drain 证据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[根拥有者](src/closed-owner.ts) 保留精确登记和永久准入状态，依赖中没有执行后端或进程启动器。停止已知登记时会关闭其 port，并保留该拥有者本代无工作事实的观察；未知或克隆绑定被拒绝。根卸载先关闭全部 port 再撤销参与者；账户卸载只关闭自己的 port。这些观察不能证明较早拥有者或代际的资源。

[原生提供方](src/closed-providers.ts) 共用该 port，拒绝所有方法，包括可执行文件查找和终端准备。spawn 同步拒绝；异步方法返回被拒绝的 Promise，已预先取消的调用者保留原始原因。内部[作用域签发器](src/scopes.ts) 仍单独存在：作用域撤销不能证明分配或进程已停。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [应用组合](../../../docs/architecture.zh.md)
- [原生子进程语义](../../subprocess/subprocess/README.zh.md)
- [生命周期审核规则](../../../docs/defensive-patterns/general.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 执行准入

#### 模型会看到什么

本包不注册模型工具或 Session 事件。模型不能通过配置或复制作用域来开启执行。若其他已装配的原生工具请求执行，会收到 `Cloud execution is disabled by this deployment.`。

#### Token 影响

本包不注入提示词内容。调用被拒绝时，原生消费者的错误文本可能进入其对话。

#### KV Cache 影响

本包不修改请求内容、顺序或缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

关闭模式是受限部署配置，不是已验证的远端执行。

- 全部执行模式和消费者保持禁用。开放任何模式都需要持久分配对账、完整部署配置、目标通道与隔离证据，以及受管范围停止。
- 关闭排空观察只覆盖其精确登记的本代，不提供分配、远端停止或恢复证明，也不能清除旧未知工作。账户就绪和恢复仍由 runtime 持有。
- 原生默认 Bash 执行器依据 subprocess 的 `done` 结算，而该值不能证明所有后代均已停止。Shell 准备与作用域完成仍需要显式、兼容的适配器。
- OpenSandbox 的文本命令流不能提供原生 subprocess 所需的完整原始管道/control 或受管范围观察。本包不提供可启用的执行协议、宿主回退或自动恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

可移植的[显式启用作用域探针](tests/opensandbox-scope-probe.mjs) 要求明确传入 `--workspace-root`、`--sdk-root`、`--out` 和 `--execute-authorized-once` 参数。它使用固定的缓存镜像，最多创建一个有界 Sandbox 及两个内部作用域。其证据分别描述作用域停止、namespace 安全事实和二进制文件 Range 传输；它不启用执行，也不验证完整的 subprocess 语义。

</details>
