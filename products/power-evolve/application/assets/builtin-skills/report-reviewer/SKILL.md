---
name: report-reviewer
description: 审核报告目录、单章和全文，检查任务完成度、内容完整性、逻辑结构、证据引用、章节协同、术语一致性和中文长文表达，输出结构化审核结论。本 Skill 不直接重写正文。
version: 1.1.1
---

# Report Reviewer

## 0. 接口配置区

```yaml
skill_name: "report-reviewer"
actions:
  review_outline: "review_outline"
  review_chapter: "review_chapter"
  review_report: "review_report"
```

统一输入：

```yaml
orchestration:
  enabled: true
  request_id: "唯一编号"
  caller_skill: "report-workflow-orchestrator"
action: "review_outline | review_chapter | review_report"
payload: {}
```

统一输出：

```yaml
request_id: ""
skill_name: "report-reviewer"
action: ""
status: "success | blocked | failed"
review_result:
  reviewed_artifact_id: ""
  reviewed_version: 1
  decision: "pass | minor_revision | major_revision | revise | blocked"
  overall_score: 0
  score_breakdown: {}
  strengths: []
  issues: []
  must_fix: []
  optional_improvements: []
  revision_instruction: ""
error: null
```

## 1. 职责边界

负责审核目录、章节和全文；定位问题、说明原因、确定严重程度并给出可执行修改要求。不直接生成目录，不输出完整重写稿，不代替生成 Skill 修改正文。

## 2. 审核顺序

```text
报告或章节任务完成度
→ 内容完整性
→ 逻辑成立性
→ 结构合理性
→ 证据与引用
→ 中文长文表达
→ 全文一致性（仅全文审核）
```

内容和逻辑问题优先于局部措辞问题。

## 3. 结论与严重度

```yaml
decisions:
  pass: "无 critical/major 问题，仅有可选建议"
  minor_revision: "主体成立，存在局部可修正问题"
  major_revision: "目标未完成、关键内容缺失或核心逻辑不成立"
  revise: "全文需要定向修改"
  blocked: "缺少完成审核所必需的输入"

severity:
  critical: "影响报告核心结论或整体任务完成"
  major: "影响章节完整性、论证成立或结构合理性"
  minor: "影响清晰度、准确表达或阅读体验"
  suggestion: "可选优化，不影响审核通过"
```

建议阈值：

- `pass`：总分不低于 85，critical=0，major=0；
- `minor_revision`：总分不低于 75，critical=0，major 不超过 1；
- 其他情况通常为 `major_revision` 或全文 `revise`。

分数不能覆盖问题实质；出现关键缺失时不得仅靠平均分判定通过。

## 4. 问题输出协议

每个正式问题必须包含：

```yaml
issue_id: "LOGIC-001"
severity: "major"
dimension: "逻辑连贯性"
type: "logic_gap"
location:
  chapter_id: "chapter_3"
  section: "3.2"
  paragraph: 4
  sentence_excerpt: ""
problem: "当前问题"
reason: "为什么影响报告质量"
revision_requirement: "明确修改动作"
expected_result: "修改后的可验收状态"
rewrite_required: true
source_required: false
```

禁止只写“进一步优化”“适当丰富”“增强逻辑”等不可执行意见。

## 5. 目录审核

### 5.1 目标覆盖

检查目录是否覆盖完成报告目标所需的主要问题，是否遗漏关键研究内容、验证环节、结果分析或结论。

### 5.2 章节划分

检查：

- 一个章节是否承担过多任务；
- 同一主题是否被拆散；
- 上位概念与下位概念是否并列；
- 章节粒度是否差异失控；
- 相邻章节是否边界重叠。

### 5.3 顺序和依赖

检查：

- 结论是否先于论据；
- 实现细节是否先于方案定义；
- 评价结果是否缺少评价方法；
- 对策是否缺少问题分析；
- 后文是否使用尚未定义的概念。

### 5.4 篇幅分配

判断重点章节是否获得足够篇幅，背景、方案、实现、验证和结论的比例是否符合报告目标。不得机械平均。

### 5.5 标题长度与功能标题

检查一级、二级和三级标题是否原则上控制在25个可见字符以内。普通标题超过25个字符且没有 `allow_long_title=true` 与具体例外理由时，可标记为 `heading_too_long`。但技术研究章二、三级标题必须遵循“电力领域语义显化 + 技术签名显化 > 40%—60%‘基于……的……’句式比例 > 25字符原则”：若较长标题是同时保留电力领域语义、具体技术签名或满足比例所必需，不得仅因超过25字符判为必须修改。

审核前先读取 `report_theme_type`。`non-evaluation` 主题的二、三级标题出现“验证、评估、评价、测评、验收、测试、试验、实验”等章节词时，标记 `non_evaluation_heading_policy_violation`；不得因存在考核指标、验收要求或实验数据而放宽。只有 `evaluation-related` 主题中确属评估研究结构的“数据集、实验设置、评价指标、结果分析”等功能标题可简洁命名。

对技术章X.1—X.N全部核心二级标题及其技术类三级标题，审核时必须同时检查电力领域语义显化、技术显化、中文技术表达和承接链。每个标题都必须独立体现可识别的电力对象/业务/运行约束、**细化到具体模型/算法变体或关键机制组合层级的中文语义技术签名**以及技术作用。人工智能、机器学习、深度学习、RAG、图神经网络/GNN、Transformer、强化学习、大模型、知识图谱等上位概念或技术族名称本身不算创新技术；同时，Span抽取、双塔匹配、实体边界识别、关系类型判别、候选生成、术语对齐、置信校准、样本重加权、参数更新等也只是任务/操作标签，不能单独充当技术创新点。正式二、三级目录标题不得直接裸露 GlobalPointer、RoBERTa、GraphSAGE、HGT、CLIP、LoRA、PPO、RAG 等英文模型名或英文缩写，应转换为简洁、能看出实际技术路线的中文表达；原英文名可以保留在内部元数据或正文首次定义中。中文化不能机械展开成长难全称，也不能把具体模型泛化为“智能模型、深度模型、优化算法”。若标题缺少能够区分实现路线的具体技术签名，标记 `technology_signature_not_visible` 或 `operation_level_heading`；若仍是“基于RAG的……”“基于图神经网络的……”等族级写法，标记 `technology_family_too_broad`；若技术标题仍裸露英文技术名/缩写，标记 `english_technology_in_heading`。

**三级技术标题不得继承上位标题的具体性。** 即使二级标题已经写出某一细粒度技术，三级标题仍必须独立显化当前步骤采用的具体模型/算法变体、关键机制、约束或组合方式，不能退化成“实体边界识别方法”“样本重加权方法”“参数更新方法”“置信校准方法”。“基于具体技术签名的……”实行40%—60%双向硬门禁：审核时应检查每个技术研究章及全文二、三级技术标题中的使用比例，低于40%或高于60%都应判定需要修改；无论是否使用“基于”，每个标题都必须同时让电力领域语义和具体技术签名直接可见。“基于……”不得成为省略电力对象/约束的理由。标题长度不得作为删除技术签名或破坏40%—60%比例的理由。 比例超出区间时使用 `based_on_heading_ratio_out_of_range`，不得仅给建议级提示。全部核心二级标题还必须共同回答同一个一级章核心问题，并存在可说明的先后承接关系，不能只是三个互不依赖的技术名词并列。

**技术章每个实质二级标题的主语必须独立具有电力语义（仅“本章小结”除外）。** 对“基于{技术签名}的{任务主语}”标题，“的”之后完整部分就是主语；若主语自身没有电网、调度、配电、线路、机组、储能、负荷、电压、功率、运检等强电力词，标记 `level2_subject_power_signal_missing`。直接复合二级标题去除技术签名后也按同样原则检查。

**预期目标、进度计划和考核要求的关键技术词必须可追溯到标题。** 检查 `heading_source_term_plan` 是否把概括性技术词落到二级标题、窄技术点落到三级标题，并在不破坏X.1—X.N逻辑链的前提下分散覆盖；遗漏使用 `heading_source_term_coverage_missing`。非评估主题不得把来源中的“验证/测试/验收”字面搬进目录。

**目录生成必须同步提供可选技术方案，但候选不属于正式目录。** 检查 `technology_option_sets`：来源未唯一锁定技术路线的每个核心二级研究点应有2—3个围绕同一研究问题、同一技术作用和同一章节边界的候选，且只有1个推荐项；候选之间必须具有真实路线差异，不能只是模型名/同义词替换。来源已明确唯一技术路线时允许 `source_locked=true` 且只保留1个 `source_confirmed` 候选，不得为了凑选项虚构替代路线。正式目录标题只采用当前推荐/确认的一项，候选块应不编号、不进入Word目录。缺失或数量/来源状态不合规标记 `technology_option_plan_missing_or_invalid`；候选把后续章节方法或本章主线之外技术引入当前章时标记 `technology_option_scope_mismatch`。

**技术研究章二、三级标题结尾按约40%“技术”、60%“方法”分布。** 二三级技术标题不得以“模型/算法”结尾；每章“技术”结尾数量取最接近40%的整数，全文技术结尾比例35%—45%，不符使用 `heading_ending_distribution_mismatch`。该比例与“基于……的……”40%—60%句式比例分别审核。

**技术章二级标题必须与一级标题形成直接父子研究逻辑并隔离后续章节。** 审核时先抽取一级标题的核心研究对象、核心问题和预期输出，再逐项判断X.i是否为完成该主线所必需的直接子问题、关键步骤或核心输出。不要按“数据处理、模型训练、参数优化、系统实现、性能分析、应用分析”等词做黑名单判断；这些词本身不是问题。若标题虽然与整个项目或电力业务相关，但其核心任务切换到本章主线之外、与相邻/后续章节更匹配，标记 `chapter_parent_logic_mismatch`。若标题或正文提前展开后续技术章的核心方法、独立实验、工程应用或结论，标记 `future_chapter_scope_leak`。可以简短说明当前产物将作为后续输入，但不得提前承担后续章职责。

**核心标题数量默认3个，必要时才最小扩展。** 4—5个核心二级标题仅在 `core_section_expansion_reason` 能明确追溯到无法合理归并的预期目标/进度技术点时允许；无理由扩展或为目录完整而扩展，标记 `unnecessary_core_heading_expansion`。单个核心二级节三级标题默认2—4个，扩到5个也必须有来源化理由。

**本章小结正文默认少用引号。** 若正文用“”“”、英文引号、书名号大量包裹技术词、概念名、方法名、结论短语或所谓“亮点”，而并非必须保持的原文名称、标准条款或直接引用，标记 `chapter_summary_unnecessary_quotes`，优先改为直接陈述。该规则针对小结正文，不新增目录标题引号限制。

**实验与小结指标数量受控。** 一个实验可展示多个指标，但结果分析正文最多重点解释2个；超过2个逐项展开时标记 `experiment_metric_analysis_overload`。本章小结对每个核心二级研究点最多总结1个代表性效果指标，无实验时不强写指标；堆叠多个指标标记 `chapter_summary_metric_overload`。任务书硬指标统一由最后一个技术章节集中承接，优先融合原实验位置；能融合却另设总体实验标题，或前序技术章提前集中写任务书硬指标，标记 `hard_indicator_allocation_violation`。最后技术章小结应写实际结果与技术效果，不复述“超过/不低于/小于某阈值”“达到考核指标”等验收口吻。

**同一章所有技术类三级标题的任务主语必须互不重复。** 对“基于{技术签名}的{任务主语}”标题，审核时直接比较“的”之后的完整任务主语；对直接复合标题，则比较去除可见技术签名后剩余的电力对象/业务与技术作用。不同算法不能用来掩盖相同职责，例如“基于技术A的电网故障处置建议生成方法”和“基于技术B的电网故障处置建议生成技术”仍属于重复。若只是改换“方法/技术/模型/算法”或做轻微措辞变化但本质任务相同，标记 `duplicate_level3_task_subject`，要求重新拆分为不同处理对象、步骤、输出或职责。确定性门禁负责明显重复，Reviewer 还要识别语义近义改写造成的职责重复。

还必须检查“核心技术主语是否得到整体展开”：生成 Skill 会为每个研究内容登记 `primary_technical_subject`。X.1—X.N至少一节应直接以该主语为核心，从总体目标、输入输出、整体原理/架构、关键组成、处理流程、约束和边界进行完整阐述，而不是只在标题或开头一句提到主语，随后全部转为若干子算法。若主体技术只被碎片化分散在多个小节、没有任何二级节整体说明，标记 `primary_technical_subject_underdeveloped`，通常为 major。章节计划中主体技术整体展开节原则上应获得X.1—X.N正文计划字数的至少25%；有明确例外理由时按内容完整性判断，不机械按比例否定。

目录评分维度：目标覆盖 25、章节结构 25、顺序逻辑 20、边界清晰 15、篇幅分配 15。

## 6. 章节审核

### 6.0 字数门禁前置条件

编排器应在调用本 Skill 前提供：

```yaml
length_requirement:
  planned_target_words: 10000
  minimum_ratio: 0.80
  minimum_required_words: 8000
length_metrics:
  actual_words: 8500
  length_gate_passed: true
```

若 `length_gate_passed=false`，不得继续进行常规内容审核，应返回 `major_revision`，问题类型为 `insufficient_length`。若缺少计划字数或统计结果，应返回 `blocked`，要求先完成确定性字数校验。字数门禁由代码统计，不由本 Skill 主观估算。

### 6.1 章节目标完成度

根据章节标题、目的、关键点和全文位置检查：

- 是否回答规定问题；
- 必须覆盖的内容是否出现；
- 标题与正文是否一致；
- 是否只讨论相关内容却没有完成章节任务。

章节目标未完成至少判定为 major。

### 6.2 内容完整性

按章节类型检查必要组成，但不要求机械套模板：

- 背景类：现状、问题、影响、目标；
- 方案类：目标、总体思路、组成、职责、关系、条件；
- 方法类：输入、过程、关键方法、输出、评价方式；
- 实验类：目标、对象、设置、指标、结果、解释；

实验材料不足时，生成 Skill 允许并应按需要输出 `model_generated_reference` 实验包，并可将其中内部标记为 `simulated_reference`、`illustrative_example` 或 `expected_range` 的数据写入报告草稿，包括候选数据集、实验设置、对比方法、对比/消融/敏感性/鲁棒性方案、模拟数据和结果分析。**正式报告正文不要求在每个实验标题、表题、数值或结果句中反复写“参考/模拟”。**只要当前章实际使用了模型生成的模拟数据，在整章最末尾统一出现一次模拟数据说明即可；审核时应把该章末说明与结构化来源状态合并判断，不得因为正文没有逐项标签就判为虚构或证据不足。摘要中的量化成果继续按摘要规则审核。技术章“本章小结”按生成 Skill 的 `chapter-summary.md` 审核：第二段应把普通对比、消融、鲁棒性等实验结果与X.1—X.N具体方法绑定说明，并且每个核心二级研究点在小结中最多选择1个代表性效果指标；第三段只有在最后技术章才集中自然覆盖任务书硬指标对应结果，写清方法、效果以及相较传统方法或基线的优越性，不得要求显式写“指标/目标/考核”。
- 分析类：现象、证据、原因、影响、判断；
- 建议类：问题、原因、措施、主体、条件、预期结果。

### 6.3 逻辑关系

检查因果、递进、并列、转折和条件关系：

- 相关关系是否被写成因果；
- 结论是否超出论据；
- 分类项是否属于同一层级；
- 表面递进是否只是换词重复；
- 特殊场景是否被概括为一般规律；
- 结论成立条件是否明确。

### 6.3a 一级标题与首个二级标题之间的过渡正文

只要当前章存在二级标题，一级标题后不得立即出现首个二级标题。审核时读取上游 `heading_bridge_requirement` 与 `heading_bridge_metrics`：

- 第一章及一般非技术章节：一级标题后应先有50—100字无标题过渡正文；
- 技术章节：继续执行既有长章首导入规则，不得为了本规则压缩成50—100字，也不得额外叠加一段重复短引言；
- 最终总结章没有二级标题，本规则不适用。

过渡正文必须概括本章总体问题和内容关系，不得只复述“本章分为三节”或逐条重复目录。若一级标题与二级标题直接相邻，或一般非技术章节的短过渡明显不在50—100字范围内，标记 `heading_transition_missing`；确定性门禁已经给出有效 metrics 时，以门禁结果为准，不要重新估算字数。

### 6.4 段落和标题

检查：

- 每段是否围绕主要信息点；
- 一段是否混入多个独立主题；
- 是否只有结论没有说明；
- 是否只有材料堆积没有判断；
- 标题承诺的内容是否出现；
- 小标题是否宽泛或重复。

章节评分维度：目标完成 20、内容完整 15、逻辑 20、结构 15、证据 15、中文长文 15。

## 7. 证据与引用审核

### 7.1 结论支撑

检查：

- 定量结论是否有数据；
- 比较结论是否有比较对象；
- 趋势判断是否有时间范围；
- 效果判断是否有评价指标；
- 原因判断是否有分析过程；
- 建议是否回应前文问题。

### 7.2 无源引用

识别“研究表明、数据显示、业内普遍认为、实践证明、专家指出、已有研究发现”等权威性引导。若没有作者、机构、题名、年份、引用编号或可核对来源，标记 `unsourced_claim`。

不能只删除引导语后保留仍依赖该来源的结论。报告场景默认要求补充来源，无法补充时删除对应权威性论断。

### 7.3 数据上下文

用于支撑核心结论的数据应根据用途说明指标、对象、时间范围、样本范围、统计口径、比较基线和来源。关键口径缺失通常为 major。

### 7.4 案例泛化

检查单个案例、特殊工况或局部样本是否被泛化为普遍结论，案例和结论之间是否缺少解释。

### 7.5 引用一致性

全文检查正文引用与参考文献双向对应、同一来源名称一致、编号连续、同一数据在不同章节不冲突。

### 7.6 GB/T 7714—2015 著录一致性

全文参考文献统一按 **GB/T 7714—2015 顺序编码制**审核：

- 文后参考文献按正文首次引用顺序使用 `[1]`、`[2]`……连续编号；
- 正文引用序号与文后条目双向对应；
- 每条正式文献具有与来源类型一致的文献类型标识，如 `[J]`、`[M]`、`[C]`、`[D]`、`[R]`、`[S]`、`[P]`、`[EB/OL]`、`[DB/OL]`；
- 作者、题名、出版项、年份、卷期页码、发布日期/引用日期、DOI 或 URL 等著录项目按来源类型组织；
- 正式条目不得混用 APA、MLA、Chicago 或其他文后样式；
- 条目不能为了补齐格式而编造作者、出版地、页码、日期、DOI、URL 等信息。

单条局部格式问题通常标记 `reference_format_noncompliance`（minor）；大量条目系统性不符合 GB/T 7714—2015、导致正式报告参考文献体系不合格时标记 major。

## 8. 中文长文表达审核

本模块按语义和密度判断，不能仅凭单个词出现一次判错。

### 8.1 抽象表达缺少落点

识别“能力建设、价值释放、体系完善、机制优化、全面提升、强化支撑、形成闭环”等表达。只有在上下文没有说明具体对象、过程、变化或结果，且抽象表达成为主要内容时，标记 `abstract_shell`。

### 8.2 虚假主语和空泛作用关系

“平台赋能、机制助力、体系驱动、方案释放、能力推动”等若没有明确过程、对象或结果，标记 `false_agency`。系统触发告警、模型生成结果、网关返回错误码等真实系统行为不属于问题。

### 8.3 价值拔高骨架

识别“这不仅是……更是……”“真正的……不是……而是……”“最后比拼的是……”等结构。仅在后半句没有新增内容、普通工作被抬高为宏观变革或结论超出正文范围时，标记 `value_inflation`。

### 8.4 二元对比制造虚假逻辑

检查“不是 X，而是 Y”“与其 X，不如 Y”等结构中的 X、Y 是否真的互斥。若实际为并列、主次或递进关系，标记 `false_binary`。

### 8.5 机械化列举

“首先、其次、最后”“一是、二是、三是”等本身不是问题。为凑数量拆分、分项层级不一致、内容高度重复或全文反复使用相同三段式时，标记 `mechanical_enumeration`。**摘要专属豁免：**当中文摘要第一段使用“第一、第二、第三”或“首先、其次、再次”等顺序词排列关键挑战，并在第二段按相同对应顺序排列技术点时，这是生成 Skill 的明确结构要求，不得标记为 `mechanical_enumeration`；只有顺序与实际内容不对应、为了凑数量虚构层级或在摘要之外无必要重复时才可标记。

### 8.6 对称填充

“既要……又要……”“不仅要……还要……”若只是为了对称增加空泛内容、掩盖优先级或连续堆叠，标记 `symmetry_padding`。

### 8.7 空总结

“综上所述、总体来看、由此可见、归根结底、本质上”等后面的句子若只重复上文、不增加结论、决策、推论或转场，标记 `empty_summary`。有信息增量的章节结论可保留。

### 8.8 旁白式表达

“值得注意的是、更重要的是、我们不难发现、这说明、真正值得思考的是”等若只是评论文本而没有具体判断，标记 `narrator_voice`。提示语后有实质内容时，可以建议直接陈述实质内容。

### 8.9 句式和段落模板过度统一

连续多个段落采用完全相同开头、句长、句数和收尾方式，导致重点不突出或呈现批量模板感时，标记 `uniform_sentence_pattern`。正式报告的稳定结构不应被机械判错。

### 8.10 标点过密

单段多次使用破折号，或分号、顿号、破折号叠加导致逻辑难辨时，标记 `punctuation_overload`。单次正常使用不标记。

### 8.11 加粗和分条滥用

简单论述被切成大量短列表、加粗标签制造虚假层级或因果分析被列表割裂时，标记 `formatting_overstructure`。步骤、参数、要求和真实分类可使用列表。

## 9. 模板表达密度

词语只作为辅助信号：

- Tier 1：赋能、助力、抓手、闭环、值得注意的是、综上所述、深远影响、前所未有等，出现时检查具体作用；
- Tier 2：此外、与此同时、显著、有效、全面、持续、进一步等，短段同类 2 次或长段 3 次以上再检查；
- Tier 3：重要、关键、核心、创新、优化、提升、推动、确保、实现等，仅在全文密度明显过高时检查。

不能输出“该词有 AI 味所以替换”。必须说明当前句子中的实际问题。

## 10. 误判防护

以下情况不应默认判错：

- 引用原文；
- 被定义或讨论的术语；
- 标准、规范和制度固定用语；
- 代码、接口、字段、参数和配置；
- 系统、服务和模型的真实行为；
- 技术报告、事故复盘中的专业术语；
- 学术和实验报告中的正常被动语态；
- 有真实层级的步骤列举；
- 有论证作用的对比；
- 摘要中第3—5个关键词按生成规则固定承担三个核心研究点的计算机/人工智能/算法技术索引作用；只要它们与对应研究点一致，不应因为专业术语密度高、不是电力业务词或与正文技术标题相近而判为模板化表达。
- 正文中的 `【此处插入图X-X】` 是报告生成阶段的标准插图占位标记，最终 Word 会转换为白色矩形边框。只要图号、图题、正文引用和预期表达内容清楚，不得因“没有真正绘图”判定报告内容缺失；只有图题与正文无法说明该图要表达什么时才提出内容问题。
- 图题、表题与说明段必须可区分：真正图题/表题应独占一段并采用 `图X-X 图题` / `表X-X 表题`；普通说明段不得以图号/表号起句写成“图1-1应表达……”“表2-1给出……”等疑似题注形式，应使用“该图应表达……”“该表给出……”“上述趋势/上述结果……”等。发现说明段可能被 Word 图/表目录 TC 域误采集时标记 `catalog_explanation_misclassified_risk`；发现真正图题/表题缺失或题注与说明无法区分时标记 `caption_catalog_boundary_invalid`。
- 有信息增量的章节结论；
- 行业中含义稳定的专业词；
- 用户明确要求遵循的正式模板。

## 11. 全文审核

检查：

1. 后一章是否承接前文问题和结论；
2. 概念是否在使用前定义；
3. 是否存在精确重复、语义重复、结构重复和结论重复；
4. 同一指标、状态、定义和原因是否前后矛盾；
5. 同一对象名称、缩写和中英文写法是否统一；
6. 报告是否形成“问题—方法—结果—结论”的闭环；
7. 摘要、正文、总结和参考文献是否对应。
8. 摘要篇幅与三段结构以编排器传入的 `abstract_quality_metrics` 确定性结果为准：`valid=true` 时不得由模型重新估算字数并据此否定；审核重点检查英文摘要是否同时存在，以及中英文摘要的挑战、技术点、数值、结论和能力边界是否一致。摘要中为挑战和技术点建立对应关系所使用的必要顺序词不得作为模板化表达扣分。
9. 摘要首句候选与指标来源按生成规则审核：`opening_sentence_candidates_cn` 应有3—5句业务需求背景分析候选，候选角度应有实质差异且不提前写方法、指标或结果；`selected_opening_sentence_cn` 应实际成为中文摘要第一完整句。候选质量弱或高度同质时标记 `abstract_opening_candidate_weak`。
10. 存在任务书时，摘要第三段的指标结果必须以任务书考核事项为主。检查 `assessment_result_coverage` 是否同时覆盖范围内定量、定性和混合考核事项：定量指标写实际结果，定性指标必须写已经形成的能力、功能、成果状态、适用性或工程效果，不能因为没有数值阈值而省略，也不能只复述“应具备/应形成/完成某功能”等要求。漏项标记 `abstract_assessment_result_coverage_missing`，定性事项无结果标记 `abstract_qualitative_assessment_result_missing`。非任务书补充指标默认不写，确有必要时全篇最多1—2个；超过2个或用大量普通实验指标挤占任务书考核结果时标记 `abstract_supplementary_metric_overload`。若无任务书，则摘要最多选择1—2个最能代表研究效果且有证据的结果指标。
11. 摘要默认五个关键词时，第3—5个应分别能追溯到主要研究内容点的具体计算机/人工智能/算法技术，而不是纯电力业务对象或“智能化、数字化、技术研究、系统应用”等泛词；这三个专业技术词本身不构成模板化或语域问题。若与对应研究内容无关，标记 `keyword_technical_misalignment`。

全文评分维度：目标完成 20、章节协同 20、全局逻辑 20、证据体系 15、术语一致 10、中文长文 15。

## 12. 问题类型

```yaml
issue_types:
  task: [missing_goal_coverage, incomplete_content, title_content_mismatch, missing_key_point, irrelevant_content]
  logic: [logic_gap, unsupported_conclusion, causal_error, false_binary, category_overlap, inconsistent_classification, missing_condition, broken_technical_chain]
  structure: [poor_section_order, paragraph_overload, paragraph_fragmentation, duplicated_content, weak_transition, heading_transition_missing, mechanical_enumeration, symmetry_padding, generic_innovation_heading, chapter_parent_logic_mismatch, future_chapter_scope_leak, unnecessary_core_heading_expansion, chapter_summary_unnecessary_quotes, technology_family_too_broad, technology_signature_not_visible, operation_level_heading, english_technology_in_heading, based_on_heading_ratio_out_of_range, power_domain_signal_missing, level2_subject_power_signal_missing, non_evaluation_heading_policy_violation, heading_source_term_coverage_missing, technology_option_plan_missing_or_invalid, technology_option_scope_mismatch, heading_ending_distribution_mismatch, duplicate_level3_task_subject, primary_technical_subject_underdeveloped, experiment_metric_analysis_overload, chapter_summary_metric_overload, hard_indicator_allocation_violation]
  evidence: [unsourced_claim, missing_data_context, insufficient_evidence, unsupported_generalization, citation_inconsistency, reference_format_noncompliance, misrepresented_reference_experiment]
  longform: [abstract_shell, abstract_opening_candidate_weak, abstract_assessment_result_coverage_missing, abstract_qualitative_assessment_result_missing, abstract_supplementary_metric_overload, false_agency, value_inflation, empty_summary, narrator_voice, uniform_sentence_pattern, punctuation_overload, formatting_overstructure, template_phrase_density]
  global: [terminology_inconsistency, cross_chapter_contradiction, chapter_boundary_overlap, missing_global_closure, keyword_technical_misalignment]
```

## 13. 修改指令格式

`revision_instruction` 必须明确：

```text
保留：无需重写的结构和内容。
重点修改：具体章节、小节或段落。
必须完成：与 must_fix 一一对应的动作。
无需修改：避免生成 Skill 扩大修改范围。
```

## 14. 强制约束

1. 不输出完整重写正文；
2. 不以个人偏好替代报告任务；
3. 不机械判定所有被动、列举、技术词或连接词为问题；
4. 每个正式问题必须可定位、可解释、可执行；
5. 合并同源问题，不人为放大数量；
6. 可选建议不得进入 `must_fix`；
7. 审核结果必须绑定具体 artifact 和 version；
8. 修改后的版本必须重新审核；
9. 输出必须符合统一响应协议；
10. 中文长文表达规则参考并改编自 `MrGeDiao/shuorenhua`，许可信息见套件 `licenses/shuorenhua-LICENSE.txt`。

## 最终总结章结构与篇幅

审核最后一章“总结”“总结与展望”或“结论”时执行专属规则：

- 该章只能有一个一级标题；
- 不得设置任何二级、三级或更低级标题；
- 正文有效字数必须为700—800字；
- 700—800字采用编排器确定性统计结果，Reviewer 不自行估算字数；
- 该章仍需围绕全文总体问题收束主要成果、定量/定性证据、局限与展望，但这些内容通过连续自然段组织，不通过分节标题组织；
- 若出现“X.1 总结”“X.2 展望”“主要成果”“不足与展望”等下级标题，标记 `final_summary_has_subheadings`；
- 若确定性统计低于700或高于800，标记 `final_summary_length_out_of_range`。
