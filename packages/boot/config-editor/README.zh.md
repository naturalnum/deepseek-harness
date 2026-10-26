---
description: "保存当前 profile 配置，并通过 Loader 应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-config-editor

[English](README.md) | 中文

## 概述

将插件配置保存到当前 profile 的 patch 并立即应用。写入在改动磁盘前验证完整候选值，并与 profile 更改及 HMR 串行执行。无效值和更高层覆盖不会改动文件。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在具有 Loader 和 `profileContext` 的 profile 应用中挂载此服务。它没有配置字段。

```yaml
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
```

使用 [settings](../../settings/settings/README.zh.md) 提供只编辑即时字段的表单。编辑完整配置的调用方可使用 `ctx.configEditor.edit()`；普通字段保留 Loader 的正常生命周期。

嵌入式 Host 可通过 `registerSaveHook()` 安装唯一的 `ConfigSaveSubmissionHook`。已接入的 writer 在进入其私有队列前调用 `submitSave(writer, submit)`；hook 同步决定准入，并观察包含必需应用及其失败的实际操作 Promise。原生 writer id 不携带配置值或秘密。没有 hook 时，提交直接调用操作并返回其原始 Promise。调用方必须先停止并结算受保护的 writer，再释放 hook；调用方卸载时也会移除 hook。

`edit()` 在进入 HMR 与文件锁之前提交。Settings 与默认模型 writer 在各自的外层边界提交，以便观察完整操作的完成。同一 editor 内的嵌套提交共享一次准入，直到该操作的 Promise 结算；调用方必须等待嵌套工作。独立提交以及结算后的延续需要重新准入。这可以防止嵌套 `edit()` 在嵌入式 Host 的保存队列中等待自身占用的槽位。插件选择自行写文件，凭据 provider 则拥有独立 hook；两者都不由此 editor hook 覆盖。

嵌入式 Host 还可通过 `registerImpactGuard()` 安装唯一的 `ConfigImpactGuard`。编辑器取得不透明的原生 profile 计划，等待策略检查，再于持久化和实际 Loader 变更前复核。策略批准不能授予重挂或未知影响。受守卫的子集仅支持已稳定的平坦 root Include 中的配置编辑，根文件须为不可变原生条目列表，schema 须属于确定性的原生子集，且只允许原生 config resolver。不支持的 schema 或额外配置回调在候选解析前拒绝。未应用的旧 patch、表达式、嵌套树和结构变化也会拒绝。字段权限仍由 Host 负责。

Loader 预留跨越持久化和应用，拒绝竞争的树变更。原生版本、entry/fiber/模块身份、原始 options、schema 及有效值绑定计划。替换后的受守卫失败可能留下已提交状态；操作会拒绝，不尝试可能重挂的无守卫回滚。调用方须保留失败，并在进一步修改前核清账户状态。此能力仅覆盖 live 子集，并非通用影响规划器。撤回守卫前须停止并结算受保护编辑。

可选 `ConfigEditControl` 跨排队、异步策略和原子替换保留原调用方复查。目标条目必须支持 live 验证；未改动行保留原生 `none` 计划，不执行其 schema 回调。`editFailureOutcome(error)` 只识别本 editor 发出的精确 guarded 拒绝对象：替换前为 `not-published`，开始替换后为 `unknown`。原错误对象身份保持不变。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

未安装影响守卫时，[编辑器](src/index.ts) 在派生候选配置前应用外部更改，与其他 profile 操作共同锁定 profile manifest，并原子替换配置覆盖项。它保留替换值以外的 YAML 注释和 `!!js` 表达式。应用失败时恢复之前的文档并重新加载之前的 patch。安装影响守卫后采用上述受检查的 live 路径，不会先应用未生效的旧 patch。

读取配置时，没有 profile config 覆盖项的条目共用一次组合结果。有覆盖项的条目分别组合，仅移除自身的覆盖项；profile 插入的条目和其他条目的覆盖项仍然生效。返回的配置为独立副本，组合结果不跨读取缓存。

普通受守卫编辑保持仅 live 策略。可信 Host control 可为单个可选条目的纯配置编辑显式选择受限原生 leaf 计划；持久化仍由原 writer 及 Profile 锁持有。字面禁用的条目可保留普通批准配置而不激活。有效值及继承值包含原 root 文件，因此 base-only 条目仍可编辑，无需插入另一个条目或重写该文件。

`ConfigEditControl.check(plan)` 可在原子替换前依据原生准备计划进一步约束可信的有界叶子路径。它不能放行 unknown 计划或扩大原生停止闭包。普通 Settings 调用方继续使用既有 live-only 路径。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Profile 加载](../app-boot/README.zh.md)——patch 组合。
- [HMR](../hmr/README.zh.md)——重载协调。
- [设置](../../settings/settings/README.zh.md)——schema 派生表单。

<a id="model-experience"></a>
## 模型体验

通过面向模型的插件读取的配置值间接影响模型。

#### KV Cache 影响

改变请求前缀的消费者决定缓存影响。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 编辑写入当前 profile patch。Home patch 和命令行 overlay 参与优先级解析，但不作为写入目标。
- 完整配置覆盖保留普通字段，但会在 profile 层固定其当前原始值。
- 仅可编辑 profile 根 Include 拥有且可唯一定位的条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
