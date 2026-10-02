---
name: power-grid-technical-report-writer
description: "面向电网科技项目结题技术报告的渐进式写作 Skill。用于建立项目档案、确认论证架构与目录、制定章节计划、分章生成正文、维护摘要证据包并组装最终报告；支持基于已有内容和大模型自主生成两种模式，并与报告审核及 Word 排版子 Skill 协同工作。"
---

## 0. 完整能力与强制约束

> 本节由 v1.1.4 中超出 front matter 长度限制的原始 `description` 原样迁移。仅改变存放位置，不改变任何规则。

面向电网、电力人工智能、设备运维、调度控制、信息通信和数字化平台等领域，
以严格的阶段状态机组织科技报告写作。先建立项目档案，再确认中心主旨、论证架构和目录，
随后按“章节计划—用户确认—分章或分节生成—用户确认”的方式逐步完成报告。
正式正文坚持段落优先、分点按需；技术章X.1—X.N核心研究小点强制展开三级标题，其余标题层级按内容自适应，并选择性使用“电力”领域词。
目录不得由模型自由发挥，全文严格采用固定架构：第一章必须为“项目概述”，二级标题依次为“项目背景与研究意义、国内外研究现状、主要研究内容及思路”，三级标题固定为“1.1.1项目研究背景、1.1.2项目研究意义、1.2.1国外研究现状、1.2.2国内研究现状、1.3.1主要研究内容、1.3.2研究思路”；不再单设“国内外发展现状”一级章，技术章节从第2章起按报告范围映射。1.3.1必须与技术规划书、任务书或等效技术文件中的研究内容逐项对应，并在不改变边界的前提下稍作展开。每个技术章一级标题后直接生成无标题章首导入正文，不再设置“概述”和“技术路线/技术架构”二级标题；章首导入正文需完成本章背景与意义、研究主题引入、概括性技术路线/架构说明，并优先图文结合。以5万字全文为基准，章首导入目标约800—1200字，其他总字数按1.6%—2.4%同比例规划。随后每个技术章默认设置X.1、X.2、X.3章内核心研究小点，并分别生成2—4个三级标题；只有预期目标、进度技术点或关键研究事项确实过多且无法在不失真的情况下归并时，才允许最小扩展到4—5个核心二级标题，三级标题也仅在明确覆盖需要时最多扩到5个。目录生成前先由模型根据核心研究主题自动登记 `report_theme_type=evaluation-related|non-evaluation`；单纯存在考核、验收、测试数据或实验安排不构成评估主题。`non-evaluation` 主题的二、三级标题不得出现验证、评估、评价、测评、验收、测试、试验、实验类章节词，默认三个核心研究点后直接设置X.4本章小结；扩展时本章小结按X.(N+1)顺延；只有 `evaluation-related` 主题且存在大量成体系数据或用户明确要求时才允许X.4评估/验证节并将本章小结顺延为X.5。所有核心标题都必须显式识别当前电力对象、业务场景或运行约束，并与具有区分度的具体计算技术及技术作用组合成完整标题；X.1—X.N逐项执行，并确保每个标题只承担当前一级标题范围内职责，不得提前进入后续技术章内容。二级标题若含“的”，以“的”后完整部分为主语，该主语本身必须包含强电力相关词；直接复合二级标题去除 `technical_signature` 后的任务主语也必须独立具有强电力语义。预期目标、进度计划、课题区域对应考核要求中的关键且有实际含义的技术词必须建立 `heading_source_term_plan`，按“概括性→二级、窄技术点→三级”分散进入目录；各章自身技术指标在X.1—X.N正文中隐性覆盖；任务书硬指标统一在最后一个技术章节集中承接，能融入原实验位置则融合，不能融合时才最小新增总体性能分析小节。 每个技术章必须建立当前章边界：二、三级标题只能承担本章一级标题对应的研究对象、输入输出和技术职责，不得提前涉及后续技术章的核心方法、实验或结论；二级标题必须能证明其研究对象、问题和输出是当前一级标题主线的直接组成部分；即使标题中的技术点与整个项目相关，只要其核心研究任务与本章一级标题关联较弱、实际更像相邻章节或后续章节的独立研究内容，也不得放入本章。不得用“某些词看起来通用”作为机械黑名单判断依据。`本章小结` 的正文默认避免使用中文引号、英文引号、书名号等包裹技术词、概念名或结论性短语，优先改写为直接陈述；只有必须保留原文名称或不可替代引用时才使用引号。技术章单个实验可展示多个指标，但分析正文最多重点分析2个；本章小结对每个核心二级研究点最多总结1个代表性效果指标，无实验则不强写指标。最后一个技术章本章小结还需自然覆盖任务书硬指标对应的实际结果和技术效果，不复述“超过/不低于/小于某阈值”的验收句式。参考文献继续执行GB/T 7714—2015顺序编码制。摘要仍执行本生成Skill既有三段式规则，但生成正式摘要前先给出3—5个业务需求背景首句候选并选1句入正文；第三段以任务书考核结果为主，定量和定性指标都必须形成对应结果，非任务书指标仅在确有补充价值时再选1—2个。
技术章节和承担技术定义的总体框架章节默认需要有效公式，并必须解释全部首次出现的符号；若确实不需要公式，必须在章节计划中说明并由用户确认。既有公式分级、有效性和符号解释规则保持不变，同时执行“描述性公式从简、技术公式从充分”的选择原则。技术章的原“概述+技术路线/架构”内容统一写入一级章标题后的无标题章首导入正文：先说明本章背景、具体挑战和研究意义，再概括总体技术路线、关键输入输出、模型/算法/模块关系及边界，并在适合时配置技术路线图或架构图。每章均必须排除任务材料中其他课题或其他报告范围的研究内容、指标、数据、案例和成果。正文原则上不得使用具体章节编号、上一章或下一章等方式跨章互引；每次生成章节或分节正文前后均必须执行章节生成必经规则。首次建立项目档案时，报告类型默认设为“科技项目结题技术报告”，不询问用户偏向何种写作风格。
摘要和正文均应控制无信息过渡词与过渡句，避免使用逗号或顿号堆叠多个并列短语；能够形成因果、先后、约束、包含或反馈关系时，必须重组为清晰逻辑链。技术章“本章小结”的正文组织、篇幅、证据边界、生成时机和验收统一执行 `references/chapter-summary.md`，其他文件不得维护另一套小结正文规则。 一级标题与其后首个二级标题不得直接相邻：第一章及一般非技术章节必须先写50—100字无标题过渡正文；技术章继续使用既有800—1200字长章首导入，不额外叠加短引言；统一执行 `references/heading-transition.md`。第一章1.2国内外研究现状中的作者指代方式必须全文统一，可选择“XXX等人”或“XXX团队”，默认采用“XXX等人”。技术原理、模型变量和公式符号在确有联系时应直接落到电网设备、状态量、运行约束和业务对象。
项目档案草案必须固定确认四项：是否有任务书及本报告对应任务书中的具体课题还是总报告、内容生成依据模式、是否有指定报告字数/模板/章节数量、是否可提供实验数据。选择“基于已有内容生成”时，在论证架构确认后、目录生成前必须先询问并确认每章的大概内容；该环节只补充内容依据，不改变既有固定目录生成规则。目录和章节计划必须登记计划字数及80%最低验收字数，任何章节或分节正文展示前不得低于其计划字数的80%。目录中一经确认的一级、二级、三级标题即形成标题锁定清单；正文生成时必须按原编号、原名称、原层级和原顺序完整输出，特别是X.1—X.N下已确认的三级标题不得合并进自然段、改名或省略。目录标题原则上不超过25个可见字符；技术研究章二、三级标题优先保留具体 `technical_signature` 并满足40%—60%“基于……的……”句式比例，必要时可超过25字符并记录例外；二、三级技术标题最终只以“技术/方法”收束，按每章约40%“技术”、60%“方法”分配，全文“技术”结尾比例控制在35%—45%。只有 `evaluation-related` 主题中的实验/评价功能标题可简洁命名；`non-evaluation` 主题不得在二三级目录使用这些词。最终Markdown组装完成后调用确定性清洗脚本统一长划线并删除数字与汉字之间的空格，无需大模型参与。

实验数据不足不再自动阻塞实验设计，也不得默认退化为“只写方案论证、案例化场景、预期效果或待补数据位”。所有实验相关内容按 REAL_PROJECT_EVIDENCE 与 REFERENCE_EXPERIMENT 两层管理：真实项目证据不得补造；只要当前研究内容需要实验验证且用户未明确拒绝模拟参考数据，生成 Skill 应自主生成完整实验参考包，包括实验设置、数据集使用方案、评价指标、对比方法、对比/消融/敏感性/鲁棒性实验、模拟参考数据、结果表及参考分析，并可作为明确标注的“参考实验/模拟实验”写入报告草稿，供用户后续补做实验或替换。模型生成数值不得冒充真实项目结果；摘要中的量化成果继续执行摘要规则，本章小结统一执行 `references/chapter-summary.md` 的成果归纳规则。技术章X.1—X.N核心二级标题除电力对象和技术作用外，还必须显式包含细化到技术变体或关键机制层级的计算机/人工智能技术；不仅不使用“人工智能、机器学习、深度学习、神经网络、优化算法”等上位词支撑创新性，RAG、图神经网络/GNN、Transformer、图Transformer、强化学习、大模型、知识图谱、扩散模型、状态空间模型、混合专家、元学习、图对比学习等技术族名称本身也不算足够具体，必须继续写明检索/重排策略、图结构、注意力形式、时序机制、约束方式、策略算法或组合结构；允许在已确认研究边界内提出候选技术并标记为模型建议，用户确认后再锁定。全部核心二级标题必须围绕同一个一级章核心问题形成连续承接链，后续研究点应使用前序研究点形成的表示、特征、知识或中间结果，逐步完成推理、优化、决策、集成或技术闭环；只有评估相关主题才可把评估/验证方法作为核心研究职责。摘要固定五关键词规则继续执行，其中第3—5个关键词必须分别优先对应三个核心研究点的计算机/人工智能/算法技术词，如图神经网络、马尔科夫链、扩散模型、贝叶斯优化、对比学习等；不得用纯电力业务对象或“智能化、数字化、技术研究”等泛词替代。**关键词用于检索索引，允许使用技术族名称；标题用于表达技术创新路线，必须遵守更严格的细粒度技术变体/关键机制规则，不能把关键词粒度直接复制为标题粒度。** **二级和三级技术标题都必须独立显化具体 `technical_signature`：Span抽取、双塔匹配、实体识别、置信校准、样本重加权、参数更新等任务动作本身不算创新技术；正式目录中的 `technical_signature` 必须采用简洁、能体现实际技术路线的中文语义技术名，GlobalPointer、RoBERTa、GraphSAGE、HGT、CLIP、LoRA、PPO、RAG 等英文模型名或英文缩写只保留在内部元数据或正文首次定义中，不得直接裸露在二、三级目录标题；中文化不得机械展开成长难全称，也不得把具体技术泛化成“智能模型/深度模型/优化算法”。“基于具体技术签名的……”实行40%—60%双向硬门禁：每个技术研究章及全文二、三级技术标题中的使用比例都必须处于40%—60%，低于40%或高于60%都应重新生成；其余标题采用直接复合技术签名表达。电力领域语义显化与中文技术签名显化是并列硬门禁，均优先于句式比例和25字符原则；“基于……的……”句式不能覆盖电力关键词。即使上位标题已写明电力场景或技术，三级标题也不得退化成纯任务动作。**
任何阶段均不得越级生成后续内容，避免一次性生成结构松散、内容空泛、提纲化、缺少有效数学表达、跨章互引失范、字数明显不足或目录失范的低质量报告。

## 0A. 报告套件外部编排兼容层

> 本节仅提供 `power-grid-report-skill-suite` 的集成接口。独立使用本 Skill 时，继续执行后文的原生渐进式阶段加载和严格交互状态机；由 `report-workflow-orchestrator` 调用时，执行本节定义的外部编排模式。外部编排层不得修改本 Skill 的固定目录架构、报告范围映射、标题命名、章节三级标题、公式、引用、摘要和阶段加载规则。

### 0A.1 触发条件

输入同时包含以下字段时进入外部编排模式：

```yaml
orchestration:
  enabled: true
  request_id: "唯一请求编号"
  caller_skill: "report-workflow-orchestrator"
action: "动作名称"
payload: {}
```

外部编排模式下：

1. 编排器负责套件级状态、用户确认、版本号、确定性质量门和审核循环；
2. 本 Skill 只执行 `action` 指定的当前生成或修改动作；
3. 仍须按 `references/progressive-loading-map.md` 只加载当前动作对应的阶段文件和专题文件；
4. 不自行跳转到后续动作，不把生成 Skill 自检当成正式审核；
5. 使用结构化响应返回产物；编排器根据 `next_required_handoff` 调用 `report-reviewer`；
6. 用户确认职责转移给编排器，但原生阶段规则中的内容质量、输入前提和禁止越级约束继续生效。

### 0A.2 外部动作注册表

> 动作名称集中在此处及套件根目录 `skill-registry.json`，不得散落定义另一套接口。

```yaml
external_actions:
  build_project_profile: "建立项目档案草案，对应原生阶段A"
  build_argument_architecture: "建立中心主旨与论证架构，对应原生阶段B"
  generate_outline: "生成目录与篇幅预算，对应原生阶段C"
  revise_outline: "依据审核结果修改目录，仍执行原生阶段C全部规则"
  search_references: "检索参考文献并组织第一章国内外研究现状，对应原生阶段C2"
  prepare_chapter_materials: "准备当前章材料，对应原生阶段D0"
  generate_chapter_plan: "生成当前章计划，对应原生阶段D"
  revise_chapter_plan: "修改当前章计划，对应原生阶段D"
  generate_chapter: "生成当前章或当前节正文，对应原生阶段E/F"
  revise_chapter: "依据审核结果修改当前章节正文"
  generate_abstract: "基于摘要证据包在同一次产出中生成中文摘要、中文关键词、英文摘要和英文关键词，对应原生阶段G"
  assemble_report: "组装完整Markdown报告，对应原生阶段H"
  revise_report: "依据全文审核结果定向修改报告"
```

### 0A.2.1 运行时上下文装配

外部编排模式不得把整个 Skill 目录、全部专题规则或其他子 Skill 的规则同时放入一次模型调用。运行时必须按 `references/runtime-pack-manifest.json` 装配上下文：

1. 会话或任务初始化时加载一次 `00-control`，由编排器持续维护状态；后续生成动作不重复装入该包；
2. 每个生成动作加载当前动作对应的一个核心规则包；
3. 章节计划或正文动作只加载一个当前章节类型包；
4. 仅在内容确实需要时加载公式、引用、图表、基础章、技术章或结果分析附加包；
5. 当前 payload 只携带当前产物、必要前文摘要、当前版本审核意见和当前章相关材料；
6. 不携带旧版本正文、已解决审核意见、Word 排版规则或其他子 Skill 完整规则。

可使用：

```bash
python scripts/build_context_bundle.py \
  --action generate_chapter \
  --chapter-type algorithm \
  --addon technical \
  --payload request.json \
  --output context.md
```

源规则文件一律保留。编译包仅为运行时结构重组和精确去重，不得改写、概括或删减唯一规则。

### 0A.3 动作加载映射

| 外部动作 | 必须加载的原生阶段文件 |
|---|---|
| `build_project_profile`、`build_argument_architecture` | `stages/10-project-and-argument.md` |
| `generate_outline`、`revise_outline`、`search_references` | `stages/20-outline-and-literature.md` |
| `prepare_chapter_materials`、`generate_chapter_plan`、`revise_chapter_plan` | `stages/30-chapter-planning.md` |
| `generate_chapter`、`revise_chapter` | `stages/40-chapter-writing.md` |
| `generate_abstract`、`assemble_report`、`revise_report` | `stages/50-abstract-and-finalization.md` |

每个动作还必须遵循 `references/progressive-loading-map.md` 指定的专题文件、模板、Schema 和脚本加载条件。

### 0A.4 统一响应协议

```yaml
request_id: "原请求编号"
skill_name: "power-grid-technical-report-writer"
action: "原动作名称"
status: "success | blocked | failed"
artifact:
  artifact_type: "project_profile | argument_architecture | outline | reference_plan | chapter_materials | chapter_plan | chapter | abstract | report"
  artifact_id: "稳定标识"
  version: 1
  content: "Markdown、文本或结构化对象"
  summary: "简短摘要"
metadata:
  chapter_id: null
  section_id: null
  assumptions: []
  unresolved_items: []
  validators_recommended: []
  next_required_handoff:
    skill_name: null
    action: null
    reviewed_artifact_id: null
    reviewed_version: null
error: null
```

动作失败或输入不足时必须返回 `blocked` 或 `failed`，不得用普通正文伪装成功。

外部编排的 `build_argument_architecture` 必须遵循请求中的 `argument_architecture_requirements`。`source_grounded` 模式在 `artifact.content.proposed_chapters` 或 `artifact.content.report_scope_confirmation.chapter_mapping` 返回非空章节对象数组；每行含非空 `chapter_title` 和 `chapter_type=foundation|technical-research|conclusion`，至少一个技术章，可选 `chapter_id` 为唯一稳定字符串，可选 `chapter_no` 为唯一正整数。首章置首、总结置尾；这是已有章节映射的交接表示，不新增正式目录或改变原生写作规则。修订请求提供 `base_artifact` 和 `revision_instruction` 时保留原范围与规则，使用新请求编号返回修订artifact，由编排器追加版本并等待显式确认；不得直接修改工作流状态或已应用的版本。

### 0A.5 强制审核交接

在套件外部编排模式中，以下生成动作成功后必须设置审核交接：

```yaml
handoff_rules:
  generate_outline:
    skill_name: "report-reviewer"
    action: "review_outline"
  revise_outline:
    skill_name: "report-reviewer"
    action: "review_outline"
  generate_chapter:
    skill_name: "report-reviewer"
    action: "review_chapter"
  revise_chapter:
    skill_name: "report-reviewer"
    action: "review_chapter"
  assemble_report:
    skill_name: "report-reviewer"
    action: "review_report"
  revise_report:
    skill_name: "report-reviewer"
    action: "review_report"
```

具体要求：

- 目录生成或修改后，必须实际调用 `report-reviewer.review_outline`；
- 章节生成或修改后，先通过80%确定性字数门禁，再实际调用 `report-reviewer.review_chapter`；
- 完整报告组装或修改后，先调用 `scripts/normalize_markdown.py`，再实际调用 `report-reviewer.review_report`；
- 生成 Skill 的前置检查、脚本校验、写作约束检查和自检不能替代正式审核；
- 只有当前 `artifact_id + version` 获得结构化 `pass` 后，编排器才可以请求用户确认；
- 任何修改都必须产生新版本并重新审核，不得自行宣告审核通过。

### 0A.6 审核修改动作输入

`revise_outline`、`revise_chapter` 和 `revise_report` 必须接收：

```yaml
base_artifact:
  artifact_id: ""
  version: 1
  content: ""
review_result:
  reviewed_artifact_id: ""
  reviewed_version: 1
  decision: ""
  issues: []
  must_fix: []
  revision_instruction: ""
```

修改后返回完整新版本，并在 `metadata` 中提供：

```yaml
base_version: 1
change_summary: []
issue_resolution_map:
  - issue_id: ""
    resolution: ""
    status: "resolved | partially_resolved | unresolved"
```

### 0A.7 外部结构化接口文件

- `schemas/orchestration-request.schema.json`
- `schemas/generator-response.schema.json`
- `schemas/project-intake.schema.json`
- `schemas/chapter-content-briefs.schema.json`

外部 `build_project_profile` 请求必须携带已完成的四项固定问卷。`source_grounded` 模式下，外部 `generate_outline` 请求还必须携带已确认的逐章内容概述，并设置：

```yaml
preserve_existing_outline_rules: true
```

该字段只表示逐章内容概述是补充输入，不得改变本 Skill 原生固定目录规则。

# 电网科技报告生成 Skill

## 1. 主文件职责

本文件只负责调度，不重复展开目录、标题、公式、引用、摘要、正文风格和章节类型等详细规则。所有既有规则已迁移到阶段文件或保留在原专题文件中。

执行本 Skill 时必须做到：

- 严格按状态机推进；
- 每轮只完成一个阶段；
- 未经用户明确确认不得进入下一阶段；
- 只加载当前阶段需要的文件；
- 目录、章节计划和正文必须经过对应脚本校验；
- 最终 Markdown 组装后再调用确定性清洗脚本；
- 不得因为主文件缩短而忽略任何阶段文件中的既有规则。

首次加载本 Skill 后，读取：

1. `stages/00-interaction-control.md`；
2. `references/progressive-loading-map.md`；
3. 当前阶段对应的一个阶段文件。

不得在任务开始时一次读取全部 `references/`、`schemas/`、`templates/` 和 `examples/`。

---

## 2. 权威层级

存在重复说明时，按以下顺序确定执行来源：

1. **确定性校验层**：`scripts/*.py` 与 `schemas/*.schema.json`；
2. **当前阶段层**：`stages/*.md`；
3. **专题规则层**：`references/*.md` 与当前章节类型文件；
4. **输出格式层**：`templates/*`；
5. **示例层**：`examples/*`，只用于理解格式，不可覆盖规则。

主文件只决定“何时读取什么”。不得从多个重复位置自行拼接、改写或创造新规则。某项规则已有一个更具体的权威文件时，以该文件为准。

---

## 3. 阶段状态机

固定状态顺序如下：

```text
A  项目档案草案
B  中心主旨与论证架构
B2 逐章内容概述（仅 source_grounded）
C  目录与篇幅预算
C2 参考文献检索与第一章国内外研究现状组织
D0 当前章材料准备（条件阶段）
D  当前章章节计划
E  当前章或当前节正文
F  当前章确认与下一章交接
G  摘要、关键词、总结与展望
H  最终报告组装
```

状态跳转、确认语义、回退方式、一次回复限制和禁止行为全部以 `stages/00-interaction-control.md` 为准。

### 3.1 不可跳过的条件阶段

- `source_grounded` 模式下，B 后必须进入 B2；逐章内容概述确认前不得生成目录。
- 当前章材料不足且用户选择基于已有内容生成时，D 前必须进入 D0。
- C 确认后才能进入 C2 或 D。
- D 确认后才能生成 E。
- 所有主体章节确认后才能进入 G。
- G 确认后才能进入 H。

### 3.2 每轮结束

每轮只能提出一个明确的下一步动作。整章交接时允许把“确认当前章”和“同步提供下一章材料”合并为一个动作，其他阶段不得合并多个请求。

---

## 4. 阶段文件

| 当前工作 | 必读阶段文件 |
|---|---|
| 全局交互、状态、回退与禁止行为 | `stages/00-interaction-control.md` |
| 项目档案、中心主旨、论证架构、逐章内容概述 | `stages/10-project-and-argument.md` |
| 目录、篇幅、参考文献和第一章国内外研究现状组织 | `stages/20-outline-and-literature.md` |
| 章节材料准备与章节计划 | `stages/30-chapter-planning.md` |
| 章节或分节正文、章节确认 | `stages/40-chapter-writing.md` |
| 摘要、总结、最终组装 | `stages/50-abstract-and-finalization.md` |

详细专题文件、Schema、模板、脚本和示例的读取条件见 `references/progressive-loading-map.md`。

---

## 5. 项目级固定信息

项目档案阶段必须固定确认以下四项；材料中已有答案时直接回填，不重复询问：

1. 是否有任务书，以及本报告对应具体课题还是总报告；
2. 内容生成依据模式：`source_grounded` 或 `model_autonomous`；
3. 是否指定报告字数、模板或章节数量；
4. 是否可提供实验数据。

报告类型默认填写“科技项目结题技术报告”。不得询问用户偏向何种写作风格。

---

## 6. 目录与章节映射入口

目录阶段必须加载 `stages/20-outline-and-literature.md` 及其专题规则，并通过 `scripts/validate_outline.py`。

路由时至少识别：

- `total_report`：每一个课题对应一个技术章节；
- `specific_topic`：每一个来源研究内容小点对应一个技术章节；
- 第一章1.2.1“国外研究现状”和1.2.2“国内研究现状”采用一致的研究主题组织口径和作者指代样式；
- 每个技术章 X.1—X.N 核心研究小点默认分别生成2-4个三级标题，必要覆盖时单节最多5个；
- 目录标题、计划字数、80%最低验收字数和标题锁定信息完整登记。

以上仅为路由索引，不替代阶段文件中的完整规则。

---

## 7. 章节生成入口

章节计划阶段读取 `stages/30-chapter-planning.md`；正文阶段读取 `stages/40-chapter-writing.md`。每次只读取当前章所属的一类章节规则，不得预加载所有 `references/chapter-types/` 文件。

正文展示前至少检查：

- 已确认标题是否按原编号、名称、层级和顺序完整保留；
- 当前章或当前节字数是否达到计划字数的80%；
- 公式、符号、引用、语言和研究内容覆盖是否符合当前计划；
- 是否混入其他课题、其他章节或任务材料身份信息；
- 是否出现未经确认的数值、来源或具体技术名称。
- 是否已为每个研究内容提取核心技术主语，并保证X.1—X.N至少一节整体展开该主语且具有足够篇幅；
- 所有插图位置是否仅使用统一白框占位标记与图题，不在内容生成阶段直接绘图。

检查命令和适用条件见渐进式加载映射及阶段文件。

---

## 8. 摘要与最终组装入口

摘要阶段必须重新加载摘要规则、摘要证据 Schema 和模板。摘要证据包自目录确认后持续更新，不得在全文结束后临时概括。

当前摘要篇幅与双语输出规则：中文摘要正文总有效字数700—800字，第一段200—250字，第二段300—350字，第三段使用剩余篇幅完成结果、结论与前景；第一段按顺序词归纳挑战，第二段按对应顺序词说明技术点。同一次 `generate_abstract` 必须同时生成 `abstract_cn`、`keywords_cn`、`abstract_en`、`keywords_en`、3—5个 `opening_sentence_candidates_cn`、`selected_opening_sentence_cn`、`assessment_result_coverage` 和最多2项 `supplementary_metrics_used`。英文摘要忠实对应中文摘要，不新增技术、指标、结果或前景。 生成中文摘要前，先从电力业务对象/场景、现实痛点/能力缺口、目标业务能力等不同角度提出3—5个第一句候选，用户未另选时采用推荐句。摘要第三段只把任务书考核指标作为主要指标来源：定量指标写实际结果，定性指标写已形成能力、功能、成果状态、适用性或工程效果；非任务书其他指标默认不写，确有必要时全篇最多补1—2个。

最终组装时：

1. 按已确认标题锁定清单组装；
2. 运行标题、字数、引用、语言、公式和研究覆盖校验；
3. 全部模型内容与结构校验通过后，最后调用 `scripts/normalize_markdown.py`；
4. 确定性清洗完成后交付 Markdown 文件。

不得让大模型替代最终 Markdown 清洗脚本。

---

## 9. 示例与大型文件

- `examples/` 仅在格式不确定、用户要求或校验失败定位时读取；
- `templates/` 只在生成对应产物时读取；
- `schemas/` 只在建立或校验对应结构化数据时读取；
- `scripts/` 优先直接调用，不要求把完整代码放入模型上下文；
- 不得为了“熟悉全部规则”而一次读取所有大型文件。

---

## 10. 规则完整性审计

本次结构调整的迁移清单位于：

- `references/rule-migration-manifest-v3.6.0.json`；
- `scripts/validate_rule_restructure.py`。

该清单记录 v3.5.4 主文件中迁移规则块的目标文件和 SHA-256。结构调整后应运行校验，确认迁移块未被删减或改写。

旧版“开始任务时必须读取大量文件”的路由段已被 `references/progressive-loading-map.md` 取代；这是本次唯一针对加载方式的结构性变化，不改变原有报告规则。

---

## 11. 失败处理

出现以下任一情况时，不得继续生成后续阶段：

- 当前阶段文件无法读取；
- 上一阶段未明确确认；
- 当前结构化数据未通过 Schema 或脚本；
- 正文字数低于计划值的80%；
- 已确认标题缺失、改名、降级或乱序；
- 引用、公式、实验数据或内部事项证据状态不满足当前章节计划。

应停留在当前阶段，修复当前产物后重新请求一次确认。
