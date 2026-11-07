# Report Templates

Use these as outlines, not mandatory forms. Remove a section when it has no
material content. The answer and the user's requested decision always outrank
the template.

## Financial research note

```text
Title: [question or decision, not a tool name]
Scope and as-of: [market/universe, period, currency, actual/estimate/scenario]

Executive answer
[One direct answer, stance or confidence, and the fact most likely to change it]

Key numbers and lead visual
[Metric strip or chart with units, denominator, period and source]
[One sentence: what the visual means for the question]

Drivers and analysis
[Regime/theme/company/event/factor modules that have real content]

Scenarios and invalidation
[Bull/base/bear or upside/base/downside; assumptions, triggers, horizon]

Decision boundary and next actions
[Conditional monitoring or research steps; no invented certainty]

Sources and method
[Primary sources, transformations, freshness and unresolved gaps]
```

## Scientific research report

```text
Title: [specific question or finding]
Abstract-style answer
[Question, decisive result, confidence and evidence boundary]

Question and scope
[Population/dataset, comparator, study period and hypothesis]
Key result and Figure 1
[Verified chart, table, source image or result card + nearby takeaway]
Methods and provenance
[Inputs, controls, software/data versions and reproducibility notes]
Results and interpretation
[Organized by question/hypothesis, observation separated from interpretation]
Limitations and next check
[Applicability, uncertainty, missing checks and smallest useful follow-up]
Conclusion
[What is supported, what remains open and the next action]
```

## Compact answer

For a narrow lookup, use: direct answer, scope/as-of, one supporting value or
source, one limitation, and the next useful action. Do not publish a full report
unless the user needs a durable or visual result.

## Worked examples

These examples demonstrate composition, not facts. Replace every bracketed
value, source, entity, date and conclusion with evidence from the current run.
Remove any module that the user did not ask for and that has no material result.

### Financial research example

```text
User question
Do power constraints materially change the AI data-centre capital-expenditure
outlook over the next two years?

Title
Power availability is becoming a regional execution constraint for AI capacity

Scope and as-of
United States; [as-of date]; [2023 actual] versus [2028 scenario range]; TWh.

Executive answer
Available evidence supports power availability as a material constraint in
[named regions], but not a conclusion that all planned AI capacity is blocked.
The most decision-relevant uncertainty is [interconnection/delivery variable],
so the thesis should be monitored through [specific observable trigger].

Lead visual
[2023 actual] beside [2028 low/base/high scenarios], with every bar labelled in
TWh and scenario endpoints identified as assumptions rather than forecasts.

Takeaway beside the visual
Even the low scenario requires a step-up from the historical level; the spread
between scenarios shows that delivery timing, not demand alone, drives the near-
term range.

Drivers and scenarios
- Base: [assumption] -> [observable implication].
- Upside: [assumption] -> [observable implication].
- Downside: [assumption] -> [observable implication].

Decision boundary
Revisit the conclusion when [grid queue], [equipment lead time], or [contracted
capacity] crosses the stated threshold.

Sources and method
[Primary source], [company filing], [calculation method], [known data gap].
```

Avoid replacing this path with a long evidence register. Evidence supports the
answer; it is not the answer. If valuation, price, or recommendation is outside
the request, omit those sections instead of inventing a broker-style template.

### Chinese broker-style research note (optional, illustrative)

Chinese industry and company notes are often longer than the compact template
above, but their reader path is still clear. Use this structure when the user
expects a Chinese sell-side or industry-research style note; keep it evidence-
bound and remove any empty section.

```text
标题
[公司/行业]：[一句话回答用户问题]

核心观点
[一到三条结论，每条都能回到一个数据、公告或明确假设]

投资要点
1. [业务或行业驱动] -> [可观察指标]
2. [竞争优势或供需变化] -> [对收入/利润/渗透率的影响]
3. [催化剂与时间窗口] -> [验证条件]

行业与公司分析
[行业空间、竞争格局、商业模式、公司经营数据；不把背景材料写成结论]

盈利预测与估值（仅在有数据或用户明确要求时）
[关键假设、收入/利润/现金流预测、估值方法与敏感性；标明实际/预测]

情景与风险
[乐观/基准/谨慎情景、触发条件、失效条件和需要跟踪的指标]

数据缺口与下一步
[哪些数据尚未覆盖、为什么重要、补齐后如何更新结论]

风险提示与免责声明
[研究边界、数据时效、模拟性质；不要把研究意见写成无条件投资建议]

数据来源与方法
[来源、发布日期/as-of、口径、计算步骤和可复现文件]
```

The Chinese labels are a style cue, not literal content to copy blindly. Keep
the answer and the user's requested decision above the evidence register. A
long report should be divided by these reader questions, with tables and charts
near the claim they support rather than collected in an appendix.

### Scientific research example

```text
User question
Does [intervention] improve [outcome] relative to [comparator] in [population]?

Title
[Intervention] changes [outcome] under [bounded condition]

Abstract-style answer
In [dataset/experiment, n], [intervention] changed [primary outcome] from
[control value] to [intervention value] ([effect and uncertainty]). This
supports [bounded conclusion], but [design limitation] prevents a broader
causal or population-level claim.

Figure 1
[Dot/interval, paired, subgroup, or time-series view chosen for the actual
comparison]. Label the outcome, unit, sample size, comparator, uncertainty and
analysis set.

Takeaway beside Figure 1
The effect is concentrated in [observed subgroup/condition]; the remaining
groups overlap the comparator and should not be described as confirmed effects.

Methods and provenance
[Dataset/version], [inclusion criteria], [control], [analysis], [software].

Results and interpretation
Observation: [measured result].
Interpretation: [what it may mean].
Alternative explanation: [credible competing account].

Limitations and next check
The smallest useful follow-up is [specific test] because it distinguishes
[main interpretation] from [alternative explanation].

Conclusion
[One supported answer], [one unresolved boundary], [one next action].
```

Do not copy a journal's full submission format into a normal user report. Apply
`ds-nature-figure` or `ds-paper-plot` only when the user needs a submission-grade
figure or manuscript package; otherwise preserve the shorter reader path above.

### Weak versus useful phrasing

```text
Weak: Evidence suggests the result may be important.
Useful: As of [date], [measured comparison] supports [bounded answer]; the
conclusion would weaken if [observable invalidation condition].

Weak caption: Figure showing the results.
Useful caption: [Outcome] by [group] in [analysis set]; points show [statistic]
and bars show [interval]. The separation is largest in [condition], which is the
main support for [answer].

Weak partial report: Some tools failed, so the analysis could not be completed.
Useful partial report: [Provider] was unavailable, so [specific metric] is not
covered. The report still answers [narrow question] from [remaining evidence];
[missing check] is the next action before broadening the conclusion.
```
