---
kind: upgrade-guide
description: Cloud 插件控制改用目录定义的操作及 JSON Config 字段，原生调用方改用共用的 selection guard。
---

# Cloud 插件目录控制

[English](guide.md) | 中文

## 变更

Cloud 插件请求通过批准目录项标识目标，不再固定为 reminder。每个受控目录项必须包含 `control.selectionTarget`、`operations`、`maxImpact` 及批准的普通 `fields` 路径。配置操作携带 `path` 和字面量 JSON `value`，不再使用 threshold 预设。原生调用方改用 `PluginSelectionGuard` 和 `registerSelectionGuard`，其检查接收带判别标签的 entry 或 bundle 目标。原生 no-HMR 结果保持原意。完整预安装 bundle 选择要求显式图重建控制及替换核验；局部结构变化仍在持久化前拒绝。

## 迁移

1. 为 `approvedConfiguration.plugins` 中每个受控项增加 `control`，指定确切的预安装 module/package/version、entry 或 bundle 选择目标、操作许可、影响上界及普通 Config 路径；`toggleable` 必须与 `enabled` 许可一致。不要将 volatile Settings 字段移入此路径。
2. 重新生成原 Host/Remote Typert 产物。读取 `configuration.fields`，携带原不透明编辑版本发送 `{kind: 'configure', path, value}`。处理原生拒绝和保留的 unknown 结果，不自动重放。 提供整字段编辑前读取各字段的 `writable` 标记。受保护或未获证明的字段使用不透明 schema，且不返回值；原生秘密存在标记只说明已声明秘密是否设置。混合容器应批准更窄的普通子路径；此操作不开放秘密及 volatile 写入。
3. 将 `registerEnableGuard` 改为 `registerSelectionGuard`，检查其 entry/bundle 目标。确认不受支持的结构性 bundle 变化不会改变任一原生 profile 文件，成功应用必须包含原生运行时等待完成及原账户复核。

4. 在 `approvedConfiguration.bundles` 中声明完整 bundle 的确切包/版本及成员标识，仅允许 `selected`，使用 `maxImpact: graph` 和空字段。按 `selectionTarget.kind` 区分当前状态并读取原生 `bundle` 或 `plugin`。完整 bundle 变化使用 `stop-and-apply`，随后重连并读取当前状态。接收及原生无 HMR 持久化不证明应用完成；Root 须完成真实生产替换/PG 验收后才可开放完整流程。
