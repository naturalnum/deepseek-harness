---
description: "面向云端组合维护者的 OpenSandbox 能力声明、执行不可用诊断和可信会话作用域检查。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-opensandbox

[English](README.md) | 中文

## 概述

本包在必需基础设施或目标验证缺失时拒绝云端执行。组合维护者可以检查能力缺口，校验有界、可撤销的会话作用域，且不分配沙盒。当前没有可用的执行模式，空的需求列表也不能使账户就绪。

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

`/root` 和 `/account` Loader 入口属于 `dsh` profile 组合。两个入口目前都会在发布协调器、排空参与者或原生提供方之前以 `cloud/execution-unavailable` 失败。不存在能开启执行的配置。导入本包、解析其配置和创建内部作用域都不会分配计算资源或联系后端。

### 配置与失败

两个入口都要求同一份显式能力声明。[schema](src/config.ts) 唯一持有允许的模式名称；声明某种模式并不等于完成验证。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `requiredCapabilities` | 必填 | 部署配方要求的模式；空数组不能绕过缺失的基础设施。 |

持久分配对账、可信账户端口、目标通道验证、资源隔离和受管范围停止仍是前置条件。[Loader fixture（测试前置数据）](tests/fixtures/entries.cordis.yml) 和[组合测试](tests/composition.spec.ts) 展示的是拒绝路径，而不是可工作的部署。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

Host 库公开能力评估、其类型化错误和协调器 Service Definition。[协调器定义](src/coordinator.ts) 直接使用 runtime 包的 AccountBinding 与排空收据类型，并复用 Cordis 的服务唯一注册机制。它不提供后端或收据实现。

内部[作用域签发器](src/scopes.ts) 保留同一个绑定，以及由项目所属适配器提供的项目类型。它检查精确的原生 agent（智能体）身份、限制存活作用域数量，并在签发和使用时调用当前账户代际、项目、消费方和模式授权检查。复制的或来自其他签发器的作用域会被拒绝。撤销只关闭用户准入，不声称任何进程或分配已经停止。

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

本包不注册模型工具、不改变模型输入，也不发出 Session 事件。模型不能设置 `requiredCapabilities`、构造作用域或调用未验证的模式。

#### Token 影响

本包不添加模型可见内容，因此不增加输入 token。

#### KV Cache 影响

本包不修改请求内容、顺序或缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

在接入真实所属服务并验证目标保证之前，执行始终不可用。

- 根协调器实现和必需执行参与者注册依赖持久对账与已验证的目标证据。原生 ShellExecutor 和 SubprocessRuntime 提供方仍未安装，因此这些入口不能满足账户就绪要求。
- 作用域签发器仅供内部使用。它不能替代账户工厂的受限执行端口、项目授权或目标能力验证，也不定义替代的 AccountBinding 或排空协议。
- 原生默认 Bash 执行器依据 subprocess 的 `done` 结算，而该值不能证明所有后代均已停止。Shell 准备与作用域完成仍需要显式、兼容的适配器。
- OpenSandbox 的文本命令流不提供原生 subprocess 接口所需的完整原始管道/control 行为或受管范围观察。本包不提供 helper、最终执行协议、停止证明、宿主回退或自动恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

可移植的[显式启用作用域探针](tests/opensandbox-scope-probe.mjs) 要求明确传入 `--workspace-root`、`--sdk-root`、`--out` 和 `--execute-authorized-once` 参数。它使用固定的缓存镜像，最多创建一个有界 Sandbox 及两个内部作用域。其证据分别描述作用域停止、namespace 安全事实和二进制文件 Range 传输；它不启用执行，也不验证完整的 subprocess 语义。

</details>
