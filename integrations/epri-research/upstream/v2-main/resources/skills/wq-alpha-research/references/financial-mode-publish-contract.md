# Financial Mode Factor Publish Contract

## Contract

- Contract: `finance.factor-research.v1`
- Artifact: `factor_research`
- Base capability: `finance.factor.research`
- Conditional tools: Core Team WorkItems for bounded XAlpha/generic exploration; `factor_lab` for one frozen canonical evaluation; `factor_submit` once for the Lead-owned handoff; `science_artifact` only when a formal report is requested

## Workflow

Verify a bound/write-capable `project_workspace(action="status")` receipt or an explicit read-only `unbound_read_only` gate. Select the existing WQ, Qlib, generic Python/notebook, evaluation, or portfolio SOP without changing its scientific protocol.

Record only work that actually ran. Never infer metrics from prose. For `mine`, retain Worker handoffs and exact Git commits; a search score is discovery context, not proof. Freeze the evaluation contract before canonical measurement. The single `factor_submit` call should normally contain only the returned `evaluationId`; the server resolves protocol, data snapshot, metrics, curves, hash, and receipt. It may be `complete`, `partial`, or `blocked`.

## Dual Delivery

When a report is requested, publish only the roles supported by actual evidence and expose missing robustness or leakage work as limitations. A factor handoff is not required to claim validation: it should answer the user's question first and show the strongest available chart/table, then state what remains to be checked.

Use gates only when the requested action truly needs them: `change_factor_protocol`, `high_cost_backtest`, and `external_submission`. Accept `runtime_unavailable`, `data_invalid`, `exploration_incomplete`, `evaluation_pending`, or `data_gap` as partial reasons. A provider may supply an observation, but it cannot turn an unmeasured factor into a validated claim.
