---
kind: upgrade-guide
description: "自定义 ModelsSettingsIntegration 提供方须显式设置 onboarding: false，采用手动配置。"
---

# Models 集成使用手动配置

[English](guide.md) | 中文

## 变更

浏览器可选输入 `modelsSettingsIntegration` 现在要求 `onboarding: false`。它向手动 Settings/Models 页面提供只读元数据和受保护的凭据编辑，不再向首次引导提供第二套受保护的凭据编辑器。现有云页面已提供该值，无须修改配置。省略整个集成的普通原生应用保留原有 Welcome 与凭据引导。

## 迁移

1. 自定义 `ModelsSettingsIntegration` 提供方在现有 `reads`、`editing` 输入旁设置 `onboarding: false`。保持编辑源身份稳定，撤销时发布 `null`。
2. 通过 Settings/Models 配置凭据。确认手动页面仍可用，编辑准入前及撤销后均不注册引导弹窗。需要普通原生引导时省略整个集成，不混用受保护编辑与原生首次配置。
3. 通过原回调验证取消编辑、保存成功、拒绝过期编辑及页面撤销。无须迁移 profile、用户数据或配额。
