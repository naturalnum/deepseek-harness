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

Host 可登记唯一保存提交钩子与影响守护。钩子在进入队列前批准实际操作，嵌套写入沿用该操作的完成责任。存在影响守护时，编辑器准备原 profile 计划，在异步策略后重核调用方，再保留 Loader 直到原子替换与重新应用完成。不支持或过期的计划在替换前拒绝；子计划在替换后失效时，即使插件仍处于活动态，保存也必须失败。受守护的兄弟项更新全部结算后再返回子项拒绝。替换后的失败保留结果未知，不触发无守护回滚。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[编辑器](src/index.ts) 与其他 profile 操作共同锁定 profile manifest，并原子替换配置覆盖项。普通编辑在派生候选配置前应用外部更改；受守护编辑要求已应用的 profile 与其准备计划一致。它保留替换值以外的 YAML 注释和 `!!js` 表达式。未安装影响守护时，应用失败会恢复之前的文档并重新加载之前的 patch。

读取配置时，没有 profile config 覆盖项的条目共用一次组合结果。有覆盖项的条目分别组合，仅移除自身的覆盖项；profile 插入的条目和其他条目的覆盖项仍然生效。返回的配置为独立副本，组合结果不跨读取缓存。

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
