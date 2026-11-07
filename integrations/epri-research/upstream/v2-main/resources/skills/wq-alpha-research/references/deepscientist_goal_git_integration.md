# 金融因子格物项目与 Git 集成

仅在金融因子任务同时启用 DeepScientist 格物模式、绑定持久项目目录，或明确要求 Git 研究历史时读取本文件。

## 1. 工作区边界

- 把会话提供的 `projectRoot` 视为项目级研究事实的唯一默认写入位置。
- 把 `wq-alpha-research` Skill 目录视为只读 SOP、references 和 scripts 来源。
- 不要把项目候选、账号 alpha、运行结果或 PnL 写回共享 `SKILL.md`、`auto_submit_memory.md` 或共享 `alpha_db.json`。
- 优先通过环境变量取得凭据。凭据、token、Cookie、账号快照、原始 PnL、缓存和大体积中间数据不得进入 Git。
- 需要复用 Skill 脚本时，从项目目录调用其绝对路径，或者只复制本轮确实需要修改的脚本；记录脚本来源和版本。

## 2. 紧凑项目记录

首次形成可执行研究计划时，按需创建以下结构；不要为聊天式问答创建空目录：

```text
README.md
factor-research/
  RESEARCH.md
  portfolio.json
  candidates.jsonl
  ledger.jsonl
  factors/
    <factor-id>/
      runs/
        <run-id>/
          result.json
          analysis.ipynb
  runs/
    iteration-001.json
```

- `README.md`：面向用户的项目入口，保留目标、运行方式、当前最佳已验证结果、关键文件、限制和下一步。
- `RESEARCH.md`：研究合同和当前前沿，记录市场/资产、频率、持仓期、数据源、样本、成本、约束、成功标准、停止标准和当前路线。
- `portfolio.json`：由 `factor_registry` 原子维护的当前完整因子 Portfolio，供专属 Viewer、恢复、表格导入和 CSV 导出使用；不要手工维护第二份同义文件。已有结构化结果时，把标准 CSV/XLS/XLSX/XLSM/ODS 放入项目目录并调用 `factor_registry(action="import_table")`，不要让模型逐行抄写测量数据。
- `factors/<factor-id>/runs/<run-id>/`：由 `factor_registry(action="attach_series")` 原子维护的单次运行包；`result.json` 保存曲线与评估合同，真实 Notebook 归档为 `analysis.ipynb`，工作台读取同一份运行快照。
- `candidates.jsonl`：一行一个候选，至少记录稳定 id、机制、表达式或特征、所需字段、父候选、预期风险和当前状态。
- `runs/iteration-NNN.json`：记录本轮实际执行的配置、数据边界、候选 ids、真实指标、错误和输出路径。
- `ledger.jsonl`：一行一个路线决策，记录 `keep`、`mutate`、`discard`、`promote` 或 `blocked`，以及证据和下一步。

项目已存在等价文件时继续使用现有结构，不要并行创建第二套账本。

## 3. 第一轮研究合同

开始大量生成候选或调用外部平台前，确认会改变研究结论的缺失项：

1. 路线：WorldQuant BRAIN、通用单因子、Qlib、多因子模型或符号挖掘。
2. 边界：市场/股票池、频率、持仓期、样本区间、数据源和成本假设。
3. 执行权限：只做想法、允许本地验证、允许回测、允许外部模拟、允许提交。

如果用户已经给出答案，不要重复询问。确实缺少决定性信息时，调用一次 `user_input`，最多提出三个问题；优先单选或多选，并把推荐选项放在第一位。

## 4. 每轮循环

每轮只推进一个可验证研究单元：

1. 从 `RESEARCH.md`、最新 `ledger.jsonl` 决策和最新 Git 检查点恢复当前路线。
2. 选择 2-5 个机制差异明显的候选，避免只改窗口或权重。
3. 检查字段可用性、表达式、数据泄漏、成本、容量和已有因子相似性。
4. 运行最小必要的真实评估；没有运行就保持 `idea-only` 或 `locally checked`。
5. 写入本轮 `runs/iteration-NNN.json`，并更新候选状态。
6. 在 `ledger.jsonl` 记录保留、变异、放弃、晋级或阻塞决定。
7. 调用 `factor_registry(action="get")` 取得当前 revision，再用 `factor_registry(action="register")` 登记完整 Portfolio；若本轮已经产出标准表格，则改用 `factor_registry(action="import_table")` 批量登记。因子必须包含机制假设、选择理由、当前判断、真实状态、检查、证据和 `updatedAt`，测得性能必须带稳定的 `metricContext`。
8. 更新 `RESEARCH.md` 的当前最佳结果、关闭路线和下一步。

`factor_registry` 只更新项目内登记和 Viewer，不执行 WorldQuant 或其他平台提交。未测量指标应省略，不能写成 0、估算值或“预计”；外部状态只有在实际复核后才能写入，`ACTIVE` 之外不得记录为 `active`。

若没有产生新的真实数据、文件变化或路线决策，不要伪造进度或创建空 Git 节点。若真实阻塞无法自行解除，调用一次 `user_input` 请求帮助并暂停自动续轮。

## 5. Git 检查点映射

通过共享的 `project_workspace(action="checkpoint")` 只记录有意义的阶段。金融因子模式会把下列阶段作为运行时允许值，并固定绑定 `domain="financial_factor"`：

| checkpoint stage | 金融因子含义                             |
| ---------------- | ---------------------------------------- |
| `plan`           | 研究合同、候选机制前沿或执行边界获批     |
| `baseline`       | 数据、评估工具和已有因子基线已验证       |
| `experiment`     | 一批候选已真实运行并保存配置与结果       |
| `analysis`       | 完成指标、泄漏、稳健性、相关性或失败诊断 |
| `decision`       | 明确保留、变异、放弃或晋级路线           |
| `result`         | 得到通过当前门控的因子或组合             |
| `final`          | 完成项目总结、边界和后续监控方案         |

- `includePaths` 只包含本轮有归属的项目文件。
- `verification` 写明实际执行的命令、平台状态或数据检查，不写计划中的验证。
- 仅在真实测量后写入 `metrics`。可使用 `IC`、`RankIC`、`Sharpe`、`Fitness`、`Turnover`、`Drawdown`、成本后收益和相关性；保持名称、单位、方向和评估条件跨轮一致。
- 金融因子检查点设置 `domain="financial_factor"`，并在可用时把 target 指向 `financial_factor_portfolio`；这样分支、性能与因子 Viewer 使用同一条研究轨迹。
- 一批候选通常对应一个实验或分析检查点，不要为每个 API 请求或单个失败候选创建 Commit。

## 6. 项目结论与知识沉淀

- 项目 Git 保存该项目的完整可审计轨迹；失败路线同样保留简洁原因，避免重复探索。
- 共享 Skill 的演化是独立步骤。只有多轮或多项目证据支持一条稳定规律、内容已脱敏且用户明确批准时，才预览并执行 `evolve_skill.py --apply`。
- 项目结束不等于因子生产可用。明确区分 `idea-only`、`locally checked`、`backtested`、`robust`、`paper-traded` 和 `production-ready`。
