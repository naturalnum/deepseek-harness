---
kind: upgrade-guide
description: "自定义 ConnectionHandle 实现必须提供新增的 stop 方法。"
---

# ConnectionHandle 要求提供 stop

[English](guide.md) | 中文

## 变更

`ConnectionHandle` 现在要求 `stop(): void`。缺少此成员的自定义实现和有类型的测试替身无法再通过编译。随产品提供的浏览器实现会撤回 generation source，并阻止自动重连，直到注册新的 source。

## 迁移

1. 为 `ConnectionHandle` 实现添加 `stop(): void`。撤回当前 source，取消其 controller，并清除已发布的 generation；重复调用不得产生额外效果。
2. 在切换已认证账号或凭据过期跳转前调用 `ctx.connection.stop()`。只有确立下一身份后才能注册新的 source。
3. 运行客户端拥有者的类型检查，确认停止已建立的连接会清除 generation，且 `reconnect()` 无法恢复已撤回的 source。产品的 [generation 测试](../../../../packages/client/connection/tests/generation.client.spec.ts)覆盖这一行为。
