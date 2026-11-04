# {{chapter_id}} {{chapter_title}}写作计划

## 课题角色与标题边界

- 所属课题编号：
- 所属课题原始顺序：
- 课题角色：`technical-research` / `engineering-implementation`
- 当前章允许使用的课题事项：
- 必须排除的其他课题事项：
- 报告主题属性：{{report_theme_type}}  <!-- evaluation-related / non-evaluation -->
- 标题命题中心检查：技术研究课题不得把“机制、建模、体系、定义”作为独立命题、中心名词或落脚点；non-evaluation主题二、三级标题不得出现验证/评估/评价/测评/验收/测试/试验/实验类章节词
- 一级章标题落脚点：
- 章内核心研究小点的拆解依据：
- 当前研究内容核心技术主语：{{primary_technical_subject}}
- 核心技术主语来源原文：{{primary_subject_source_text}}
- 主体技术整体展开节编号：{{primary_subject_section_number}}
- 主体技术整体展开节目标字数：{{primary_subject_target_words}}
- 主体技术整体展开节占X.1—X.N正文计划比例：{{primary_subject_target_share}}
- 低于25%时的例外理由：{{primary_subject_share_exception_reason}}
- 核心二级标题的电力对象、技术方法和技术作用：
- X.1—X.N默认分别设置2—4个三级标题，必要时最多5个：
- 各组三级标题相对上位标题的具体化依据：
- 标题长度检查：原则上不超过25个可见字符；技术研究章二、三级标题优先保证具体技术签名与40%—60%“基于……的……”比例，必要时可超过25字符并记录例外；仅evaluation-related主题的评估功能标题可简洁命名

## 1. 本章报告范围映射与名词化章名

- 报告范围：{{task_book_scope}}  <!-- total_report / specific_topic / not_applicable -->
- 总报告课题编号：{{parent_task_id}}
- 总报告课题原始名称：{{source_task_title}}
- 总报告课题名词化章名：{{source_task_normalized_title}}
- 总报告课题章名处理说明：{{task_title_normalization_basis}}
- 所属一级研究内容编号：{{parent_research_content_id}}
- 当前章覆盖的研究内容小点编号：{{source_research_point_ids}}
- 具体课题报告研究内容小点原文：{{source_research_subpoint_title}}
- 具体课题报告小点原始顺序：{{source_research_order}}
- 已确认名词化章名：{{chapter_title}}
- 名词化处理说明：{{title_normalization_basis}}
- 第一章1.2对应研究现状主题：{{development_status_topic}}
- 国外研究现状与国内研究现状采用一致研究主题口径：{{development_status_topic_alignment}}
- 第一章1.2研究现状作者指代样式：{{development_status_attribution_style}}  <!-- author_et_al / author_team；默认author_et_al -->
- 当前技术章范围内的主要技术任务：{{source_scope_keywords}}
- 当前技术章预期形成的能力：{{expected_capability}}

> 一级技术章标题以当前报告范围映射单位为内容边界：总报告以课题名称或一级研究内容为边界，具体课题报告以研究内容小点原文为边界。技术研究课题一级章标题应直接落到实际采用的具体技术、方法、算法或模型；二、三级技术标题只以“技术/方法”收束，不得把“机制、建模、体系、定义”作为独立命题、中心名词或落脚点，也不得机械改名；工程实现课题落到系统、平台、架构、模块、接口、部署、集成或应用。不得增加原文没有的对象、算法、能力、指标、结果或评价词。

## 2. 当前报告范围与其他课题隔离

- 当前报告范围摘要：{{report_scope_summary}}
- 本章允许使用的范围内事项：{{in_scope_item_ids}}
- 经确认可共用的基础事项：{{shared_approved_item_ids}}
- 必须排除的其他课题事项：{{excluded_other_task_item_ids}}
- 范围判断依据：{{scope_rationale}}
- 尚未确认的范围问题：{{scope_open_questions}}

> 本章正文只能使用`in-scope`和经确认的`shared-approved`内容。`excluded-other-task`中的研究内容、方法、指标、数据、案例、成果和结论不得进入本章，即使它们来自同一任务材料或与当前主题相近。

## 3. 内容生成依据模式与材料清单

- 默认内容生成依据模式：{{default_content_generation_mode}}
- 当前章实际生效模式：{{effective_content_generation_mode}}
- 临时模式覆盖：{{temporary_mode_override}}
- 模式判断依据：{{content_generation_mode_rationale}}

### 基于已有内容生成时

- 已收到材料：{{chapter_material_inventory}}
- 材料与小节映射：{{material_section_mapping}}
- 已有材料能够支撑的技术主张：{{material_supported_claims}}
- 阻塞章节生成的材料缺口：{{blocking_material_gaps}}
- 非阻塞缺口及占位方式：{{non_blocking_material_gaps}}
- 禁止模型自主补写为既有事实的内容：{{facts_not_to_invent}}
- 本章材料状态：{{chapter_material_status}}

### 交由大模型自行生成时

- 模型可自主设计的技术范围：{{autonomous_design_scope}}
- 必须优先沿用的已有材料：{{materials_to_preserve}}
- 仍需保持占位的数据、结果和项目事实：{{autonomous_mode_evidence_limits}}

> 模式选择后默认沿用，不在每章重复询问。用户可通过“本章交给模型生成”“本节交给模型生成”“后续都交给模型生成”或“后续恢复根据已有内容生成”主动切换。

## 4. 字数计划与最低验收线

- 本章计划字数：{{chapter_target_words}}
- 本章最低验收字数（计划字数×80%，向上取整）：{{chapter_minimum_words}}
- 各节字数分配：
{{section_word_count_plan}}
- 各节计划字数合计与本章计划字数的关系：{{word_count_reconciliation}}
- 字数统计命令：`python scripts/validate_word_count.py 当前生成单元.md --target 计划字数 --min-ratio 0.8`

> 正文不得低于计划字数的80%。不足时补充实质技术内容，不得重复背景、定义、总结或使用空洞过渡凑字数。

## 4.1 一级标题与首个二级标题过渡正文计划

- 过渡模式：{{heading_bridge_requirement}}  <!-- short_50_100 / technical_chapter_intro / not_applicable -->
- 第一章/一般非技术章过渡目标：50—100字
- 技术章：沿用既有长章首导入，不额外叠加短引言
- 过渡正文承担的总体问题与衔接作用：{{heading_bridge_content_plan}}
- 是否避免逐条复述目录：{{heading_bridge_not_outline_recap}}

> 只要本章存在二级标题，一级标题后不得立即出现二级标题。具体执行 `references/heading-transition.md`。

## 5. 本章在全篇中的作用

{{chapter_role}}

- 章首总体目标关联：{{overall_goal_relation}}
- 研究对象：{{research_object}}
- 形成的技术能力或产物：{{produced_assets}}
- 适用范围与边界：{{applicable_scope}}

## 6. 章首无标题导入计划

> 本部分是写作计划，不对应正文标题。正式正文在一级章标题后直接进入下列导入内容，不输出“概述”“技术路线”“技术架构”等标题。

- 章首导入目标字数：{{chapter_lead_target_words}}
- 章首导入建议范围：{{chapter_lead_target_range}}  <!-- 5万字全文时约800—1200字；其他全文按1.6%—2.4%同比例 -->
- 与报告总体目标的支撑关系：{{overall_goal_support}}
- 本章相关背景与现实问题：{{existing_problem_analysis}}
- 本章研究意义：{{chapter_research_significance}}
- 研究主题与核心问题：{{chapter_research_theme}}
- 技术原因或关键约束：{{problem_causes}}
- 研究对象、输入与输出：{{research_io}}
- 总体技术路线或架构类型：{{route_or_architecture_type}}
- 路线/架构选择理由：{{route_or_architecture_rationale}}
- 处理阶段或架构层次：{{route_stages_or_layers}}
- 模型、算法、模块及其关系：{{route_components}}
- 数据流、知识流、模型流或控制流：{{route_flows}}
- 输出、反馈与验证对应关系：{{route_outputs_and_validation}}
- 目标能力与边界：{{target_capability_and_boundary}}
- 本章核心主张：{{core_claim}}
- 技术路线图或技术架构图计划：{{route_visual_plan}}
- 内部技术单元与验证重点：{{chapter_internal_preview}}

> 章首导入应使用连贯正文完成“背景与意义 → 研究主题 → 总体技术路线/架构 → 关键输入输出与边界”的自然过渡，并优先在适合时采用图文结合。不得拆回两个功能性小节。

## 7. 章内核心研究小点与三级标题计划

### 核心二级标题计划（默认3个，必要时最小扩展）

| 序号 | 二级标题 | 小点来源依据 | 所属课题 | 对应来源研究内容 | 核心技术主语 | 是否主体整体展开节 | 电力对象/约束 | 具体计算技术 | 标题技术签名 | 技术具体性依据 | 技术来源状态 | 技术作用 | 承接角色 | 前序输入 | 后序输出 | 覆盖进度事项 | 覆盖考核事项 | 三级具体化依据 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1（{{chapter_id}}.1） | {{core_title_1}} | {{derivation_basis_1}} | {{parent_task_id}} | {{research_point_id}} | {{primary_technical_subject}} | {{primary_subject_section_1}} | {{power_element_1}} | {{specific_computing_technology_1}} | {{technical_signature_1}} | {{technology_specificity_basis_1}} | {{technology_origin_1}} | {{technical_role_1}} | {{chain_role_1}} | {{handoff_from_previous_1}} | {{output_to_next_1}} | {{schedule_item_ids_1}} | {{assessment_item_ids_1}} | {{specificity_basis_1}} |
| 2（{{chapter_id}}.2） | {{core_title_2}} | {{derivation_basis_2}} | {{parent_task_id}} | {{research_point_id}} | {{primary_technical_subject}} | {{primary_subject_section_2}} | {{power_element_2}} | {{specific_computing_technology_2}} | {{technical_signature_2}} | {{technology_specificity_basis_2}} | {{technology_origin_2}} | {{technical_role_2}} | {{chain_role_2}} | {{handoff_from_previous_2}} | {{output_to_next_2}} | {{schedule_item_ids_2}} | {{assessment_item_ids_2}} | {{specificity_basis_2}} |
| 3（{{chapter_id}}.3） | {{core_title_3}} | {{derivation_basis_3}} | {{parent_task_id}} | {{research_point_id}} | {{primary_technical_subject}} | {{primary_subject_section_3}} | {{power_element_3}} | {{specific_computing_technology_3}} | {{technical_signature_3}} | {{technology_specificity_basis_3}} | {{technology_origin_3}} | {{technical_role_3}} | {{chain_role_3}} | {{handoff_from_previous_3}} | {{output_to_next_3}} | {{schedule_item_ids_3}} | {{assessment_item_ids_3}} | {{specificity_basis_3}} |

> 每个技术章默认形成X.1—X.3三个核心二级标题；只有当前章预期目标/进度技术点确实过多且无法合理归并时，才允许最小扩展到4—5个，并填写 `core_section_count` 与 `core_section_expansion_reason`。全部小点从当前章研究内容、预期目标、进度计划和考核要求中拆解，不得借用其他课题内容凑足数量，也不得提前覆盖后续技术章职责。二级标题若包含“的”，以“的”之后完整部分为主语，该主语本身必须含强电力相关词；技术研究章二、三级技术标题最终只以“技术/方法”收束，并按每章约40%技术、60%方法规划。每个标题必须完整表达电力对象或约束、**细粒度技术变体/关键机制**和作用，禁止纯计算机标题。RAG、图神经网络/GNN、Transformer、强化学习、大模型等技术族名称本身不算“具体计算技术”；填写 `specific_computing_technology` 时可以保留可追溯的原始技术名，但 `technical_signature` 必须写成正式目录中使用的中文语义技术签名，英文模型名/英文缩写不得直接裸露在二、三级标题。中文化应突出实际路线，例如把“GraphSAGE”表达为“图邻域采样聚合”，而不是逐字展开英文全称。

### 可选技术方案计划（目录确认伴随信息）

> 本表只服务于目录确认，不属于正式目录。来源未锁定技术路线时，每个核心二级研究点给2—3个候选；来源已唯一锁定时只列1个来源技术并标记 `source_locked=true`。候选必须解决同一个章内问题，不能借候选把后续章节技术提前带入当前章。

| 二级节 | 研究问题/作用 | 来源锁定 | 候选ID | 候选技术 | 中文技术签名 | 关键机制 | 适配理由 | 来源状态 | 是否推荐 | 范围风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| {{section_number}} | {{problem_or_role}} | {{source_locked}} | {{candidate_id}} | {{technology_name}} | {{technical_signature_cn}} | {{key_mechanisms}} | {{fit_reason}} | {{origin}} | {{recommended}} | {{scope_risk}} |

- 每个核心二级研究点的候选集合：{{technology_option_sets}}
- 当前推荐/确认技术：{{selected_technology_option_ids}}
- 用户改选候选时需重算的标题：{{technology_option_affected_headings}}

- 核心研究小点共同形成的技术链：{{core_subpoint_logic_chain}}
- 核心二级标题数量：{{core_section_count}}  <!-- 默认3；仅必要时4—5 -->
- 超过3个时的来源化扩展理由：{{core_section_expansion_reason}}
- 各核心小点互不重复的说明：{{core_subpoint_distinction}}
- 未新增标题即可归并的技术事项及归并方式：{{extra_technology_grouping}}
- 全部核心小点下的二级、三级标题及任务：
{{section_plan}}
- 正文标题锁定清单（必须包含当前章全部已确认一级、二级、三级标题，格式为“层级 | 编号 | 标题”）：
{{locked_heading_manifest}}
- X.1三级标题（默认2—4个，必要时最多5个）：{{level3_group_1}}
- X.2三级标题（默认2—4个，必要时最多5个）：{{level3_group_2}}
- X.3三级标题（默认2—4个，必要时最多5个）：{{level3_group_3}}
- 若存在X.4/X.5核心研究点，其三级标题与扩展理由：{{extra_core_level3_groups}}
- 各二级节扩展到5个三级标题的来源化理由：{{level3_expansion_reasons}}
- 各组三级标题的拆分依据与互不重复说明：{{level3_strategy}}
- 同一章全部技术类三级标题的任务主语唯一性检查：列出每个三级标题的 `task_subject`；“基于……的……”取“的”之后完整部分，直接复合标题取去除 `technical_signature` 后的电力任务部分；不得重复：{{level3_task_subject_uniqueness}}
- 每个三级技术标题的中文语义 `technical_signature`、原始具体技术名称及中英文路线对应依据：{{named_technology_heading_plan}}
- 若 `report_theme_type=evaluation-related` 且存在功能性评估类三级标题，列出其标题及理由；`non-evaluation` 必须为空：{{functional_heading_rationale}}
- 可保持自然段展开的非核心部分：{{paragraph_only_sections}}
- 全文核心二级标题总数：{{global_core_level2_count}}
- 显式包含电力相关词的核心二级标题数：{{global_explicit_power_title_count}}

> X.1—X.N每个核心标题都必须逐项体现电力对象/约束、细粒度技术变体/关键机制和技术作用。若技术部分仍只能概括为RAG、图神经网络、Transformer、强化学习等技术族，应继续细化后再确认目录。目录和本计划确认后，标题锁定清单成为正文硬约束：三级标题必须使用Markdown `###`按原编号、原名称和原顺序输出，不得被自然段替代。每个三级技术标题必须独立显化电力对象/约束与具体技术签名，不得只继承上位领域语义或上位技术。

## 8. 来源细则与考核指标全量覆盖计划

- 本章需覆盖的来源研究内容子项：{{research_content_item_ids}}
- 本章需覆盖的预期目标：{{expected_goal_item_ids}}
- 本章需覆盖的进度计划技术事项：{{schedule_item_ids}}
- 本章需隐性覆盖的内部技术要求、阈值与验证条件：{{assessment_item_ids}}
- 本章需覆盖的成果或应用要求：{{expected_output_item_ids}}
- 预期目标/进度计划/考核要求关键技术词标题映射：
{{heading_source_term_plan}}
- 关键技术词粒度检查：概括性 `broad` → 二级标题；窄技术点 `narrow` → 三级标题；3项及以上时原则上分散到至少两个核心研究分支；若目标数量过多，先尝试语义归并，确实无法归并时才扩展二/三级标题
- 非评估主题转写检查：验证/评估/测试/验收/实验等来源动作词不得直接进入二、三级标题，改写为实际性能、约束、边界或工程技术语义
- 各事项在本章的具体落点：
{{source_item_section_allocations}}
- 尚缺证据、数据或实现细节：{{coverage_evidence_gaps}}

### 内部技术要求隐性覆盖表

| 内部事项编号 | 技术能力或性能要求 | 对应章内研究小点 | 正文融入位置 | 可选证据位置 | 电力对象或业务条件 | 计算/判定方法 | 单位与目标值 | 数据或工况条件 | 正文表述方式 | 来源身份隐藏 | 证据状态 | 确认位置 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| {{assessment_item_id}} | {{assessment_name}} | {{research_subpoint_index}} | {{assessment_body_section}} | {{assessment_evidence_section}} | {{assessment_meaning}} | {{assessment_method}} | {{assessment_target}} | {{assessment_test_conditions}} | {{assessment_prose_realization}} | true | {{assessment_evidence_status}} | {{assessment_confirmed_location}} |

> 内部事项编号和来源名称仅用于规划，不得进入正式正文。正文应直接写成技术目标、设计约束、性能描述、适用条件、结果证据或能力边界，不得出现“任务书”“考核指标”“考核要求”“考核细则”“规定指标”等来源性表达。各章自身技术要求默认融入X.1—X.N或其三级标题；任务书硬指标集中由最后一个技术章节承接，不要求单独的验证位置。没有真实结果时只能写成设计目标、验证方案或明确占位，不得把目标值写成已完成结果。

## 9. 独立验证二级节判定

- 默认模式：{{standalone_validation_mode}}  <!-- 应为 none -->
- 是否存在大量成体系数据：{{has_large_structured_dataset}}
- 用户是否明确要求独立验证节：{{user_requested_standalone_validation}}
- 例外原因：{{standalone_validation_reason}}
- 若启用例外，验证节与X.1—X.N的对应关系：{{standalone_validation_mapping}}

> `report_theme_type=non-evaluation` 时，二、三级目录不得出现实验、测试、验证、评估、评价、测评、验收等章节词，`standalone_validation_mode` 必须为 `none`，全部核心研究点后直接进入本章小结；有限证据、结果和边界分析写入对应研究小点正文。只有 `report_theme_type=evaluation-related` 且满足 `large-data` 或 `user-requested` 例外时，才可在核心研究点后设置独立评估/验证节，本章小结再顺延1位。本章小结正文默认避免使用引号包裹技术词、概念名或结论短语。

## 10. 当前章范围边界与后续章节隔离

- 当前一级标题核心问题：{{current_chapter_question}}
- 当前章允许展开对象/输入/输出：{{chapter_in_scope_objects_outputs}}
- 后续技术章保留职责：{{reserved_for_later_chapters}}
- 一级标题核心对象：{{chapter_core_object}}
- 一级标题核心问题：{{chapter_core_problem}}
- 一级标题核心输出：{{chapter_core_output}}
- 各X.i与一级标题的直接逻辑：{{parent_logic_links}}
- 当前章标题禁止提前使用的后续章专属技术词：{{forbidden_future_terms}}
- 二级标题章内专属性检查（逐条回答“为何只能放在本章”）：{{level2_chapter_specificity_check}}
- 一级—二级主线逻辑检查：{{parent_heading_logic_check}}

> 二、三级标题不得涉及后续技术章的核心研究职责。可以在正文说明当前章产物将作为后续输入，但不能提前展开后续章方法、实验和结论。二级标题的判断依据不是命中某个“通用词”黑名单，而是研究逻辑归属：必须说明其研究对象、核心问题和输出为什么是当前一级标题主线的直接组成部分；即使技术点与整个项目有关，只要它更像相邻/后续章节的独立研究任务，或与当前一级标题仅有间接关联，就必须移出或重写。

## 11. 技术指标、实验重点与最后技术章硬指标承接

- 本章自身技术指标：{{chapter_technical_indicators}}
- 本章是否为最后一个技术章节：{{is_last_technical_chapter}}
- 单个实验展示的全部指标：{{experiment_metric_sets}}
- 每个实验最多2个重点分析指标：{{experiment_primary_analysis_metrics}}
- 本章小结每个核心二级研究点最多1个代表指标：{{summary_metric_by_core_section}}
- 无实验/无可靠量化结果的研究点：{{summary_sections_without_metric}}
- 任务书硬指标集中承接计划（仅最后技术章）：{{task_hard_indicator_plan}}
- 可融合进既有实验位置的硬指标：{{hard_indicators_merged_into_existing_experiments}}
- 无法融合时的总体性能分析位置：{{overall_performance_analysis_location}}
- 最后技术章小结中的自然结果/效果表达：{{hard_indicator_summary_realization}}

> 一个实验可以展示多个指标，但分析正文最多重点解释2个。本章小结每个核心二级研究点最多选择1个最能代表效果的指标，没有实验则不写指标。任务书硬指标统一在最后技术章集中承接：能与原实验融合就融合，不能融合才最小新增总体性能分析标题；小结写实际结果和技术效果，不复述“超过××、不低于××、小于××”等任务书门槛。

## 12. 技术依赖、产物与正文衔接

- 使用的既有技术对象、数据、模型或系统成果：{{prerequisite_assets}}
- 本章形成的可复用技术产物：{{produced_assets}}
- 正文衔接策略：{{cross_section_reference_strategy}}
- 第一章1.3.2“研究思路”是否仅描述研究内容之间的逻辑而未复述章节编号：{{research_approach_no_chapter_numbering}}

> 正文不得使用具体章节编号及“上一章、下一章”等互引；不得出现任务书、课题编号、最终材料等来源词汇。

## 13. 叙述聚焦与电力语义计划

- 本章核心判断：{{chapter_central_claim}}
- 各主要小节的中心判断：{{section_central_claims}}
- 主要逻辑链：{{argument_chains}}
- 确有必要保留的离散并列：{{necessary_parallel_items}}
- 应删除或改写的宽泛并列：{{parallel_items_to_reduce}}
- 需要落到的电网设备与业务对象：{{power_domain_objects}}
- 需要解释的物理量与运行约束：{{physical_quantities_and_constraints}}
- 电力意义穿插位置：{{power_grounding_locations}}
- 与其他课题内容隔离的重点：{{scope_isolation_for_prose}}

> 每段围绕一个主要判断展开。减少无信息过渡词和逗号顿号堆叠；存在因果、先后、约束、包含或反馈关系时按逻辑链组织。技术解释只在确有联系时落到电力对象和物理意义，不机械添加工程价值口号。

## 14. 公式、符号、算法和实现安排

- 公式需求级别：{{formula_requirement}}
- 判断依据：{{formula_requirement_rationale}}
- 若为豁免，豁免理由：{{formula_exemption_reason}}
- 核心公式清单：
{{formula_inventory}}
- 公式类别标记（technical / descriptive）：{{formula_category_plan}}
- 技术公式覆盖：定理/物理原理、loss、目标、约束、更新、推断、评分、指标或性能关系：{{technical_formula_coverage}}
- 描述性公式保留理由：{{descriptive_formula_retention_rationale}}
- 每个公式不可替代的论证或计算作用：{{formula_necessity}}
- 应删除的表面公式和可改用文字的描述性公式候选：{{decorative_formulas_to_omit}}
- 符号对应的电力对象与物理意义：{{formula_power_domain_meaning}}
- 全局符号沿用与新增符号：{{symbol_plan}}
- 公式编号与符号解释方式：{{formula_format_and_definition_plan}}
- 算法和系统实现安排：{{algorithm_and_implementation_plan}}

## 15. 证据、结果与小结安排

> 本章小结计划字段统一执行 `references/chapter-summary.md`。

{{embedded_evidence_and_result_plan}}

- 本章小结目标字数：{{chapter_summary_target_words}}
- 本章小结建议范围：{{chapter_summary_target_range}}  <!-- 具体规则见 references/chapter-summary.md -->
- 本章小结总—分—总结构计划：{{chapter_summary_total_part_total_plan}}
- 本章小结的定量依据：{{chapter_summary_quantitative_evidence}}
- 本章小结的定性判断：{{chapter_summary_qualitative_conclusion}}
- X.1—X.3研究成果分项归纳：{{chapter_summary_subpoint_results}}
- 本章小结必须出现的电力对象或业务意义：{{chapter_summary_power_meaning}}
- 本章小结第二段普通实验结果安排：{{chapter_summary_middle_experiment_results}}
- 本章小结第三段特别目标/要求对应结果安排：{{chapter_summary_ending_target_results}}
- 本章小结方法优越性归纳：{{chapter_summary_method_advantage}}
- 本章使用模拟实验时的章末统一说明：{{chapter_end_simulation_notice}}

- 对应内部技术要求的隐性覆盖位置：{{in_scope_assessment_targets}}
- 独立验证二级节是否启用：{{standalone_validation_mode}}
- 禁止借用的其他课题证据：{{excluded_evidence_sources}}

## 16. 图表计划

{{visual_plan}}

> 所有计划插图在报告内容生成阶段只输出 `【此处插入图X-X】` + 图题；Word排版阶段统一渲染为白底细边框矩形占位框。不得在内容生成阶段直接绘制真实或模拟图。

## 17. 已有材料

{{available_information}}

## 18. 摘要证据预登记

- 是否进入摘要第二段的主要研究点：{{contributes_to_abstract}}
- 对应研究点：{{abstract_research_point_id}}
- 对应第一段关键挑战：{{abstract_challenge_ids}}
- 准备登记的问题：{{abstract_problem}}
- 准备登记的技术名称：{{abstract_technology}}
- 准备登记的核心机制：{{abstract_core_mechanism}}
- 准备登记的能力：{{abstract_capability}}
- 需要由实验或案例提供的证据：{{abstract_result_evidence_targets}}
- 是否可能作为非任务书补充指标进入摘要第三段（全篇最多1—2个）：{{candidate_for_supplementary_result_metrics}}
- 适用条件与边界：{{abstract_applicable_conditions}}
- 可支撑的研究或应用前景：{{abstract_prospect_evidence_targets}}

## 19. 当前缺失信息及处理方式

- 阻塞正文生成的信息：{{blocking_information}}
- 可使用占位的信息：{{non_blocking_information}}

## 20. 每章生成必经规则

- 当前允许生成范围：{{allowed_generation_scope}}
- 必须复用的术语、符号和指标：{{consistency_items}}
- 禁止的其他课题内容：{{forbidden_other_task_content}}
- 禁止的来源和跨章互引表达：{{forbidden_language}}
- 生成前需重新读取：`references/chapter-generation-preflight.md`、`references/three-subpoint-and-indicator-coverage.md`、`references/content-generation-mode.md`与`references/narrative-focus-and-power-grounding.md`
- 展示前检查方式：{{validation_plan}}
- 字数检查方式：{{word_count_validation_plan}}
- 标题覆盖检查方式：`python scripts/validate_heading_coverage.py 当前章节.md --outline 已确认目录.json --chapter {{chapter_id}}`；分节生成时改用`--section 当前二级节编号`

## 21. 正文输出粒度

- 输出粒度：{{chapter_output_granularity}}
- 选择原因：{{chapter_output_granularity_reason}}
- 分章或分节顺序：{{generation_sequence}}

> 请确认或修改本章计划。确认后，再按该计划生成正文。
