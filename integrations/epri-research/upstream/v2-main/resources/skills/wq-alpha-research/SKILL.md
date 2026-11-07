---
name: wq-alpha-research
description: Use as an optional implementation and evaluation reference for financial factor tasks. The active orchestration route is financial-factor-discovery plus ds-team.
---

# Alpha and Qlib Evaluation Reference

This skill supplies practical advice for implementing and measuring factors. It is intentionally not a second workflow and it does not own project state. New tasks are orchestrated by `financial-factor-discovery` and submitted through the single `factor_submit` MCP tool.

## When to read it

Read the smallest reference that answers the assignment:

- `references/qlib_research_workflow.md` for Qlib datasets, calendars, point-in-time fields, and evaluator setup.
- `references/factor_evaluation_alphalens_quantstats.md` for IC, RankIC, turnover, costs, drawdown, and stability.
- `references/vibe-trading-factor-methods.md` for readable factor briefs, experiment design, and user-facing charts.
- `references/data_connectors_openbb_akshare_tushare.md` for connector selection and data-gap diagnosis.
- `references/quant_platform_knowledge_sop.md` for WorldQuant/BRAIN-specific terminology only.

## Assignment contract

When a Lead assigns an evaluation or implementation task, return a concise handoff:

```json
{
  "assignmentId": "...",
  "workflowId": "finance.factor-mining.v1",
  "laneId": "assigned-lane-id",
  "roleTemplateId": "generic-data-auditor | xalpha-validator | ...",
  "roleKind": "xalpha | generic",
  "disposition": "accepted | refuted | inconclusive | blocked",
  "summary": "one concise outcome",
  "inputsUsed": ["relative/path/or/dataset-ref"],
  "outputs": ["metric, chart, code, or finding"],
  "limitations": ["missing field or unsupported check"],
  "nextRecommendation": "one concrete next action",
  "git": {"projectRoot":"/...","baseCommit":"...","branch":"...","headCommit":"..."},
  "producedAt": "ISO-8601 timestamp"
}
```

Every assigned role receives an isolated Git worktree for attribution. Return the exact base commit, branch, worktree path, and head commit even when analysis-only work leaves the worktree unchanged. Do not modify the Lead worktree.

## Evaluation boundaries

- Separate idea, static check, measured evaluation, sample-out-of-time result, and production/shadow status.
- Never turn an unavailable field into zero. If point-in-time filing dates, universe history, or costs are missing, state the gap and keep the result partial.
- Use the user-provided evaluator when one is specified. Record the relative path, runtime, and entrypoint in the handoff.
- Prefer a small, reproducible comparison over a large unreviewed search. One clear chart or table is more useful than a long tool log.

## Submission handoff

Only the Lead calls:

```text
factor_submit(action="submit", submission={...})
```

Include real metrics, chart/table artifacts, source references, limitations, and next actions. `factor_registry` and `factor_search` are historical compatibility tools; do not call them for a new assignment unless the user explicitly asks to resume an old run.
