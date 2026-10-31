---
description: "通过 Config 派生表单查看和编辑插件的即时配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-settings

[English](README.md) | 中文

## 概述

编辑插件通过 `.volatile()` 声明的字段，并查看其实际值。表单以 profile 条目 id 标识插件、保留秘密值，并拒绝过期写入。更改通过当前 profile 的 Cordis patch 持久化。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将此插件与 Loader 和 [config-editor](../../boot/config-editor/README.zh.md) 一起挂载。基础组合包提供此组合。

```yaml
- id: settings
  name: '@deepseek-ai/dsh-settings'
```

此插件没有配置字段。表单只展示活动且可唯一定位的 profile 条目中的 volatile 字段。普通配置仍通过 Cordis 配置文件编辑。

Settings 启动后、Loader 完成所有条目的加载时，早期版本留在 harness home 中的 `settings.yaml` 会被导入一次：每个 section 写入同名条目（`ui-developer-tools` → `ui-settings`、`ui-onboarding` → `ui-settings-general`、`shell` → 当前平台的 shell 执行器条目），文件在第一次写入前改名为 `settings.yaml.imported`，被当前组合拒绝的 section 会记录日志并只保留在改名后的文件中。

重置恢复 profile 覆盖层以下的值，包括 schema 默认值。Home patch 和命令行 overlay 优先级更高；表单写入若会被它们覆盖，则被拒绝。

每个表单报告 `autoGenerate`（默认开启），供按 schema 生成页面的客户端使用；目前没有已发布的客户端这样做。自带页面的插件在 `apply` 中于可选的 `ctx.inject(['settings'], ...)` 子级内以 effect 注册 `configure({ auto: false }, ctx.fiber)`：子级指明策略所属的插件 fiber，迟加载或被替换的 Settings 服务也会采用该策略，业务插件无需 Settings 即可运行。策略不移除配置读写。

可信 Host 调用方可向 `update`、`replace` 或 `mutate` 传入 `SettingsWriteControl`。Settings 将原复查传递到 ConfigEditor 的实际编辑及替换点；版本比较仍在原生串行写入内进行。省略时保持普通原生写入行为。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[表单投影](src/schema.ts) 去除运行时引用和普通字段。[服务](src/index.ts) 提供带修订号的描述符，在委托持久化前按完整插件 Config 验证编辑。业务插件直接读取自己的 Config 引用。

`update`、`replace` 与 `mutate` 在验证及写入前通过 config-editor 的可选保存 hook 提交。被观察的 Promise 包含 editor 操作及其后必需的描述符发布。嵌套 editor 调用共享该次准入。旧版导入分别提交 rename 与每个 section：保留原有部分导入行为，即使导入器记录失败后继续，被拒绝的 section 仍可被观察。要观察这些启动写入，必须在导入开始前安装 hook。

秘密角色会从值、继承值、配置覆盖和 schema 默认值中脱敏；客户端收到存在标记。元组位置与数组使用相同的标记；字典键为秘密时，整个字典保持不透明，避免键通过标记路径泄露。路径编辑会保留客户端未收到的字段。

共用的 `applyConfigPathOp` 路径编辑函数在父项缺失或为 null 时保留未改动的兄弟项及对象默认值；验证与持久化仍由 ConfigEditor 负责。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [设置参考](../../../docs/subsystems/settings.zh.md)——表单值与修改。
- [Volatile 配置](../../../vendor/loader/README.md)——引用生命周期与通知。
- [配置编辑器](../../boot/config-editor/README.zh.md)——持久化与重载顺序。

<a id="model-experience"></a>
## 模型体验

通过面向模型的插件读取的配置值间接影响模型。

#### KV Cache 影响

改变请求前缀的消费者决定缓存影响。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 嵌套 Include 独立拥有配置，不能通过当前 profile 的表单编辑。
- 字段重置恢复继承值，不能删除下层配置提供的值。取消设置数组索引会移除该元素。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
