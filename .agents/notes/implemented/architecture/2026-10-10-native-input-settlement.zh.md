# Agent Note: Native input settlement and running reservations

Status: implemented

[English](2026-10-10-native-input-settlement.md) | 中文

## 问题

云端 Session 具有一份原生输入日志和另行提交的输入账本。循环在组装 prompt 前同步发布领取移除事件，但异步事件观察者无法在模型或工具获准执行前结算完整领取批次。运行中的命令也需要持有原 live owner 的取消状态和位置，以便 PostgreSQL 提交 canonical 输入。

## 决策

固定 PowerEvolve 基线携带明确登记的原生 API 补丁。`Agent.onAfterClaim()` 在组装 prompt 前等待每个注册的结算 listener 完成完整领取批次。取消和先前 listener 失败仍保留后续结算及首个失败。回调收到独立冻结的消息；已有历史消息对象保持原样。

`runMaintenance(task, { scope: 'inbox' })` 在 idle 或 model streaming 时预留原生 prefix。捕获的 owner 提供 phase、position、取消和 cursor 校验。流式数据保持瞬态；持久模型结算等待命令 commit 和清理。`Session.forPlanning()` 保留准确 prefix，不插入生命周期 marker；`Session.synchronizeCommitted()` 导入经过验证的 committed suffix，不再次发布。云端适配器负责 ledger、presentation、receipt、持久化 cache 和 carrier 同步。

这些补丁独立于固定官方版本登记。移除本地实现前，上游替代接口必须保留完整结算、原消息身份、取消清理、prefix 所有权和两个 SDK 的投影。包级约定由 [Agent README](../../../../packages/core/agent/README.zh.md) 和 [Session README](../../../../packages/core/session/README.zh.md) 拥有；[迁移集成记录](../../../../products/power-evolve/TRIAL-M3-NATIVE-WRITER.md) 拥有产品验收范围。

## 考虑过的替代方案

**仅观察 Session 事件。** 原生领取发布早于异步观察者完成。两个移除事件可能分别进入 PostgreSQL，不能在推理前建立一个原子 cohort。

**每个输入命令都取消活动 turn。** 这会改变用户正在运行的工作及原生取消行为。命令必须在接受或编辑 pending 输入时保留原 owner。

**根据持久状态重建 Agent。** 新实例缺少原 phase、signal 和 model owner。持久化历史不能构造这些事实。

## 后果

自定义 Agent 实现提供新增公开方法；两个 SDK 恢复夹具在重建正式 artifact 后验证循环。结算回调必须完成自身清理，不能等待同一 Agent 的 idle 或销毁。运行中预留目前仅接受 model streaming；prompt assembly、post-claim、pre-step 和 tool 阶段仍拒绝。产品队列、连续 generation 切换及多副本恢复仍是独立的集成工作。
