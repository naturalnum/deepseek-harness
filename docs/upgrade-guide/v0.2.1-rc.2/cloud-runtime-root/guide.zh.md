---
kind: upgrade-guide
description: "Cloud runtime Loader 入口要求完整根配置，并且不再默认导出服务类。"
---

# 配置 Cloud runtime 根

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-pe-cloud-runtime` 及其 `/root` 入口提供函数插件的具名导出 `name`、`inject`、`Config` 和 `apply`。Loader 要求完整的 PostgreSQL、凭据引用、实例、路径、原生配方及容量配置。原先只有三个容量字段的配置不能启动根控制面。

具名 `PeAccountRuntime` 类保留容量及参与者组件装配。根控制面 active 不会发布账户或开放业务流量。

## 迁移

1. 通过 Cordis 加载 `/root` 模块命名空间。组件消费者将默认导入改为 `import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'`，三个组件容量继续使用 `PeAccountRuntime.Config`。
2. 提供 [RuntimeRootConfigSchema](../../../../packages/cloud/pe-cloud-runtime/src/root-config.ts) 的全部字段。在根启动前安装正式 `credentials` provider，并将 `database.passwordRef` 设为其引用名。密码不得进入账户配置或启动环境。
3. 声明 runtime 的 `@deepseek-ai/dsh-credentials` 和 `@deepseek-ai/dsh-pe-cloud-api` peer。根所有权及清理要求见[包参考](../../../../packages/cloud/pe-cloud-runtime/README.zh.md)。
4. 验证实际 Loader 启动后在 PostgreSQL 登记进程，且根销毁后关闭该记录。files、execution、保存、曝露及所有写入者配额前提通过之前，账户准入保持关闭；根启动成功本身不能满足这些前提。
