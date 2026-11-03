---
kind: upgrade-guide
description: "Cloud runtime Loader 入口要求完整根配置，并且不再默认导出服务类。"
---

# 配置 Cloud runtime 根

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-pe-cloud-runtime` 及其 `/root` 入口提供函数插件的具名导出 `name`、`inject`、`Config` 和 `apply`。Loader 要求完整的 PostgreSQL、凭据引用、实例、路径、原生配方及容量配置。原先只有三个容量字段的配置不能启动根控制面。

必需的 `accountPolicy` 选择有限且精确的 provider/model 对、原生预设列表、有界规范配置摘要及可选择的部署默认值，以及受保护的 AgentLoop 入口。根控制面 active 不会发布账户或开放业务流量。具名 `PeAccountRuntime` 类保留容量及参与者组件装配。

## 迁移

1. 通过 Cordis 加载 `/root` 模块命名空间。组件消费者将默认导入改为 `import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'`，三个组件容量继续使用 `PeAccountRuntime.Config`。
2. 提供 [RuntimeRootConfigSchema](../../../../packages/cloud/pe-cloud-runtime/src/root-config.ts) 的全部字段。在根启动前安装正式 `credentials` provider，并将 `database.passwordRef` 设为其引用名。密码不得进入账户配置或启动环境。
3. 将 `accountPolicy.presetId`、`presetEntryId` 和 `presetConfigSha256` 替换为 `defaultPresetId` 及非空 `presets` 列表。每项提供 `{id, entryId, configSha256, selectable}`；历史 `cloud-text` 保留为已批准且 `selectable: false`，部署默认值设为 `standard`。用 `accountPresetConfigDigest` 为可信已解析的原生声明计算摘要，保留原生表达式源码。按[包参考](../../../../packages/cloud/pe-cloud-runtime/README.zh.md#account-policy)使用原生入口。声明[清单](../../../../packages/cloud/pe-cloud-runtime/package.json)中的必需 peer，确保原生 provider 使用共享身份。
4. 原生预设 registry entry 命名为 `agent-preset-registry`，通过受保护的 Cloud builtin 保留其原实现。`selectedDefault` 仅批准可选择的 id。若未改写的继承 `default` 仍是历史值，设置 `legacyDefaultPresetId: cloud-text`；适配在读取时映射继承值与精确的原始 `presets` 入口，不改写旧配置或 Session 记录。保留显式 `selectedDefault` override。确认四种批准模式可见、空白会话可切换、默认选择重启后保留、旧会话恢复其投影中的预设。
5. 验证实际 Loader 启动后在 PostgreSQL 登记进程，且根销毁后关闭该记录。files、execution、保存、曝露及所有写入者配额前提通过之前，账户准入保持关闭；根启动成功本身不能满足这些前提。
6. 自定义 `AccountNativeGuards` 实现必须为既有原生 job 清理提供 `assertRetainedExecutionOwner`。不能用它替换普通 active scope 检查。
7. 启用原生 PTC 与持久终端时，使用匹配的流协议、源码 pins、经验证的 guest/server 镜像、显式 `commands.pipes` 预算、原生 PTC 的 8 KiB 消息上限与一个待处理 binding 调用，以及原账户作用域下的原生 `ptc-runtime-node` 与终端登记器。原生 runtime launch 配置显式选择 guest Node `/opt/dsh-native/node` 和 bootstrap `/opt/dsh-native/process.js`。server 必须显式启用其精确审核的 Native bwrap 配置；默认 Docker 命名空间和 proc 限制不能支持此路径。保留既有限额与数据，正常等待旧拥有者结清，并在真实 Web 客户端验证统一版本后再声明模式验收。
