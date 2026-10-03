# Power-grid technical report generation Skill v3.6.0

English | [中文](README.zh.md)

The suite retains topic roles, three core research points per chapter with expansion to four or five when necessary, mandatory tertiary headings in technical chapters, power-domain semantics in core secondary headings, no standalone validation section by default, implicit coverage of internal technical requirements, formula selection, evidence in chapter summaries, the fixed three-paragraph abstract, fixed project-profile confirmation items, chapter content briefs before outlining, the 80% chapter word-count minimum, title-length controls, body heading locks and deterministic final Markdown cleanup. The outline architecture incorporates domestic and international research into Chapter 1, starts technical chapters at Chapter 2, combines the former overview and technical route/architecture into untitled opening prose after the chapter heading, assigns X.1–X.3 to core technical sections and defaults the summary to X.4.


## v1.1.31 Figure/table explanations and Word contents collection

- Content generation separates figure/table captions from explanatory paragraphs: captions use `图X-X 图题` / `表X-X 表题`; explanations use expressions such as “该图/该表/上述趋势/上述结果” and no longer start with a figure or table number.
- The final Word child Skill adds F/T TC fields only to actual captions and supplies C TC fields for the Chinese abstract and ABSTRACT; when Word is available, it refreshes all three contents lists and performs visibility QA.

## v1.1.30 Optional outline technologies and abstract results

- When confirming the outline, provide two or three technology candidates for each core research point whose route is not locked, and recommend exactly one; when the source uniquely locks the route, retain only that source candidate. Candidates do not enter the formal outline hierarchy.
- Before generating the formal Chinese abstract, provide three to five candidate opening sentences about the business need and select one for the body.
- The third abstract paragraph prioritizes results corresponding to quantitative and qualitative assessment items in the task document; omit other metrics by default and include at most one or two when they add value.

## v3.6.0 Progressive stage loading and main-file organization

v3.6.0 introduced progressive stage loading through structural reorganization. The current outline architecture replaces only older architecture rules that directly conflict with the new outline requirements; existing writing, evidence, formula, scope isolation and interaction rules remain. Migrated rule blocks retain their original IDs, and a SHA-256 manifest protects currently approved rule bodies against accidental loss in later structural changes.

Directory structure:

```text
SKILL.md                         主调度器，只维护状态、阶段跳转和文件路由
stages/00-interaction-control.md 全局交互、状态、回退和禁止行为
stages/10-project-and-argument.md 项目档案、中心主旨和论证架构
stages/20-outline-and-literature.md 目录、篇幅、参考文献与发展现状组织
stages/30-chapter-planning.md    章节材料准备和章节计划
stages/40-chapter-writing.md     正文生成、检查和章节确认
stages/50-abstract-and-finalization.md 摘要、总结和最终组装
references/                     专题规则，按当前阶段读取
schemas/ scripts/ templates/    确定性结构、校验和输出层
examples/                       仅在需要示范或排错时读取
```

`references/progressive-loading-map.md` is the sole loading entry. Do not read every reference file at task start. Check rule migration integrity with:

```bash
python scripts/validate_rule_restructure.py
```





## Report scope mapping and Chapter 1 research review

Read `task_book_scope` before generating the outline:

- `total_report`: each topic in the task document maps to exactly one technical chapter; chapter count and order match the topics. Multiple research points within a topic default to X.1–X.3 in that chapter, with minimal expansion to X.1–X.N when necessary and elaboration through tertiary headings.
- `specific_topic`: retain the existing rule that each source research point maps to one technical chapter.
- `not_applicable`: without a topic hierarchy, default to research-point mapping.

Chapter 1 contains the fixed `1.2 国内外研究现状`, with `1.2.1 国外研究现状` and `1.2.2 国内研究现状`. Both sections use consistent research themes and author naming, organizing representative routes, progress, applicable conditions and limitations by groups of literature. There is no separate primary research-review chapter, and tertiary headings need not mechanically repeat technical chapter titles. `validate_outline.py` checks the fixed Chapter 1 structure and technical chapter mapping.

## v3.5.3 Mandatory tertiary headings in technical chapters

Technical chapter outlines must extend beyond secondary headings. Each core research point X.1–X.N defaults to two to four tertiary headings; a section may expand to five when necessary. Numbering starts at 1 and remains consecutive. Counts and names may differ with actual technical relationships; mechanical symmetry is not required. `validate_outline.py` checks each section's tertiary heading count and numbering, and a missing section prevents outline submission.

## v3.5.2 Concrete technical names in tertiary headings (now requiring variants/mechanisms)

Each core secondary section defaults to two to four tertiary headings; expansion to five is allowed only when the existing headings cannot accurately cover an expected objective or narrow technical point. Each tertiary technical heading must independently expose a concrete technical signature rather than rely on its parent secondary heading. Span extraction, dual-tower matching, entity recognition, confidence calibration, sample reweighting and parameter updates describe task actions only; specify the model/algorithm variant, key mechanism, constraint or combination. “基于具体技术签名的……” may emphasize a technical point but is not a fixed template.

“基于图神经网络的……”, “基于RAG的……” and “基于Transformer的……” are no longer sufficiently specific. Refine them, for example to “基于关系类型感知异构图注意力的电网故障关联识别方法” or “基于混合检索重排序RAG的电网故障处置建议生成方法”. A concrete technology presented as an existing project fact requires source evidence; when the source is unspecified but a practical outline is needed, propose `model_suggested` candidates and await user confirmation. Even when the parent heading names a fine-grained variant, tertiary technical headings must not become pure task actions; they may retain the same technology family but must identify the current step's own variant or key mechanism. Titles still target 25 visible characters, with the fixed priority “explicit power-domain semantics + explicit technical signature > 40%–60% ‘基于……的……’ phrasing > 25-character guideline”; shortening must not remove power-domain words or technical signatures, or violate the ratio.

## v3.5.1 Preservation of tertiary headings

Once the outline or chapter plan is confirmed, primary, secondary and tertiary headings form a locked list. When generating a complete technical chapter or secondary section X.1–X.N, use Markdown headings to reproduce all confirmed tertiary headings with their original numbers, names, levels and order. Do not convert them to paragraphs, lists or bold phrases, or omit them.

Run before displaying the body:

```bash
python scripts/validate_heading_coverage.py 当前章节.md --outline 已确认目录.json --chapter 2
# 只校验2.1节及其三级标题：
python scripts/validate_heading_coverage.py 当前小节.md --outline 已确认目录.json --section 2.1
```

The script checks missing or renamed headings, level changes and order changes, and reports the retained tertiary heading count. Changing tertiary headings requires returning to chapter planning and reconfirming them.

## v3.5 Workflow additions

The project-profile draft confirms four fixed items: task document and report scope, generation basis, report word count/template/chapter count, and experimental data. In the existing-content mode, collect each chapter's approximate content after argument architecture confirmation, then generate the outline using the existing fixed rules.

The outline confirms a target word count per chapter and calculates the 80% minimum automatically. After generating a chapter or section, run:

```bash
python scripts/validate_word_count.py 当前章节.md --target 5000 --min-ratio 0.8
```

Recheck the final report chapter by chapter against its structured outline:

```bash
python scripts/validate_word_count.py 完整报告.md --outline 已确认目录.json --min-ratio 0.8
```

After all model checks of the final Markdown, run deterministic cleanup as the last step:

```bash
python scripts/normalize_markdown.py 完整报告.md --in-place --dash-style hyphen
```

The script normalizes long dashes to `-` and removes spaces between digits and Chinese characters; use `--dash-style em-dash` to normalize to a Chinese long dash instead.

Outline titles should not exceed 25 visible characters. Secondary and tertiary technical-research headings prioritize concrete technical signatures and the 40%–60% “基于……的……” ratio, with recorded length exceptions when necessary. Functional headings such as experiment, assessment metrics, experimental setup and dataset may stay concise but cannot replace core technical headings X.1–X.3.

## Fixed report structure

```text
第1章 项目概述
  1.1 项目背景与研究意义
    1.1.1 项目研究背景
    1.1.2 项目研究意义
  1.2 国内外研究现状
    1.2.1 国外研究现状
    1.2.2 国内研究现状
  1.3 主要研究内容及思路
    1.3.1 主要研究内容
    1.3.2 研究思路

第2章起 按报告范围映射技术章
  [一级标题后直接写无标题章首导入正文：背景与意义、研究主题、总体技术路线/架构，适合时图文结合]
  X.1 章内研究小点一
  X.2 章内研究小点二
  X.3 章内研究小点三
  X.4 本章小结（默认）

最后一章 总结 / 总结与展望 / 结论（仅一级标题，正文700—800字，不设二三级标题）
参考文献
```

Chapter 1 must not be named “引言”. `1.3.1 主要研究内容` must correspond item by item to the technical plan, task document or equivalent technical source, with brief elaboration. Technical chapters no longer contain secondary overview or technical route/architecture headings. Untitled opening prose retains the existing length rules; `references/chapter-summary.md` owns the complete chapter-summary rules.

## Fixed three-paragraph abstract

Maintain the abstract evidence package from outline confirmation onward. The final abstract contains exactly three consecutive paragraphs:

1. The first covers domain status, practical needs, existing limitations, technical causes and key challenges; the challenge count should match the main research points.
2. The second combines all main research points into one paragraph, with each retaining “problem—technology—core mechanism—capability” and the necessary sequencing, integration or feedback relationships.
3. The third prioritizes results corresponding to assessment metrics in the current report's task scope: actual quantitative results and qualitative capabilities, functions, deliverable status, applicability or engineering effects. Include only one or two other metrics when they add value, followed by the overall conclusion, research prospects, engineering value, applicable conditions and application prospects.

`schemas/abstract-evidence.schema.json`, `templates/abstract-evidence.json`, `examples/abstract-evidence-example.json` and `templates/abstract.md` have been updated together. The default remains five keywords.

## No standalone secondary validation section by default

Place limited test conditions, quantitative results, error analysis and capability limits within the corresponding technical claims in X.1–X.N, using concrete tertiary headings when necessary.

A standalone secondary assessment/validation section may follow the last core research point, shifting the summary number by one, only when the report's core theme is `evaluation-related` and either condition holds:

- The user explicitly requests it.
- The current chapter has extensive, systematic data: multiple datasets, conditions and baselines, ablation or parameter sensitivity analysis, and several result tables.

For `non-evaluation` themes, secondary and tertiary titles must not contain “验证、评估、评价、测评、评测、验收、测试、试验、实验”, regardless of data volume or assessment requirements; `standalone_validation_mode` must be `none`. When an `evaluation-related` theme uses a standalone section, the structured outline must record `standalone_validation_mode=large-data|user-requested` and an exception reason; without that record, the section violates the rules.

## Report scope mapping and chapter research points

- In a total report, each topic maps to one primary technical chapter; technical chapter count and order match the total topics and their original order.
- In a specific-topic report, each source research point maps to one primary technical chapter, preserving point count and original order.
- A total report's primary chapter titles derive from topic names or primary research content; a specific-topic report's primary chapter titles derive from the source point text. Apply only necessary nominalization and grammatical edits.
- In a total report, multiple research points in one topic all enter that topic's chapter rather than become separate primary chapters.
- Each technical chapter defaults to three core research points X.1, X.2 and X.3. Expand minimally to four or five only when expected objectives, scheduled technical points or key research matters cannot reasonably be combined.
- Form the three points from research content, expected objectives, the schedule and internal technical requirements within the current chapter's scope.
- Assign technical matters beyond three points to the most relevant point and elaborate through tertiary headings.
- Do not use another topic's content to supply the third point.

## Topic roles

- Earlier topics are marked `technical-research` and organized as technical research.
- The last topic is always marked `engineering-implementation`, usually covering system development, platform implementation, integration/deployment, demonstration or engineering validation.
- Each chapter may use only its own topic's research content, expected objectives, scheduled technologies, metrics, data and cases.

Technical-research primary, secondary and tertiary titles must not use “机制、建模、体系、定义” as standalone propositions, central nouns or conclusions, or mechanically rename them. Engineering-implementation titles refer to systems, platforms, architectures, modules, interfaces, deployment, integration or application objects.

## Power-domain technical requirements for core secondary headings

Every core secondary heading must state the complete relationship:

```text
电力对象、业务场景或运行约束
→ 具体人工智能、数据、知识、算法或系统技术
→ 该技术在处理链中的作用
```

Pure computing titles are prohibited. Each X.1–X.N technical chapter title must independently name a power-domain object, business scenario or operating constraint, together with a distinctive computing technology and its role. A global ratio no longer replaces checks of individual titles.

Tertiary headings follow actual technical complexity and must be more specific than their secondary parents. Each X.1–X.N defaults to two to four, with at most five when necessary. After outline confirmation, the body must preserve every tertiary heading; none may disappear during generation.

## Implicit coverage of internal technical requirements

Internal mappings may retain task-document entries, assessment items, thresholds and test conditions, but the formal body must not contain:

```text
任务书
考核指标
考核要求
考核细则
规定指标
内部事项编号
```

Express them as the report's own technical objectives, design constraints, performance descriptions, applicable conditions, decision rules, quantitative results and capability limits. For example, turn the internal requirement “知识检索响应时间不超过10 s” into “在典型调度知识查询负载下，知识检索响应时间目标设定为不超过10 s”.

Each internal item defaults to a mapping to X.1–X.N or a tertiary heading, recording `prose_realization`, `source_identity_hidden=true`, evidence status and confirmation location. Claiming an internal item as an achieved project result requires REAL_PROJECT_EVIDENCE; without real results, use design targets, validation plans or explicit placeholders. If the item needs experimental validation, REFERENCE_EXPERIMENT may still be generated and displayed with a clear label; a lack of real results does not prohibit reference experimental data.

## Main rule files

- `templates/chapter-content-brief-request.md` (chapter content briefs before outlining in `source_grounded` mode)
- `references/report-scope-chapter-mapping.md`
- `references/outline-hard-rules.md`
- `references/technical-title-naming.md`
- `references/three-subpoint-and-indicator-coverage.md`
- `references/research-content-traceability.md`
- `references/chapter-generation-preflight.md`
- `references/chapter-summary.md` (sole source for technical chapter summary content rules)

## Validation

```bash
python scripts/validate_outline.py examples/outline-heterogeneous-example.json  # 总报告示例
python scripts/validate_outline.py examples/outline-specific-topic-example.json  # 具体课题报告示例
python scripts/validate_heading_coverage.py 当前章节.md --outline examples/outline-heterogeneous-example.json --chapter 2
python scripts/validate_research_coverage.py examples/research-content-coverage-example.json --mode outline
python scripts/validate_report_language.py 当前章节.md --mode chapter
python scripts/validate_chapter_summary_centralization.py
python scripts/validate_report_language.py 完整报告.md --mode final
python scripts/validate_word_count.py 当前章节.md --target 5000 --min-ratio 0.8
python scripts/normalize_markdown.py 完整报告.md --in-place --dash-style hyphen
```

Outline validation checks the fixed Chapter 1 secondary/tertiary structure, one chapter per topic in a total report or per point in a specific-topic report, technical chapters starting at Chapter 2, core secondary headings, X.1–X.N numbering, two to four consecutively numbered tertiary headings per section (up to five when necessary), each core title's complete power-object/constraint—computing-technology—technical-role relationship, independent power-domain semantics in secondary title subjects, report theme and forbidden non-evaluation title terms, dispersed coverage of key technologies from expected objectives/schedules/assessment requirements through `heading_source_term_plan`, the roughly 40%/60% technology/method ending distribution, topic roles, tertiary specificity and the implicit coverage plan for internal technical requirements. Body heading validation also checks that approved secondary and tertiary headings appear with their original numbers, names, levels and order.

## Formula selection priorities

Existing `must / should / exempt` classification, core formula validity, symbol explanations and source rules remain. In addition:

- Do not normally give standalone formulas for simple counts, ratios, unit conversions, set membership or input/output transformations that one sentence can explain.
- Express theorems, power-domain physical relationships, loss/objective functions, constraints, updates, inference, scoring and key performance relationships fully when needed.
- More technical formulas does not mean filling a quota; remove repetitive transformations and formulas that are not used later.

## Chapter summaries and final conclusions

Every chapter summary and final conclusion must include traceable quantitative statements, qualitative capability judgments and a specific power-domain object or business meaning. Without actual measurements, do not present model-generated values as achieved results. Use confirmed design thresholds, operating conditions or `【待补充数据：……】`; trends from REFERENCE_EXPERIMENT may also be summarized when explicitly labeled as reference/simulated experiments, but must not become claims of verified project performance.

## Author naming in domestic and international research reviews

Chapter 1 section 1.2 defaults to “XXX等人”. A chapter plan may choose “XXX团队” instead, but 1.2.1 and 1.2.2 must use consistent naming. Institutional reports, standards organizations and official projects use the institutions' formal names directly.

See `references/current-rule-baseline.md` for the current active-rule consistency baseline; `CHANGELOG.md` records history only and does not participate in runtime rules.
