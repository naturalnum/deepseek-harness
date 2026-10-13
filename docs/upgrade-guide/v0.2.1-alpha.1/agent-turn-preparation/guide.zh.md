---
kind: upgrade-guide
description: "自定义 Agent 实现必须提供 turn 开始前注册与 pending 唤醒方法。"
---

# Agent 要求 turn 准备与 pending 唤醒

[English](guide.md) | 中文

## 变更

`Agent` 要求 `onBeforeTurn(listener): () => void` 与 `wakePending(): void`。自定义实现和带类型的测试替身必须提供这两个方法。默认 loop 在没有准备 listener 注册时，保留打开 turn 和 claim 输入的同步时机。

## 迁移

1. 实现按顺序执行、由效果拥有的 `onBeforeTurn` 注册，在打开 turn、claim 输入和组装 prompt 之前运行。准备失败报告 `agent/error`，保留未 claim 的输入且不写 turn 边界；取消遵循 `keepInbox`。
2. 实现 `wakePending`，不得插入输入或改变目标。空 inbox 不做任何操作；maintenance 与已中止活动保留既有唤醒行为，包括 disposed 活动保持停放。
3. 运行拥有者的类型检查，并执行[公开生命周期测试](../../../../packages/core/agent-loop/tests/employee6-before-turn.spec.ts)。从不驱动工作的测试替身可提供空方法。[Agent README](../../../../packages/core/agent/README.zh.md#use-this-package) 说明注册所有权和 listener 取消。
