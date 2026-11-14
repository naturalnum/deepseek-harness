---
kind: upgrade-guide
description: "Cloud Office 预览由 officeToPdf 迁移到上游 officeKit 命名空间。"
---

# Cloud Office 预览使用 officeKit

[English](guide.md) | 中文

## 变更

Cloud 账号适配器使用上游 `@deepseek-ai/dsh-office-kit` 提供方。选中的 RPC 端点为 `officeKit/render` 和 `officeKit/generation`，处理方标识为 `native:officeKit`。已移除的 `officeToPdf` 命名空间和包不再被选中。Session 与账号授权、PDF 字节限制和未确认清理责任仍须保留。Cloud 适配器不启用新提供方的图片、保存文件转换或重算方法。

## 迁移

1. 在部署开放清单中将 `officeToPdf/render`、`officeToPdf/generation` 改为 `officeKit/render`、`officeKit/generation`，两者的处理方标识改为 `native:officeKit`。分别保留 `account-session` 和 `authenticated-account` 守卫。
2. 将直接导入的 `@deepseek-ai/dsh-office-to-pdf` 改为对应的 OfficeKit 类型和提供方。原有私有 `pe-cloud-office-to-pdf` Loader 内置选择器保持不变。
3. 正常重新生成 Host 和 Client 类型目录，并同步更新客户端。核验授权 PDF 预览和跨账号、跨 Session 拒绝；缺少已选方法时仍须阻止就绪。
