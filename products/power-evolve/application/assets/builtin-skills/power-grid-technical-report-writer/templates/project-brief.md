# 项目档案草案

- 报告题目：{{report_title}}
- 报告类型：{{report_type}}（默认：科技项目结题技术报告）
- 报告主题属性：{{report_theme_type}}  <!-- evaluation-related / non-evaluation；模型根据核心研究主题自动判定，不新增用户问项 -->
- 内容生成依据模式：{{content_generation_mode}}
- 项目背景：{{project_background}}
- 应用场景：{{application_scenario}}
- 总体问题初步理解：{{overall_problem}}
- 目标读者：{{target_readers}}
- 报告用途：{{report_purpose}}
- 已知研究内容：
{{research_contents}}
- 可使用材料：
{{available_materials}}
- 已知数据和结果：
{{known_data_and_results}}
- 目标篇幅：{{target_length}}
- 输出格式：{{output_format}}
- 特殊要求：
{{special_requirements}}
- 当前暂定假设：
{{assumptions}}

## 四项固定确认信息

1. 任务书与报告范围：{{task_book_scope}}
   - 是否有任务书：{{has_task_book}}
   - 对应任务书具体课题还是总报告：{{task_book_topic_or_total_report}}
   - 总报告规则：每个课题对应一个技术章；具体课题报告规则：每个研究内容小点对应一个技术章
2. 内容生成依据模式：{{content_generation_mode}}
3. 指定报告要求：
   - 报告字数：{{target_length}}
   - 指定模板：{{specified_template}}
   - 指定章节数量：{{specified_chapter_count}}
4. 可提供的实验数据：{{experimental_data_availability}}

> 已从附件或用户消息识别的答案直接回填并请用户确认；没有答案时写“待用户补充”。用户可以明确回答“没有”“不指定”或“暂不提供”。四项全部明确后项目档案才可确认。

## 内容生成依据模式

尚未选择时，请从以下两种方式中选择一次：

1. **基于已有内容生成**：每章计划前提供该章已有材料，模型主要负责整理、重构、补充解释和报告化表达；
2. **交由大模型自行生成**：模型根据已确认研究范围、已有材料、核验文献和电力工程逻辑自主设计并撰写。

选择后默认沿用，不会每章重复询问。后续可以随时回复“本章交给模型生成”“后续都交给模型生成”或“后续恢复根据已有内容生成”进行切换。

## 当前需要确认的关键点

{{missing_information}}

> 不询问写作风格偏好。除非用户明确指定其他成果类型，否则按“科技项目结题技术报告”推进。

> 请一次性确认或补充项目档案及四项固定信息。四项全部明确后，再进入中心主旨与论证架构阶段。
