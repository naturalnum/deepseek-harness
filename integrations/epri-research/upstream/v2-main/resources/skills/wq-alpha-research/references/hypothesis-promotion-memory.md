# 假设卡、晋级与失败经验

只在候选准备写入 Portfolio、需要解释晋级状态，或要复用历史失败经验时读取本页。普通想法探索和单次指标查看不需要读取。

## 1. Hypothesis Card Lite

每个新实现用一张简短卡片约束“想法”和“代码”必须一致：

- `mechanism`：为什么可能产生未来收益；
- `expected_sign`：预期方向；
- `expected_horizon`：预期生效周期；
- `uses_columns` 与 `data_availability`：实际用到的字段及其何时可得；
- `falsification_condition`：什么观察会否定假设；
- `known_analogs`：已知相近因子或论文，可以为空。

自动挖掘把这些字段放在静态 `FACTOR_META` 中。新代码必须使用 `deepscientist.factor_meta.v1`，`uses_columns` 不能为空。技术修复可以同步字段和可得性说明，但不能为了迎合搜索结果倒改机制、方向、周期或否定条件。

## 2. 受限 Python，而非 Typed DSL

当前保留 Python 表达能力，不开发新的 DSL。生成代码只允许 NumPy/pandas、静态常量、辅助函数和一个因子函数；禁止任意文件/网络/进程访问、顶层执行、未来数据、逐行状态机和不受控动态代码。

每次生成或修复后都重新记录：

- `factor_meta`：Hypothesis Card Lite 与数据合同；
- `static_diagnostics`：位置无关的 AST 指纹和结构统计；
- `static_integrity`、`prefix_invariance`、`search_backtest`：分别标记 `passed`、`failed` 或 `not_run`。

这里的 `search_backtest` 只服务搜索排序，不能充当晋级检查。

## 3. 搜索分与晋级资格分开

`searchScore` 只回答“同一冻结搜索协议里先看哪个候选”。它不能证明样本外稳定、成本可承受、与现有组合不同，或已达到正式因子资格。

晋级必须同时具备完整 Hypothesis Card、八项独立检查全部通过，以及每项检查可追溯到候选证据列表中的至少一个回执：

1. 假设与实现一致；
2. 静态完整性；
3. 未来数据扰动不改变历史输出；
4. walk-forward 稳定；
5. 成本后仍可接受；
6. 与现有组合不过度重复；
7. 加入组合后有边际价值；
8. 冻结样本外验证。

缺任一项时显示“未就绪”和缺失项。即使搜索分最高，也不得写成 `qualified`、`submit_pending` 或 `active`。历史 Portfolio 可以继续读取；只有新的向上晋级写入才执行该门禁。

## 4. Git 中的精简失败经验

每个搜索 job 自动写入 `factor-research/mining/<job-id>/lessons.json`，最多十条，只记录：失败类型、简短症状、是否修复、修复次数、验证结果、AST 指纹、来源 job/commit。

不要保存完整源码、完整日志、凭据、私有数据或晋级决定。需要跨 job 复用时，由 Lead 只选择最相关的 1-2 条，整理到项目级 `factor-research/lessons.json`；该文件建议不超过 4 KiB，并通过 `knowledgeRefs` 显式传入。当前数据、协议和真实检查始终优先于历史经验。

## 5. Team 使用

DeepScientist Team 启用时，Lead 先派发一波真实任务，再结束当前轮等待 Worker 回传。可拆分为机制候选、时间可得性/泄漏审计、实现审查和反证方案；Worker 不直接启动 canonical 搜索或写 Portfolio。

所有角色的 MCP 工具确认就绪后，系统才发送首条 Lead 消息。任何角色加载失败、连接错误、降级或超时都应终止创建并清理 Team，不能退回成一个看似成功但实际没有团队协作的普通发送。
