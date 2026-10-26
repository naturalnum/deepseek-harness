---
kind: upgrade-guide
description: "Cloud access Root 除浏览器访问设置之外，还要求显式认证数据库和资源配置。"
---

# 配置 Cloud 认证资源

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-pe-cloud-access` 及 `/root` 现在要求 Host `AuthRootConfig`，在原浏览器安全访问配置之外增加必填的数据库、池、凭据和启动预算。Root 安装 `PeAuthService` 并检查已部署的 Better Auth schema。Root ingress 必须显式填写正值 `ingress.sessionRecheckLeadMs`，且小于 `sessionRecheckMs`；缺失或非法值会在认证资源初始化前拒绝。浏览器 `/schema` 和 bootstrap 线类型保持原样。认证初始化后，请求准入仍保持关闭，等待根配方审核及账户选路。

## 迁移

1. 在 access/root 之前安装官方根 `credentials` 提供者。将 `authSecretRef` 和 `database.passwordRef` 设为该提供者的引用；不要将秘密值放进 Loader 配置。
2. 提供 [access 包参考](../../../../packages/cloud/pe-cloud-access/README.zh.md) 中全部数据库、池及凭据/启动字段。显式选择有限上限和 SSL 策略；不接受环境中的 PostgreSQL 默认值。若配置了 `ingress`，将 `ingress.sessionRecheckLeadMs` 设为小于登录最大验证年龄的值，例如在 `sessionRecheckMs: 5000` 时填写 `2500`。`authCheckTimeoutMs` 保持独立；pending 复查不延长登录新鲜度。
3. 单独审查并部署固定 Better Auth 库版本的迁移。Root 拒绝任何剩余迁移或 schema 问题，激活时不执行 DDL。
4. 确认实际 Root 启动后 `PeAuthService.observe().phase === 'initialized'`，同时 `requestAdmission: 'closed'`。独立配方、账户和传输检查通过之前，保持共享 Web 流量关闭。销毁时等待 `close()`；超时或清理失败不代表资源已释放。
