# Decision-Oriented Technical Report Contract

Use this reference when the output is a technical report rather than a formal
公文. It defines the writing brief and the handoff between `ds-document`,
`ds-write`, and `oral`; it does not require a separate project database or
evidence ledger.

## Contents

1. [Contract](#contract)
2. [Report spine](#report-spine)
3. [Options and recommendations](#options-and-recommendations)
4. [Evidence boundary](#evidence-boundary)

## Contract

Record:

```text
audience, decision_owner, decision_question, scope, time_horizon,
success_criteria, alternatives, constraints, risks, confidentiality,
delivery_format, review_deadline
```

If there is no decision to support, route to a research summary or `ds-write`
instead of manufacturing a recommendation section.

## Report spine

Prefer this order:

1. **执行摘要**: decision, two or three key findings, confidence and action.
2. **问题与范围**: what is included, excluded and assumed.
3. **证据基础**: sources, method, freshness, data quality and limitations.
4. **关键发现**: facts and analyses, each linked to evidence.
5. **选项与权衡**: cost, benefit, feasibility, risk, reversibility and owner.
6. **建议与实施**: preferred route, milestones, dependencies and stop criteria.
7. **风险与待验证问题**: what could change the recommendation.
8. **附录/来源**: reproducibility details, tables, definitions and references.

Put the recommendation after the evidence unless the audience explicitly needs
BLUF. Even with BLUF, keep the evidence boundary visible.

## Options and recommendations

Compare at least two realistic options when a decision is reversible or costly.
State why an option is preferred and what evidence would cause a change. Do not
rank options by unsupported precision. A recommendation is a proposal until the
named decision owner accepts it.

## Evidence and writing boundary

Each important claim should answer:

- What exactly was observed or sourced?
- What population, period, version or environment does it cover?
- What inference is allowed, and what remains unknown?
- Which next check would most reduce uncertainty?

Use `ds-write` only when claim strength, citations, external sources, datasets,
or reproducibility need explicit checking. Use `oral` after the core content is
stable to improve the story spine, executive summary, visual hierarchy, figure
and table roles, and anticipated objections. Keep technical logs, model traces
and raw data out of the executive summary; link them only when they help the
reader verify a decision.
