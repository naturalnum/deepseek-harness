# 实验参考方案生成规则

## 1. 适用目的

当用户没有提供完整实验数据、实验设置、数据集说明、对比方法、消融方案或评价结果时，不再把这些缺口全部视为阻塞项。模型允许在不冒充真实项目事实的前提下，生成一份独立的“实验参考包”，用于帮助用户设计、补做或补充实验。

实验参考包是给用户的参考设计，不是已完成实验的事实证据。它应作为章节计划和实验正文草案的结构化来源；当当前章需要实验验证且真实数据不足时，默认生成并可直接写入报告草稿，结构化包中必须保留来源状态；正式正文不需要逐项显式写“参考实验/模拟实验/示例数据/参考结果”，统一按 `experiment-evidence-layering.md` 在章末说明一次。它不会因为进入正文而自动晋升为最终报告中的已验证结果。

## 2. 可以自主生成的内容

模型可以结合当前章研究目标、电力对象、算法/模型、工程约束和预期指标，自主提出：

- 实验目标、验证问题和假设；
- 实验场景、工况、变量、控制变量和随机种子策略；
- 数据集使用方案，包括用户已有数据字段设计、公开数据集候选、合成/模拟数据构造方法、训练/验证/测试划分方式；
- 评价指标及其选择理由；
- 对比方法、经典基线、强基线和与本章方法相近的候选方法；
- 对比实验、消融实验、参数敏感性实验、鲁棒性实验、泛化实验、不同电网工况实验；
- 建议的软件环境、硬件类别、主要超参数和重复实验次数；
- 用于说明预期表格结构、数量级和结果趋势的模拟/示例实验数据；
- 结果表、消融表、敏感性曲线数据、误差分布数据及对应绘图说明等参考图表结构；实际插图仍按白框占位规则处理；
- 用户后续需要补充、替换或实测确认的项目清单。

允许提出比用户现有材料更完整的实验设计，只要不改变已确认研究问题和技术边界。

## 3. 参考数据与真实数据必须分层

所有由模型自主生成的实验数值必须标记为以下状态之一：

- `simulated_reference`：模型生成的模拟参考值；
- `illustrative_example`：仅用于说明表格或趋势的示例值；
- `expected_range`：基于技术常识给出的建议范围或目标区间。

不得把以上状态写成：

- 已测得；
- 实验结果表明；
- 相比基线提升了；
- 项目达到某准确率/响应时间/鲁棒性；
- 已在某真实数据集或现场系统完成验证。

只有用户提供、文件中存在或后续明确核验的实验数据，才可以标记为 `verified_real_result` 并进入正式成果结论、摘要第三段和本章小结中的已实现结果。

## 4. 实验参考包的默认结构

推荐输出：

```yaml
experiment_reference_package:
  reference_only: true
  evidence_status: "model_generated_reference"
  draft_report_inclusion: "allowed_with_chapter_end_notice"
  chapter_id: ""
  research_question: ""
  experiment_objectives: []
  dataset_plan:
    - dataset_or_source: ""
      source_status: "user_data_template | public_candidate | synthetic"
      intended_use: ""
      fields_or_features: []
      split_strategy: ""
  experiment_settings:
    scenarios: []
    variables: []
    software_assumptions: []
    hardware_assumptions: []
    random_seed_strategy: ""
    repeated_runs: ""
  evaluation_metrics: []
  baseline_methods:
    - method: ""
      baseline_role: "classical | mainstream | strong | related"
      selection_reason: ""
  experiment_items:
    comparison: []
    ablation: []
    sensitivity: []
    robustness: []
    generalization: []
  simulated_reference_data:
    - table_id: ""
      data_status: "simulated_reference"
      purpose: ""
      columns: []
      rows: []
  reference_result_analysis:
    - "说明模拟参考数据的比较关系、预期趋势、模块贡献和后续真实实验需要核验的结论"
  user_supplementation_checklist: []
```

`reference_only: true` 只表示该包在**证据语义上属于参考材料**，不能作为已验证项目证据；它不表示“只能放在报告外”。当 `draft_report_inclusion: allowed_with_chapter_end_notice` 时，可以按第7节规则写入报告草稿，并在使用模拟数据的章节末尾统一说明一次。

## 5. 数据集候选规则

数据集方案可以分三类：

1. **用户项目数据模板**：根据当前研究对象设计建议字段、时间粒度、样本单位、标签和数据划分方式，等待用户替换为真实数据；
2. **公开数据集候选**：可以提出适合的公开数据集类别或名称。若具体数据集的来源、版本或可获取性未核验，只能写成候选，不得声称已实际下载或使用；
3. **合成/模拟数据**：可以给出仿真系统、规则生成、扰动注入、故障注入、采样策略和规模建议，生成参考表格或示例值时必须在结构化数据中标记为模拟；正式报告正文按章末统一说明规则处理，不在每个表格中重复提示。

## 6. 对比方法规则

对比方法应形成层次，而不是只挑最弱基线：

- 传统或物理/统计基线，用于说明基本增益；
- 与当前任务匹配的主流计算机方法；
- 至少一个较强或较新的同类技术路线候选；
- 本章方法的关键变体，用于消融。

如果具体方法并非用户已有实现，只能表述为“建议对比方法/候选基线”，不得在正式结果中写成已经完成对比。

## 7. 与正式报告正文的关系

实验参考包既可以作为结构化用户参考材料，也可以直接支撑报告草稿中的实验部分。正式正文继续遵守真实性边界：

- 实验设置、数据集使用方式、对比方法等设计性内容，经用户确认后可以作为“实验方案”进入正式正文；
- 模型生成的模拟数值不得因为用户确认实验方案而自动变成真实结果；
- 用户提供真实结果后，应使用相同表格、指标和实验结构替换参考数值；
- 当真实数据不足且当前章节需要实验验证时，默认允许在报告草稿中保留模型生成的实验内容，不必等待用户额外授权。正式正文不在标题、表注和每个结果句中反复增加“参考/模拟”提示；只要实际使用了模型生成数据，按 `experiment-evidence-layering.md` 在整章末尾统一增加一次说明。用户明确要求不生成模拟数据时除外。

## 8. 与摘要、本章小结和审核的关系

`simulated_reference`、`illustrative_example` 和 `expected_range` 的实验结果、趋势与分析如需进入技术章“本章小结”，统一按 `references/chapter-summary.md` 的成果与实验结果使用方式进行归纳。摘要仍执行其自身的事实与篇幅规则。

这些参考内容可以用于：

- 说明后续应补哪些实验；
- 形成实验章节/三级标题的结构；
- 帮助用户补充真实数据；
- 给出预期趋势和分析框架。

审核时，清楚标记为参考方案的模型生成实验内容不视为“编造项目事实”；只有当参考内容被改写为已完成事实时，才按证据不足或虚构结果处理。
