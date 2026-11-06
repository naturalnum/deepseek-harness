# Simulated Research Portfolio

## Contract

- Contract: `finance.simulated-portfolio.v1`
- Artifact: `research_portfolio`
- Required capabilities: `finance.security.read`, `finance.price.read`, `finance.portfolio.simulate`

## Inputs And Workflow

Use `user_input` once to confirm the `simulation_protocol`: symbols, weights, inception, executable price rule, benchmark, currency, fees, slippage, and rebalance policy. Do not silently choose missing high-impact values. Then call `finance_security_snapshot`, `finance_price_series`, the consent-gated `finance_research_portfolio`, and `science_artifact`.

Read the current portfolio revision before an update. Keep a stable portfolio id, optimistic revision, and idempotency key. Handle splits, dividends, FX, suspensions, and the first executable post-event price. Treat all positions and returns as research simulation only.

## Report And Decisions

Treat `provider_error`, timeout, and `retry_exhausted` as explicit partial reasons after the adapter retry budget. Continue independent evidence paths and publish a clearly limited partial report when reviewable evidence remains; block only when no reviewable route remains.

Publish `simulation_policy`, `performance`, `holdings`, `risk`, and `limitations`, a result summary, and `metric_strip`, `timeseries`, `data_table`, and `ranked_list` cards. Preserve policy, positions, transactions, performance, benchmark, contribution, exposure, coverage, and a versioned manifest in the Artifact.

The write call requires a single-use `finance_research_write` consent grant with matching run, action, resource, and confirmation hash. Accept `missing_price_history`, `coverage_incomplete`, or `benchmark_unavailable` as partial reasons. Stop as `blocked` on missing protocol consent or simulation capability.
