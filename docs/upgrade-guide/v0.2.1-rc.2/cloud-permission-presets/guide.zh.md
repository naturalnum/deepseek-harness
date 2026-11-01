---
kind: upgrade-guide
description: "Cloud 权限配置需要第三个沙盒预设。"
---

# Cloud 权限配置需要三个预设

[English](guide.md) | 中文

## 变更

装配 `cordis:pe-cloud-permissions` 的 Cloud 部署此前提供两个预设。原生权限服务现在要求恰好包含 `read-only`、`workspace-write`、`danger-full-access`，每项的 `sandbox` 值须与其名称一致，且 `approval` 为 `never`；旧的两预设配置会被拒绝。完整访问仍受账户沙盒及其已有可写挂载和配额约束。

## 迁移

1. 在账户 recipe 或 profile 的 `cordis:pe-cloud-permissions` 入口中，保留原有 `defaultPreset` 和两个预设，并在 `config.presets` 下增加：

   ```yaml
   danger-full-access:
     sandbox: danger-full-access
     approval: never
     name: Sandbox full access
   ```

2. 检查现有 `read-only` 和 `workspace-write` 两项的 `sandbox` 值与名称一致、`approval` 均为 `never`，且没有额外预设。保留账户现有挂载和配额策略。
3. 使用更新后的 profile 重启，确认账户进入 ready，权限控件列出三个模式。向用户开放前，验证账户沙盒内的文件和命令访问。
