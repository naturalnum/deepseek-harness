# Factor Evaluation Adapter Boundary

DeepScientist owns the canonical protocol, evaluation record, chart series, result hash, and signed receipt. External projects are optional compute adapters; they do not own submission state.

## Canonical exchange

Every adapter must consume:

- a frozen `deepscientist.financial_factor.protocol.v1` document;
- an immutable dataset snapshot or a project-local table whose SHA-256 matches the protocol;
- one factor id and implementation reference;
- exactly one requested split.

Every adapter must return enough data for `factor_lab` to materialize:

- scalar metrics with explicit units and measurement basis;
- dated series for cumulative long-short return, benchmark, RankIC, turnover, drawdown, and coverage when available;
- machine checks for data coverage, protocol freeze, leakage audit, cost model, and run completion;
- exact input/config/code hashes and warnings.

An adapter result is not a submission. Import or translate it into one canonical evaluation, then call `factor_submit` with only that `evaluationId`.

## Adapter routing

| Adapter                                                                                                                           | Use it for                                                                   | Required hardening before canonical import                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Qlib](https://github.com/microsoft/qlib) and [Recorder](https://github.com/microsoft/qlib/blob/main/docs/component/recorder.rst) | Expressions, signal analysis, portfolio analysis, transaction-cost backtests | Freeze provider URI, calendar, instruments, segments, recorder config, predictions, and code commit. Export metrics and dated series. |
| [AlphaGen](https://github.com/ICT-FinD-Lab/AlphaGen)                                                                              | Single-factor and factor-pool IC diagnostics                                 | Translate its expression/data conventions, record the exact pool, and do not treat example backtests as production validation.        |
| [AlphaForge](https://github.com/dulyhao/AlphaForge)                                                                               | Candidate generation and dynamic combination experiments                     | Isolate its older environment and import only measured outputs with pinned dependencies.                                              |
| [AlphaQCM](https://github.com/ZhuZhouFan/AlphaQCM)                                                                                | Distributed AlphaGen-style candidate generation                              | Treat it as a search producer, then rerun accepted candidates with the canonical evaluator.                                           |
| [AlphaEval](https://github.com/LeoDingggg/AlphaEval)                                                                              | Comparing factor-mining algorithms                                           | Pin its experimental configuration and export per-factor results rather than adopting its experiment state as project truth.          |
| [RD-Agent](https://github.com/microsoft/RD-Agent)                                                                                 | Research/implementation feedback loops                                       | Use only when its orchestration adds value; do not run a second agent authority beside ds-team. Import its code/result artifacts.     |
| [QuantaAlpha](https://github.com/QuantaAlpha/QuantaAlpha)                                                                         | Trajectory evolution and independent Qlib experiments                        | Audit date segments and provider configuration before accepting any metric.                                                           |
| [KunQuant](https://github.com/Menooker/KunQuant)                                                                                  | High-throughput formula compilation and execution                            | Treat compilation as syntax/execution evidence, not proof against future leakage.                                                     |

## Data adapters

Do not bundle credentials, licensed market data, or a downloader that silently changes a snapshot. A data adapter may download public or user-authorized data into a project-owned staging path, but it must:

1. record provider, query, as-of time, calendar, universe, and raw-file hashes;
2. produce a normalized CSV/JSON table or a pinned Qlib provider directory;
3. assign a new snapshot id whenever any byte or selection rule changes;
4. keep development, validation, and locked-test boundaries explicit;
5. never expose locked-test labels to candidate generation.

For private data, prefer a project-local normalized table. DeepScientist reads it locally, stores only hashes and project-relative references in the evaluation record, and does not upload the table through `factor_submit`.

## Reliability rules

- Re-registering the same frozen protocol is idempotent; changing it requires a new protocol id.
- A locked-test split is evaluated once per factor/protocol pair. Reuse the existing evaluation for submission.
- A missing or unverifiable evaluation creates a visible partial-risk handoff and cannot contribute measured metrics.
- A table evaluation cannot prove point-in-time field availability. Keep `future_leakage_audit=not_run` until field lineage or prefix-invariance evidence exists.
- Optional adapters may fail without blocking the table backend. Report the adapter failure and use another authorized route only when the protocol remains equivalent.
