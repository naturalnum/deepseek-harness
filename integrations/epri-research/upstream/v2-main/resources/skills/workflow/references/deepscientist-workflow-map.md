# DeepScientist Workflow Map

Use this reference when the next research stage is not obvious or when several
DeepScientist `ds-*` skills might apply.

## Stage Router

For a sealed IOAI task, keep this native router and apply
[ioai-competition-stage-profile.md](ioai-competition-stage-profile.md). Do not
route through a separate competition research workflow.

| Project state | Use skill | Expected durable output |
|---|---|---|
| Existing project state is messy or resumed | `ds-intake-audit` | trusted state packet, reusable assets list, next anchor |
| Research frame is unclear | `ds-scout` | objective frame, metric/data/baseline shortlist |
| Comparator is missing or untrusted | `ds-baseline` | baseline contract, metric contract, accepted/waived/blocked gate |
| Baseline exists but direction is unclear | `ds-idea` | small candidate frontier, selected falsifiable route |
| Algorithm-first improvement needs bounded search | `ds-optimize` | candidate board, promoted move, frontier update |
| Selected route is ready for real work | `ds-experiment` | implementation/run manifest, outputs, validation, claim update |
| Main result needs ablation or robustness | `ds-analysis-campaign` | bounded slice plan, slice results, aggregate route decision |
| Evidence is mixed or next action is non-trivial | `ds-decision` | route decision, rejected alternatives, next action |
| Evidence should become a paper/report | `ds-paper-outline`, then `ds-write` | paper contract, outline, manuscript/report draft |
| Draft needs skeptical audit | `ds-review` | review report, revision log, follow-up TODOs |
| External reviewer pressure exists | `ds-rebuttal` | response matrix, action plan, response letter |
| Figure/table is a reusable deliverable | `ds-paper-plot`, `ds-figure-polish`, or `ds-nature-figure` | figure artifact, source code, caption, render QA |
| Data availability or Nature-style prose/deck is needed | `ds-nature-data`, `ds-nature-polishing`, `ds-nature-paper2ppt` | statement, polished text, or PPTX artifact |
| Work should stop, pause, publish, or hand off | `ds-finalize` | claim ledger, limitations, resume packet, closure decision |

## Group Boundaries

Research workflow main chain:
`ds-intake-audit`, `ds-scout`, `ds-baseline`, `ds-idea`,
`ds-optimize`, `ds-experiment`, `ds-analysis-campaign`, `ds-decision`,
`ds-finalize`.

Writing and paper production:
`ds-paper-outline`, `ds-write`, `ds-review`, `ds-rebuttal`,
`ds-nature-data`, `ds-nature-polishing`, `ds-nature-paper2ppt`.

Figure and display production:
`ds-paper-plot`, `ds-figure-polish`, `ds-nature-figure`.

Support:
`ds-science` for scientific package/runtime discipline and
`ds-alphaxiv-paper-lookup` for AlphaXiv paper summaries.

## Minimal Evidence Outputs

Every stage should leave at least one of:

- evidence record: source, dataset, command log, validation, decision, or user
  input;
- artifact record: figure, table, notebook, manuscript, PDF, code bundle,
  run bundle, or report page;
- provenance edge: why one object depends on another;
- graph warning: unresolved assumption, missing file, stale result, or blocked
  validation.

Do not treat a workflow stage note as a scientific claim. Stage notes explain
process; claims need concrete evidence.

## Routing Rules

- Prefer one active stage at a time.
- If the current state is stale, use `ds-intake-audit` before widening ideas or
  editing manuscript text.
- If no accepted baseline exists, do not jump to `ds-idea` or `ds-experiment`
  unless the baseline gate is explicitly waived and recorded.
- If a figure is only a quick diagnostic plot, do not route to `ds-paper-plot`
  or `ds-nature-figure`.
- If manuscript text would overstate evidence, route to `ds-review`,
  `ds-decision`, or `ds-analysis-campaign` before `ds-write`.
- If a branch should be promoted, abandoned, merged, or used as the next base,
  route through `ds-decision` or `ds-finalize`.
