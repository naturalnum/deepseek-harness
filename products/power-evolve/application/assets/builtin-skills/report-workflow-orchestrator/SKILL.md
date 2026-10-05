---
name: report-workflow-orchestrator
description: 编排电网科技报告的项目档案、论证架构、目录、章节生成与审核、全文审核，以及最终 Word 排版、格式修复和逐页验收。所有子 Skill 名称和动作集中在配置区。
version: 1.1.29
---

# Report Workflow Orchestrator

> 安装结构：本 Skill 与 `power-grid-technical-report-writer`、`report-reviewer`、`tech-report-writer` 作为 `.codex/skills/` 下的四个同级目录安装。编排运行代码、Schema、示例和注册表均随本 Skill 自包含，不依赖套件级 `runtime/` 目录。

## 0. 可修改配置区

> 更换子 Skill 名称或接口时，只修改本节及本 Skill 根目录 `skill-registry.json`。

```yaml
child_skills:
  generator:
    skill_name: "power-grid-technical-report-writer"
    actions:
      build_project_profile: "build_project_profile"
      build_argument_architecture: "build_argument_architecture"
      generate_outline: "generate_outline"
      revise_outline: "revise_outline"
      search_references: "search_references"
      prepare_chapter_materials: "prepare_chapter_materials"
      generate_chapter_plan: "generate_chapter_plan"
      revise_chapter_plan: "revise_chapter_plan"
      generate_chapter: "generate_chapter"
      revise_chapter: "revise_chapter"
      generate_abstract: "generate_abstract"
      assemble_report: "assemble_report"
      revise_report: "revise_report"

  reviewer:
    skill_name: "report-reviewer"
    actions:
      review_outline: "review_outline"
      review_chapter: "review_chapter"
      review_report: "review_report"

  formatter:
    skill_name: "tech-report-writer"
    actions:
      create_word_report: "create_word_report"
      format_existing_word_report: "format_existing_word_report"
      validate_word_report: "validate_word_report"
```

统一调用形式：

```yaml
skill_name: "<注册的实际 Skill 名称>"
action: "<注册的实际动作名>"
payload: {}
orchestration:
  enabled: true
  request_id: "唯一编号"
  caller_skill: "report-workflow-orchestrator"
```

默认参数：

```yaml
workflow_config:
  max_outline_revision_rounds: 2
  max_chapter_revision_rounds: 2
  max_report_revision_rounds: 2
  auto_review_outline: true
  auto_review_chapter: true
  auto_review_report: true
  require_user_confirmation_after_review_pass: true
  enable_reference_stage: true
  enable_final_report_review: true
  require_project_intake: true
  require_source_grounded_chapter_briefs_before_outline: true
  mandatory_structured_reviews:
    - outline
    - chapter
    - report

  # 确定性质量门：无需大模型参与
  enforce_chapter_length_gate: true
  minimum_chapter_length_ratio: 0.80
  enforce_outline_title_limit: true
  max_outline_title_chars: 25
  enforce_based_on_heading_ratio_gate: true
  based_on_heading_ratio_min: 0.40
  based_on_heading_ratio_max: 0.60
  enforce_power_domain_heading_gate: true
  enforce_chinese_technology_heading_gate: true
  enforce_level3_task_subject_uniqueness_gate: true
  enforce_level2_subject_power_gate: true
  enforce_non_evaluation_heading_gate: true
  enforce_heading_source_term_gate: true
  enforce_outline_technology_option_gate: true
  outline_technology_option_min: 2
  outline_technology_option_max: 3
  enforce_heading_ending_distribution_gate: true
  heading_technology_ending_target_ratio: 0.40
  heading_method_ending_target_ratio: 0.60
  heading_technology_ending_report_min_ratio: 0.35
  heading_technology_ending_report_max_ratio: 0.45
  normalize_markdown_on_assembly: true
  markdown_dash_style: "hyphen"   # 可改为 "em-dash"
  remove_digit_cjk_spaces: true

  # 摘要内容门禁
  enforce_abstract_quality_gate: true
  require_abstract_opening_candidates: true
  abstract_opening_candidate_min: 3
  abstract_opening_candidate_max: 5
  require_abstract_assessment_result_metadata: true
  abstract_supplementary_metric_max: 2
  require_qualitative_assessment_results: true

  # Word 成品阶段
  enable_word_output: true
  require_word_report_metadata: true
  require_word_structural_validation: true
  require_word_visual_qa: true
  enforce_caption_only_catalog_tc: true
  normalize_catalog_explanation_leads: true
  require_abstract_main_toc_tc: true
  auto_refresh_word_catalog_fields: true
  require_catalog_visual_qa: true
  max_word_format_revision_rounds: 2
```

## 1. 职责

编排器不直接写报告，也不直接完成正式审核。它负责：

1. 保存项目状态、版本、用户确认和审核结果；
2. 在项目档案生成前收集并校验四项固定前置问题；
3. `source_grounded` 模式下，在论证架构确认后、目录生成前收集逐章大概内容；
4. 根据状态选择生成 Skill 或审查 Skill；
5. 生成标准化调用请求；
6. 校验子 Skill 返回结构；
7. 控制“生成—确定性质量门—审核—修改—复审”循环；
8. 目录生成后检查标题长度及可选技术方案完整性，章节生成后检查实际字数，摘要生成后检查三段篇幅、排序词、业务需求首句候选、任务书定量/定性考核结果元数据、补充指标数量和中英双语字段；
9. 达到自动修改上限后停止并交给用户决定；
10. 防止旧版本审核意见被用于新版本；
11. 所有章节确认后生成摘要、组装报告、执行 Markdown 规范化并进行全文审核；全文确认后调用 Word 排版 Skill，完成 DOCX 生成、修复和验收。

## 2. 模式

### 2.1 独立交互模式

用户直接调用生成 Skill 时，由生成 Skill 自身维护严格交互流程。

### 2.2 外部编排模式

本 Skill 调用生成 Skill 时，必须传入 `orchestration.enabled=true`。用户确认由编排器维护，生成 Skill 不再自行请求阶段确认。

调用 v3.6.0 生成 Skill 时，编排器只传递当前动作所需上下文；生成 Skill 必须按 `references/progressive-loading-map.md` 加载对应阶段文件，不得一次性预加载全部规则文件。

## 3. 主状态机

```text
INITIALIZED
→ PROJECT_INTAKE_REQUIRED（固定四问）
→ PROJECT_INTAKE_CONFIRMED
→ PROJECT_PROFILE_DRAFTED
→ PROJECT_PROFILE_CONFIRMED
→ ARGUMENT_ARCHITECTURE_DRAFTED
→ ARGUMENT_ARCHITECTURE_CONFIRMED
→ source_grounded：CHAPTER_CONTENT_BRIEFS_REQUIRED → CHAPTER_CONTENT_BRIEFS_CONFIRMED
→ model_autonomous：CHAPTER_CONTENT_BRIEFS_NOT_REQUIRED
→ OUTLINE_DRAFTED
→ OUTLINE_REVIEWING
→ OUTLINE_REVISION_REQUIRED / OUTLINE_REVIEW_PASSED
→ OUTLINE_CONFIRMED
→ REFERENCE_PLAN_DRAFTED
→ REFERENCE_PLAN_CONFIRMED
→ CHAPTER_MATERIALS_READY
→ CHAPTER_PLAN_DRAFTED
→ CHAPTER_PLAN_CONFIRMED
→ CHAPTER_DRAFTED（立即执行确定性字数门禁）
→ CHAPTER_REVIEWING
→ CHAPTER_REVISION_REQUIRED / CHAPTER_REVIEW_PASSED
→ CHAPTER_CONFIRMED
→ 下一章
→ ABSTRACT_DRAFTED（立即执行摘要确定性门禁）
→ ABSTRACT_REVISION_REQUIRED / ABSTRACT_GATE_PASSED
→ ABSTRACT_CONFIRMED
→ REPORT_ASSEMBLED
→ REPORT_REVIEWING
→ REPORT_REVISION_REQUIRED / REPORT_REVIEW_PASSED
→ COMPLETED
```

若 `content_generation_mode=model_autonomous`，可跳过 `prepare_chapter_materials`。若关闭参考文献阶段，可从目录确认进入章节流程。

## 3.1 项目档案固定前置问卷

在调用 `build_project_profile` 前，编排器必须一次性收集并记录：

1. 有没有任务书；如有，对应具体课题还是任务书总报告；
2. 后续采用 `source_grounded` 还是 `model_autonomous`；
3. 是否有指定报告字数、模板或章节数量；
4. 是否有可提供的实验数据。

四项均允许回答“无”，但不得缺项。未完成时 `next_action` 只能返回：

```yaml
kind: "user_input"
target: "project_intake"
questions: []
```

不得创建 `build_project_profile` 请求。

## 3.2 `source_grounded` 目录前逐章内容说明

`build_argument_architecture` 请求中的 `argument_architecture_requirements` 规定外部交接结构。`source_grounded` 响应必须在 `artifact.content.proposed_chapters` 或 `artifact.content.report_scope_confirmation.chapter_mapping` 提供非空章节对象数组。每行需有非空 `chapter_title` 和 `chapter_type=foundation|technical-research|conclusion`；至少含一个技术章，可选 `chapter_id` 必须唯一，可选 `chapter_no` 必须为唯一正整数。完整章节表中的首章与总结只收集一次；旧顶层技术章映射仍可由编排器补首章和总结，不得把叙述性研究内容当章节对象。

`apply` 和 `confirm` 使用同一章节校验。非法响应拒绝时保留原状态及待处理请求，可更正响应后按原请求再次 `apply`。对于早期版本已经落盘的非法论证架构草稿，运行 `next` 会产生带 `base_artifact`、`revision_instruction` 和结构要求的新 `build_argument_architecture` 请求；重复 `next` 保留同一待处理请求。修订响应必须匹配新请求编号、Skill和动作，`apply`追加新版本并仍等待显式确认；旧请求不可重放。不得直接编辑 `state.json` 或已有artifact版本来通过确认。

论证架构确认后，若模式为 `source_grounded`，编排器必须先返回：

```yaml
kind: "user_input"
target: "chapter_content_briefs"
chapter_targets: []
```

用户需按第一章、各拟定核心技术章和总结章分别提供 `approximate_content`。全部提交后，`generate_outline` 请求才可创建，并必须包含：

```yaml
chapter_content_briefs:
  status: "confirmed"
  targets: []
  items: []
preserve_existing_outline_rules: true
```

该输入只补充用户的逐章内容意图，不得修改生成 Skill 原有目录规则。

## 3.3 强制审核交接

目录、章节和全文的每个新版本必须实际调用 `report-reviewer`。生成 Skill 的前置检查、自检或写作约束检查不构成正式审核。

- `OUTLINE_DRAFTED` 的下一请求只能是 `review_outline`；
- `CHAPTER_DRAFTED` 通过80%字数门禁后的下一请求只能是 `review_chapter`；
- `REPORT_ASSEMBLED` 完成 Markdown 规范化后的下一请求只能是 `review_report`；
- 审核结果必须为结构化响应并绑定当前 `artifact_id + version`；
- 没有当前版本的结构化 `pass` 结果，不允许用户确认；
- 禁止从 `REPORT_ASSEMBLED` 直接进入 `COMPLETED`。

## 4. 用户确认门

以下产物必须显式确认：

- 项目档案；
- 中心主旨与论证架构；
- 审核通过后的目录；
- 参考文献与研究现状组织方案；
- 每章计划；
- 审核通过后的每章正文；
- 摘要与关键词；
- 全文审核通过后的完整报告；
- 结构校验和逐页视觉验收通过后的 Word 成品。

审核通过不等于用户确认。用户确认后才能进入下一阶段。反过来，用户确认也不能替代审核：目录、章节和全文必须先取得当前版本的结构化 `pass` 结果。

### 4.1 用户退回修订

用户在待确认点明确要求修改时，使用 `scripts/workflow_cli.py request-revision` 或 `workflow_engine.request_revision`，固定当前目标、`artifact_id`、基线版本、用户请求编号和非空反馈。完整参数、支持矩阵、幂等规则与历史文件要求见 [用户退回修订](references/user-revision.md)。不得把模型自检当成用户反馈，不得自行确认；调用方负责取得真实用户指令。

当前未确认章节因字数、章首过渡、小结或正式章节审核的修订上限耗尽而进入 `AWAITING_USER` 时，也可凭明确的新用户反馈使用同一入口。必须匹配当前章节、最新版本与对应失败审核；每条反馈只允许一个新修订子请求，保留失败计数和历史。新版本仍失败则继续等待另一条新用户反馈，不自动重试；其他阻塞理由和 `FAILED` 不支持此恢复。

用户反馈单独记录在可选 `user_revision_requests`，不写入正式 `reviews`。随后运行 `next`，执行真实生成器修订动作，以新文件和新版本 `apply`。目录、章节、全文继续通过既有确定性门及绑定新版本的 `report-reviewer` 审核，等待用户显式确认；旧 `pass` 保留且不能确认新版本。已确认目标不可从此入口重开，Word 成品暂不支持用户退回；其结构或视觉校验失败仍沿现有 formatter 修复路径处理。

### 4.2 参考计划文件证据核验

新的 `search_references` 请求固定 `payload.reference_evidence_contract: 2`。响应的 `reference_plan.content` 直接使用生成器的 `internet_access/items`，apply 通过后在产物顶层记录代际；模型省略字段不能降级为旧接口。显式本地来源必须在调用方已授权的 `--source-root` 下核对实际普通文件，apply 和用户 confirm 各核验一次；根目录不能来自模型产物或当前目录，失败不保存状态或清除 pending。匹配只证明本地字节，正式审核与用户确认仍独立执行。接口、旧非本地分支及最终 Markdown 边界见 [参考计划证据接口](references/reference-evidence.md)。

## 5. 自动审核循环

目录、章节和全文均强制执行，不能被普通配置或生成 Skill 自检跳过：

```text
生成新版本
→ 审核当前版本
→ pass：等待用户确认
→ minor/major/revise：在轮次上限内调用对应修改动作
→ 修改为新版本
→ 重新审核
→ 超过上限：进入 awaiting_user
→ blocked：请求缺失材料或决策
```

修改结果必须产生新版本，审核结果必须记录 `reviewed_version`。

## 6. 章节流程

每章依次执行：

1. 根据生成依据模式判断是否准备材料；
2. 调用 `generate_chapter_plan`；
3. 用户确认计划；
4. 调用 `generate_chapter`；
5. 使用确定性脚本统计章节有效字数；普通章节实际字数不得低于已确认计划字数的80%；最终总结章为专属例外，必须严格位于700—800字；
6. 字数不足时跳过审查 Skill，直接调用 `revise_chapter` 定向补写并重新统计；
7. 字数门禁通过后调用 `review_chapter`；
8. 必要时调用 `revise_chapter` 并复审，修改稿仍须重新通过字数门禁；
9. 审核通过后等待用户确认，确认时再次核对字数门禁；
10. 保存确认版本和摘要证据；
11. 进入下一章。

不得把未确认章节作为正式上下文。生成后续章节时优先传递已确认章节摘要，只有强依赖时才传递相关正文片段。


## 6.1 确定性字数门禁

章节计划与目录中的 `target_words` 是确认后的篇幅基准。生成或修改章节后，编排器调用确定性统计逻辑，不依赖大模型判断：

```text
最低有效字数 = ceil(计划字数 × 0.80)

**最终总结章专属篇幅门禁**：若当前章为最后一章“总结”“总结与展望”或“结论”，不使用上述80%公式；其正文有效字数必须为700—800字，并且只能保留一个一级标题。
```

有效字数按“中文字符逐字计数，连续英文或数字记为一个词”统计，并排除 Markdown 控制符、URL、HTML 注释和围栏代码块。

处理规则：

- 未找到已确认目标字数：停止流程并要求补齐计划字数；
- 普通章节实际字数低于80%：生成 `insufficient_length` 确定性问题，进入 `CHAPTER_REVISION_REQUIRED`；达到80%才允许进入内容审查；
- 最终总结章（总结/总结与展望/结论）：必须700—800字；低于700或高于800均进入 `CHAPTER_REVISION_REQUIRED`，且该章不得有任何二三级标题；
- 用户确认章节时必须再次检查 `length_gate_passed=true`；
- 不得用重复背景、重复定义、重复小结或空泛展望填充篇幅。

### 目录可选技术方案门禁

目录的确定性门禁同时读取 `technology_option_sets`：技术路线未由来源唯一锁定的技术研究核心二级节必须有2—3个候选，且只有1个推荐项；来源已唯一锁定时允许只有1个 `source_confirmed` 候选。候选必须带中文技术签名、1—3个关键机制和适配理由，并保持当前一级标题/章节边界。候选块是目录伴随信息，不编号、不进入正式目录。

## 6.2 摘要确定性门禁

所有主体章节确认后调用 `generate_abstract`。该动作必须在同一个产物中返回：

```text
abstract_cn
keywords_cn
abstract_en
keywords_en
opening_sentence_candidates_cn   # 3—5个业务需求背景首句候选
selected_opening_sentence_cn    # 当前选中/推荐首句，必须成为中文摘要第一完整句
assessment_result_coverage      # 任务书考核结果，含quantitative/qualitative/mixed
supplementary_metrics_used      # 非任务书补充指标，最多2个
```

编排器随后执行确定性摘要门禁，不依赖大模型自行判断字数：

- 中文摘要恰好3个自然段；
- 中文摘要正文总有效字数700—800字；
- 第一段200—250字；
- 第二段300—350字；
- 第三段不设置独立范围，只需使总摘要达到700—800字并完成结果、结论与前景；
- 第一段必须使用明确顺序词排序关键挑战；
- 第二段必须使用明确顺序词按对应顺序介绍技术点；
- `abstract_en` 和 `keywords_en` 必须与中文版本同次生成且非空；英文摘要恰好三个自然段，段间留空行，单段内换行不算分段。该门只检查结构，翻译内容逐段忠实对应仍由语义审核负责。
- 先生成3—5个彼此角度不同的业务需求背景分析首句候选，候选只写电力业务对象/场景、现实痛点/能力缺口或目标业务能力，不提前写方法、指标和结果；`selected_opening_sentence_cn` 必须来自候选，并实际成为 `abstract_cn` 第一完整句；
- 存在任务书时，第三段以任务书考核结果为主要指标来源，`assessment_result_coverage` 必须区分 `quantitative|qualitative|mixed`；定性考核事项必须写形成的能力、功能、成果状态、适用性或工程效果，不能只复述要求；
- 非任务书指标默认不写，确有补充价值时 `supplementary_metrics_used` 最多2项；无任务书时也只选1—2个最有代表性的可靠结果指标。

允许的顺序词包括“第一、第二、第三”以及“首先、其次、再次”等同类表达。该用法是摘要专属结构要求，不得被审核 Skill 作为 `mechanical_enumeration`。

门禁失败时进入 `ABSTRACT_REVISION_REQUIRED`，再次调用 `generate_abstract` 定向修复；修复不得改变摘要证据中的事实、数值和结论。门禁通过后才允许用户确认摘要。

## 6.3 目录标题门禁

目录中的一级、二级和三级标题原则上不超过25个可见字符。对普通标题，超过上限时必须缩短，除非标题条目显式设置例外。对技术研究章二、三级技术标题，优先级固定为“电力领域语义显化 + 具体技术签名显化 > 40%—60%的‘基于……的……’句式比例 > 25字符原则”：若缩短会删除电力领域词或关键技术签名、把标题降级成任务动作，或使本章/全文该句式比例低于40%，则不得仅为长度门禁强制改写，可保留较长标题并记录理由。

```yaml
allow_long_title: true
title_length_rationale: "确有必要保留的理由"
```

先读取 `report_theme_type`。若为 `non-evaluation`，二、三级标题不得出现验证、评估、评价、测评、验收、测试、试验、实验类章节词，考核与证据要求只能转写为性能、边界、精度、时延、可靠性、工况适应性、集成能力等技术语义并融入X.1—X.N。若为 `evaluation-related`，确属评估研究结构的“数据集、实验设置、评价指标、结果分析”等功能标题可简洁命名。

技术研究章还执行二级标题主语电力语义门禁：对“基于……的……”标题，以“的”之后完整部分为主语；该主语本身必须包含强电力相关词，不能只靠前置技术或上位标题补足。直接复合二级标题去除 `technical_signature` 后的任务主语同样必须具有强电力语义。

目录同时执行任务书关键技术词覆盖门禁：预期目标、进度计划和考核要求中的关键技术词按 `heading_source_term_plan` 分配，概括性词进入二级标题，窄技术点进入三级标题，并在不破坏X.1—X.N逻辑链的前提下分散覆盖。技术研究章二、三级标题最终只以“技术/方法”收束，每章按约40%技术、60%方法规划，全文技术结尾35%—45%。

技术研究章还执行三级标题任务主语唯一性门禁：同一章所有 `heading_kind=technical` 的三级标题，在去除各自 `technical_signature` 后承担的电力任务主语必须互不重复。对“基于……的……”标题，直接比较“的”之后的完整部分；即使前面的具体技术不同，只要后半段仍是同一个“电网故障处置建议生成方法”等任务，也必须退回重拆。该门禁与电力领域语义、中文技术签名和40%—60%“基于……的……”比例同时成立，不能通过牺牲其中任何一项解决重复。

## 7. 审核结果路由

### 7.1 目录

- `pass`：标记 `OUTLINE_REVIEW_PASSED`，等待用户确认；
- `minor_revision` / `major_revision`：调用 `revise_outline`；
- `blocked`：记录缺口并等待用户补充。

### 7.2 章节

- `pass`：标记 `CHAPTER_REVIEW_PASSED`；
- `minor_revision` / `major_revision`：调用 `revise_chapter`；
- `blocked`：停止自动处理。

### 7.3 全文

- `pass`：标记 `REPORT_REVIEW_PASSED`；`REPORT_ASSEMBLED` 状态不得直接确认；
- `revise`：调用 `revise_report`，随后重新审核；
- `blocked`：记录全文级缺口。


## 7.4 最终 Markdown 确定性规范化

`assemble_report` 或 `revise_report` 返回完整 Markdown 后，编排器在全文审核前调用：

```bash
python scripts/normalize_markdown.py final-report.md --in-place --dash-style hyphen
```

默认动作：

- 将 Unicode 长划线 `—`、`–`、`―`、`‒` 统一为 ASCII `-`；
- 删除数字与相邻汉字之间的横向空格，例如 `220 kV 电网` 中数字与汉字直接相邻的部分；
- 围栏代码块和行内代码保持不变；
- ATX标题的层级标记、章/节编号和编号后的分隔空格保持不变；标题正文继续执行原清洗规则，供标题覆盖校验与Word源文件解析读取；
- 独立图/表题和图片alt题注的编号与正式题名之间保留分隔空格；题名内部继续执行原清洗规则，供Word题注和目录识别；
- 该步骤只做字符级规范化，不调用大模型，不改写报告语义。

如项目规范要求保留中文长划线，将 `markdown_dash_style` 改为 `em-dash`。

## 8. 统一状态字段

```yaml
workflow_state:
  schema_version: "1.0"
  project_id: ""
  stage: "INITIALIZED"
  report_context: {}
  content_generation_mode: "pending_selection"
  current_chapter_id: null
  artifacts: {}
  chapters: {}
  revision_counters:
    outline: 0
    report: 0
    chapters: {}
  confirmations: {}
  pending_action: null
  last_request_id: null
  last_error: null
```

运行时状态的完整结构由 `schemas/workflow-state.schema.json` 定义。

`workflow_cli.py` 在当前获授权项目内保存状态：同目录私有临时文件写入后先同步文件，再原子替换目标并同步目录，全部成功后才输出阶段成功。替换前失败保留原状态；替换后目录同步失败会明确报错“实际文件可能已更新，提交未确认”。此时先用 `status` 读回实际状态，核对 `pending_action`、版本和历史，再决定继续；不得自动重放阶段动作，也不得恢复旧文件来伪装动作未生效。

## 9. 子 Skill 输出校验

生成 Skill 成功输出至少包含：

```yaml
request_id: ""
skill_name: "power-grid-technical-report-writer"
action: ""
status: "success"
artifact:
  artifact_type: ""
  artifact_id: ""
  version: 1
  content: {}
```

审查 Skill 成功输出至少包含：

```yaml
request_id: ""
skill_name: "report-reviewer"
action: ""
status: "success"
review_result:
  decision: ""
  overall_score: 0
  issues: []
  must_fix: []
  revision_instruction: ""
```

无效输出不得推进状态。允许重新请求一次；再次失败后进入 `FAILED` 或 `AWAITING_USER`。

## 10. 用户指令路由

- `继续`：执行当前状态的下一合法动作；
- `确认`：确认当前待确认产物；
- `查看进度`：输出阶段、当前章、已确认章节、待处理问题和下一动作；
- `按审核意见修改`：使用当前版本对应的最新审核结果调用修改动作；
- `重新审核`：重新审核当前版本，并标明原因；
- `接受当前版本`：记录 `approval_source=user_override`；
- `回到第X章`：切换当前章但不删除其他状态；
- `全文审核`：仅在报告已组装后执行。

## 11. 强制约束

1. 子 Skill 名称和动作不得散落硬编码；
2. 编排器不得直接生成章节正文；
3. 编排器不得直接给出正式审核结论；
4. 未审核通过的章节不得自动确认；
5. 修改后必须重新审核；
6. 自动修改次数不得无限增长；
7. 用户修改前序决策时，应标记受影响的后续产物为 stale，不得静默沿用；
8. 任何审核必须绑定具体版本；
9. 所有请求和响应均应保存，便于追踪；
10. 实际代码状态机以 `scripts/workflow_engine.py` 为准。


## 10. Word 成品阶段

全文审核通过并由用户确认后，编排器不得直接结束任务，应进入 Word 成品阶段。

### 10.1 封面与报告元数据

调用 `create_word_report` 前必须补齐：报告编号、分类号、密级、项目来源、中英文标题、项目名称、系列编号、合作单位、报告日期、工作起止时间、负责人、参加人员和编写人。能够从项目档案确定的字段可预填；报告编号、分类号和密级必须由用户明确确认。

### 10.2 生成与修复

```text
最终 Markdown 报告确认
→ formatter 对 Markdown/HTML 公式做确定性归一化并转为 Word 原生 OMML
→ formatter.create_word_report
→ formatter.validate_word_report
→ pass：等待用户确认 Word 成品
→ revise：formatter.format_existing_word_report
→ 再次 formatter.validate_word_report
```

每次格式修复必须另存为新版本，不得覆盖上一版，也不得修改专业内容。Markdown 的 `$...$` / `$$...$$` / `\(...\)` / `\[...\]` 等 LaTeX 输入格式只允许存在于 Word 生成前；进入 DOCX 后必须转换为原生 OMML。图/表目录只允许真正的图题、表题写入隐藏 `TC \f F` / `TC \f T`；形如“图1-1应表达……”或“表2-1给出……”的说明段须先改写为“该图应表达……”“该表给出……”“上述趋势……”等非图题句式。`内容摘要` 与 `ABSTRACT` 必须恢复主目录隐藏 `TC \f C`。最终保存后在 Microsoft Word 可用时自动更新主目录、图目录和表目录并保存缓存结果。

### 10.3 强制验收

`validate_word_report` 的 `pass` 必须同时满足：

- DOCX 结构校验通过，且正文/表格可见文本中没有残留原始 LaTeX 公式或内部公式标记；
- 已成功渲染 PDF 与逐页 PNG；
- 当前 Word `artifact_id + version` 的每一页均有视觉检查记录：`page_count` 为正整数，`inspected_pages` 只能包含整数页码且恰好覆盖 `1..page_count`，不允许缺页、重复、越界或布尔值；
- 主目录、图目录和表目录区域不得出现“未找到目录项”等错误文本；存在真正图题/表题时，对应图条目/表条目必须在更新后的目录中可见；
- 封面、审批页、摘要、目录、正文、附录、参考文献、页眉页脚和页码无阻断问题。

渲染退出 0 不代表视觉验收通过。仅运行 Python 校验器、仅生成 DOCX 或仅抽查部分页面均不能完成流程。
