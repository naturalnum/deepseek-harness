---
kind: upgrade-guide
description: "自定义 Client store 包装器以及 Conversation 或 schedule 注入 props 必须转发页面持久化依赖。"
---

# 转发 Client 页面持久化依赖

[English](guide.md) | 中文

## 变更

原生 store 和直接缓存 helper 接受从 `@deepseek-ai/dsh-client-store` 导入的捕获式 `ClientPersistence`。`StoreHandle.create` 接收可选的第二个参数。丢弃该参数的自定义包装器可能访问普通 origin 存储，而不是页面命名空间。Conversation Factory 注入新增正文宽度回调；schedule 详情注入新增最近时区回调。普通应用调用者可以继续省略选项。

## 迁移

1. 将 `create(scopeKey, persistence)` 转发给被包装的 handle，并在自定义读写、删除和枚举中使用同一端口。参见 [store 参考](../../../../packages/client/store/README.zh.md#page-persistence)。
2. 为自定义 Conversation 注入实现补充 `readContentWidth` 和 `writeContentWidth`，为 schedule 详情注入补充 `loadRecentTimeZones` 和 `rememberTimeZone`。Factory 本地组件由 renderer 提供继承的注入字段。
3. 对隔离的云端页面，用 `{ persistence: port, requirePersistence: true }` 构造 `AppWebEntry`。只捕获一次账户／代际，在停止并等待原生图前撤销端口，再仅清理退役命名空间。不要导入旧的未分区 origin 缓存。
4. 验证必需端口缺失会在模块激活前拒绝，相同账户／同代际刷新恢复自己的缓存，其他账户／代际不恢复这些缓存，且撤销后释放的回调不能写入或删除持久化状态。[Cloud 页面拥有者](../../../../packages/cloud/pe-cloud-client/README.zh.md#understand-the-implementation)说明预算和清理失败。
