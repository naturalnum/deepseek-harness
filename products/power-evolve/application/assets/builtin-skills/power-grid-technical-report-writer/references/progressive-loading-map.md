# 渐进式加载映射

本文件取代旧版 `SKILL.md` 中“开始任务时一次性读取大量规则文件”的路由方式。原规则文件全部保留；变化仅限于**何时读取**，不改变任何写作、目录、引用、公式、字数、标题或交互规则。

## 运行时规则包

从 v1.1.4 起，维护源规则文件全部保留，运行时优先读取 `compiled-packs/` 中按动作编译的规则包。规则包由 `scripts/compile_runtime_packs.py` 从原阶段文件和专题文件逐块复制生成，不改写规则，只在同一规则包内删除完全重复的规则块。

- 维护和审查规则时，以 `stages/`、`references/` 原文件为准；
- 执行模型调用时，以 `references/runtime-pack-manifest.json` 的动作映射选择规则包；
- 规则包缺失或覆盖校验失败时，回退到本文件下方列出的原始加载表，不得忽略规则；
- 每次改动源规则后必须重新运行编译器与覆盖校验器；
- `00-control` 在任务初始化时加载一次并由编排器维持；`scripts/build_context_bundle.py` 只装配当前生成动作、一个章节类型包、必要附加包及当前结构化 payload，不在每章重复装入控制包，也不装入其他子 Skill 或无关历史正文。
- 技术章“本章小结”的唯一内容规则源为 `references/chapter-summary.md`；目录、章节计划和章节正文三个运行阶段都直接加载该文件，其他源文件只保留调用位置或阶段动作。

编译与校验：

```bash
python scripts/compile_runtime_packs.py
python scripts/validate_runtime_pack_coverage.py
```

## 加载原则

1. Skill 被选中后，先读取 `SKILL.md`。
2. 首次进入工作流时读取 `stages/00-interaction-control.md`，建立严格交互、状态、回退和禁止行为。
3. 每轮优先加载当前动作对应的一个或多个 `compiled-packs/` 规则包；只有规则包不可用时，才按下方原始文件清单回退加载。
4. 不因“可能稍后使用”而提前读取后续阶段文件。
5. 大型示例只在格式不确定、脚本报错定位或用户明确要求示例时读取。
6. Schema、模板和脚本按需调用，不要求模型逐轮全文读取。
7. 同一规则出现于多个旧文件时，按照 `SKILL.md` 中的权威层级执行；不要把重复措辞拼接成新规则。

## 阶段加载表

### 全局初始化

必读：

- `stages/00-interaction-control.md`
- `references/interaction-protocol.md`
- `references/core-principles.md`

仅维护状态时按需读取：

- `schemas/report-state.schema.json`

### 项目档案、中心主旨和论证架构

必读：

- `stages/10-project-and-argument.md`
- `references/content-generation-mode.md`
- `references/report-scope-chapter-mapping.md`

按需读取：

- `templates/project-brief.md`
- `schemas/project-brief.schema.json`
- `templates/chapter-content-brief-request.md`（仅 `source_grounded` 且进入目录前逐章内容概述时）

### 目录与篇幅预算

必读：

- `stages/20-outline-and-literature.md`
- `references/report-architecture.md`
- `references/outline-hard-rules.md`
- `references/technical-title-naming.md`
- `references/three-subpoint-and-indicator-coverage.md`
- `references/research-content-traceability.md`
- `references/outline-research-innovation-alignment.md`
- `references/report-scope-chapter-mapping.md`

确定性检查：

- `scripts/validate_outline.py`
- `scripts/validate_word_count.py`（检查目录登记的计划字数与80%最低验收字数）

仅在需要结构示范或脚本定位时读取：

- `examples/outline-heterogeneous-example.json`
- `examples/outline-specific-topic-example.json`

### 参考文献与第一章国内外研究现状组织

必读：

- `stages/20-outline-and-literature.md`
- `references/citation-and-evidence.md`
- `references/abstract-and-introduction.md` 中与第二章有关的部分

按需读取：

- `schemas/reference-registry.schema.json`
- `scripts/validate_references.py`

### 章节材料准备与章节计划

必读：

- `stages/30-chapter-planning.md`
- `references/chapter-generation-preflight.md`
- `references/research-content-traceability.md`
- `references/figure-and-table-guide.md`
- `references/formula-and-symbol-rules.md`
- `references/chapter-types/` 中与当前章节主类型对应的一个文件

条件必读：

- `references/foundation-chapter.md`（基础或总体框架章）
- `references/technical-chapter-generation.md`（技术章）
- `references/result-analysis-generation.md`（结果分析为主要内容时）
- `references/chapter-types/data-knowledge-construction.md`（识别为 `data-knowledge-construction` 时）

按需读取：

- `templates/chapter-material-request.md`
- `templates/chapter-plan.md`
- `schemas/research-content-coverage.schema.json`
- `templates/research-content-coverage.json`

### 章节或分节正文生成

必读：

- `stages/40-chapter-writing.md`
- `references/chapter-generation-preflight.md`
- `references/narrative-and-heading-style.md`
- `references/style-guide.md`
- `references/independent-report-voice.md`
- `references/narrative-focus-and-power-grounding.md`
- `references/formula-and-symbol-rules.md`
- `references/power-grid-domain-guide.md`
- 当前章节计划阶段已确定的章节类型规则

按内容需要读取：

- `references/citation-and-evidence.md`
- `references/figure-and-table-guide.md`
- `references/foundation-chapter.md`
- `references/technical-chapter-generation.md`
- `references/result-analysis-generation.md`

正文展示前调用：

- `scripts/validate_heading_coverage.py`
- `scripts/validate_word_count.py`
- `scripts/validate_report_language.py`
- `scripts/validate_formulas.py`（当前章或当前节需要公式时）
- `scripts/validate_research_coverage.py`（需要检查研究内容或内部技术事项覆盖时）

### 摘要、关键词、总结与展望

必读：

- `stages/50-abstract-and-finalization.md`
- `references/abstract-and-introduction.md`
- `references/conclusion-and-outlook.md`（最终总结章仅一级标题、正文700—800字）
- `references/style-guide.md`
- `references/independent-report-voice.md`

摘要按需读取并校验：

- `schemas/abstract-evidence.schema.json`
- `templates/abstract-evidence.json`
- `templates/abstract.md`
- `examples/abstract-evidence-example.json`（仅在格式不确定或校验失败时）

### 最终报告组装

必读：

- `stages/50-abstract-and-finalization.md`
- `templates/final-report.md`

组装后依次调用：

- `scripts/validate_heading_coverage.py`
- `scripts/validate_word_count.py`
- `scripts/validate_references.py`
- `scripts/validate_report_language.py`
- `scripts/validate_formulas.py`
- `scripts/validate_research_coverage.py`
- `scripts/normalize_markdown.py`（最后一步，只做确定性清洗）

## 文件不可读取时

如果某个阶段文件或专题规则无法读取，必须停留在当前阶段并说明缺失，不能退化为一次性生成全文。已经读取并确认的前序规则继续有效。
- 当当前章需要实验验证但用户实验材料不足时，额外加载 `compiled-packs/addon-experiment-reference.md`；该包只负责生成参考实验方案、候选数据集/基线和模拟示例，不把模拟结果晋升为真实证据。
