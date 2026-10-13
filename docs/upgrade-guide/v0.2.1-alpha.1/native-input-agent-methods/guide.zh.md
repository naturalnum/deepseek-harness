---
kind: upgrade-guide
description: "自定义 Agent 实现必须提供原生输入结算及所属 activity 捕获方法。"
---

# 自定义 Agent 结算完整原生输入领取

[English](guide.md) | 中文

## 变更

PowerEvolve 在 v0.2.1-alpha.1 上的补丁为公开 `Agent` 接口增加必需的 `onAfterClaim()` 和 `captureInboxActivity()` 方法。实现该接口的自定义 Agent 工厂及测试替身必须提供它们。维护中的 AgentLoop 提供这两个方法。补丁保留已有 SDK wire 命令及 Session 事件格式。

`runMaintenance()` 接受可选 Inbox scope，供 idle 或 model-streaming 输入命令使用。持有者在释放前完成命令 commit 和 mirror 清理。其他运行阶段拒绝取得；普通调用仍要求 idle。参见 [Agent 约定](../../../../packages/core/agent/README.zh.md#reserve-running-native-input)。

## 迁移

1. 根据 [runtime-types.ts](../../../../packages/core/agent/src/runtime-types.ts) 更新自定义 `Agent` 实现。必须在组装 prompt 前结算完整领取，保留取消清理和首个失败，并从准确 live owner 返回 activity 捕获。无操作结算实现不能提供云端持久性。
2. 使用 [Session.forPlanning 与 synchronizeCommitted](../../../../packages/core/session/README.zh.md) 进行 detached 命令规划及 validated committed mirror 同步。外部适配器仍须证明 commit，并同步 writer cursor 和 carrier；这些方法不授予执行权限。
3. 重建修改过的原生包，并通过维护中的 [snapshot 与 smoke 流程](../../../testing.zh.md) 核查两个 SDK 的恢复投影。
4. 使用 `pnpm exec vitest run packages/core/agent-loop/tests/native-input-seams.spec.ts packages/core/agent-loop/tests/running-inbox-maintenance.spec.ts` 确认原生结算及运行中清理。此项验证原生 API；产品 Profile、队列及恢复验收使用[迁移记录](../../../../products/power-evolve/TRIAL-M3-NATIVE-WRITER.md)。
