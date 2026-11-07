---
name: financial-factor-discovery
description: Use for financial factor exploration, evaluation, comparison, visualization, and handoff. Prefer fast, evidence-aware iteration over workflow ceremony.
---

# Financial Factor Discovery

Contract: `finance.factor-research.v1`.

<!-- Compatibility vocabulary for the routed contract and report renderer: factor_research, factor_submit, protocol, result, visuals, evidence, limitations, result summary, metric_strip, timeseries, data_table, change_factor_protocol, high_cost_backtest, external_submission, promote_factor, runtime_unavailable, data_invalid, exploration_incomplete, evaluation_pending, data_gap. These are not mandatory workflow stages. -->

Find the strongest justified next factor result with the fewest expensive steps. The user wants research progress, not a second project-management system.

## Operating loop

1. State the objective in one sentence: universe, as-of boundary, horizon, available data, and requested output.
2. Inspect the project/data once. Build a baseline or first candidate early; do not wait for a complete literature or Team survey.
3. Choose independent mechanism families that can change the decision. If parallel work adds information, create bounded WorkItems with `team_delegate`, never exceeding the preset reasoning concurrency. Every assignment needs a distinct assignee, candidate-id namespace, objective, acceptance criteria, and expected delivery. Duplicate Micro roles are appropriate only for disjoint mechanism or mutation families.
4. Iterate on evidence. A Worker may return a candidate, data audit, implementation, comparison, chart/table, or precise blocker. Choose the cheapest decisive evidence or falsification; failed candidates are evidence and do not stop unrelated routes.
5. Funnel candidates through one frozen `factor_lab` protocol: broad screening on development, survivors on validation, then at most one locked-test evaluation for the final unchanged candidate or pool. Let `evaluate_batch` persist every result and failure, then hand off the selected result once with `factor_submit`.

The runtime owns roster ids, signed Worker identities and tool policies, delivery receipts, retries, and ordinary status updates. Do not create a roadmap, campaign state machine, checkpoint, or progress poll for every wave. `factor_lab` owns the candidate/evaluation ledger and canonical Portfolio projection; do not maintain a duplicate workflow database.

## Hard evidence boundary

- Keep development, validation, and locked test data separate. Never use the locked test set to choose or mutate a factor.
- Do not claim point-in-time safety, no future leakage, or measured performance unless the selected data adapter actually tested it.
- Never replace a failed controlled data source with general web search unless the user explicitly asks for literature-only exploration.
- A missing package, provider error, timeout, empty coverage, or unavailable dataset is a visible limitation. Change the method or continue an independent route; do not wait indefinitely or invent values.

## Team and roles

The system preconfigures the XAlpha role prompts. Use them as tools, not as mandatory stages:

- `xalpha-report-to-memory`: extract attributable mechanism lessons from supplied reports.
- `xalpha-macro-brain`: propose a small, falsifiable mechanism slate.
- `xalpha-micro-brain`: implement or mutate one candidate.
- `xalpha-cross-brain`: compare candidates or synthesize complementary evidence.
- `xalpha-validator`: run the cheapest decisive data, leakage, cost, or stability check.

Assignments should contain only the objective, exact Git assignment when code attribution is needed, acceptance and failure criteria, expected delivery, and an idempotency key. Do not repeat role constitutions or project-root metadata that Core already owns. Workers deliver through `team_submit`; only the Lead calls `factor_lab` and `factor_submit`. A Worker must not write the Portfolio, protocols, evaluation records, metric values, or submission files.

If a Worker fails, is cancelled, becomes unhealthy, or completes without delivery, Core must wake the Lead. Retry once with a changed assignment, reassign, or continue with verified work. Never leave the Lead waiting for a silent Worker.

## Canonical evaluator

`factor_lab` owns the immutable protocol and evidence receipt. Inspect its metric packs and validate without writing when useful. Register one protocol only when no compatible frozen protocol exists:

```text
factor_lab(action="list_metric_presets")
factor_lab(action="validate_protocol", protocol={dataset:..., splits:[development, validation, locked_test], metricPresetId:"validation", ...})
factor_lab(action="register_protocol", protocol={...})
factor_lab(action="evaluate_batch", protocolId="...", batchId="...", candidates=[...], splitId="development")
```

Use development or validation splits for candidate populations. A `locked_test` batch must contain exactly one unchanged final factor or fixed pool and may be consumed only once.

The built-in backend accepts a project-relative CSV or JSON table mapped to `date`, `asset`, `factor`, and `future_return`, with optional benchmark return, eligibility, and a separate universe table. Choose `screening` for IC/RankIC/stability/coverage/turnover, `validation` for cost-aware return and risk, or `portfolio` when benchmark-relative IR/excess return is available. The evaluator emits cumulative return, benchmark, drawdown, RankIC, turnover, and coverage series for the Viewer. `future_leakage_audit` remains `not_run` and the result remains `partial` unless the adapter supplies timestamp/field-lineage proof.

## Main Agent versus sub-agent

| Actor  | May call                                                                                                       | Must not call                                                                          | Required output                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Lead   | Core Team WorkItems; all `factor_lab`; one `factor_submit`; project checkpoint/report after selection | duplicate ledgers or repeated status polling                                           | frozen protocol, candidate ids/lineage, batch decisions, final handoff                             |
| Worker | injected read/evidence tools; `team_progress`; one `team_submit`                                      | `factor_lab`, `factor_submit`, `factor_search`, `factor_registry`, checkpoint, publish | compact hypothesis/formula batch or audit, limitations, evidence, exact Git attribution if changed |

Suggested population wave: one Macro route defines disjoint mechanism families; 3-8 Micro routes each produce 3-8 formulas inside one assigned family; one Validator route audits data and falsification criteria. The Lead deduplicates ids and formula structure, runs one comparable batch, and only then launches repair or crossover routes for measured failures. More Workers should increase hypothesis breadth, not create more databases or evaluation protocols.

Qlib Recorder, AlphaGen, AlphaEval, RD-Agent, QuantaAlpha, and KunQuant are optional producers. They may prepare candidates or exports, but their output must be evaluated under the same frozen protocol and never becomes a second source of truth. A successful batch automatically updates `factor-research/portfolio.json`; `factor_search` and `factor_registry` are legacy tools and should be called only when explicitly resuming an old run.

## Handoff

Call exactly one terminal submission for the strongest reviewable result:

```text
factor_submit(action="submit", evaluationId="eval-...", submission={
  title: "...",
  objective: "...",
  limitations: ["..."],
  nextActions: ["..."]
})
```

The server resolves factor identity, protocol, dataset snapshot, measured metrics, chart series, result hash, and receipt, and writes `factor-research/submissions.json`. Do not repeat those machine-owned ids or copy metrics into the call. If evaluation cannot run, submit `partial` or `blocked` with the exact missing condition and recovery action; unknown metrics are omitted, never set to zero.

Use Git only for attributable code/data changes in the authorized project workspace. A commit is useful evidence, not a reason to stop research or to create a new branch/worktree for every micro-attempt. Keep raw caches, secrets, and large data outside Git.

## References

Read only what the current assignment needs:

- `references/prompt-assembly.md` for role routing.
- `references/evaluation-adapters.md` for Qlib and optional producer boundaries.
- `../wq-alpha-research/references/qlib_research_workflow.md` for a Qlib data/evaluator route.
- `../wq-alpha-research/references/vibe-trading-factor-methods.md` for practical factor metrics and presentation.
- `../wq-alpha-research/references/financial-mode-publish-contract.md` when a formal report is requested.
- `references/xalpha-upstream-prompts/` for one selected role template, never the full snapshot at once.

Reply in the user's language with: what ran, the strongest result or blocker, the decision, and the next action.
