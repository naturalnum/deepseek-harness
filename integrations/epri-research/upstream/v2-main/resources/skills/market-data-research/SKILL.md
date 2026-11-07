---
name: market-data-research
description: Use after ds-financial routing for cross-market research backed by the optional market-data and simulation capability, including market-theme scans, sector movers, news-impact chains, company research, simulated research portfolios, anonymized holdings diagnosis, and scheduled monitoring. Do not use it for ordinary factor validation, real trading, or bypassing wq-alpha-research and factor_registry.
---

# Market Data and Simulation Research

Use DeepScientist as the research owner and the configured provider only as a bounded financial data and simulation capability.

## Route The Task

- The runtime `Financial Task Route` block is authoritative. Continue only when it selects `market-data-research`, the provider status is configured, and the exact contract reference is present. Read only that contract's `sopReference`; never choose a different contract or invent its hash.
- Read `references/market-theme-scan.md` for market breadth, movers, and daily themes.
- Read `references/news-impact-chain.md` for event-to-sector-to-security analysis.
- Read `references/company-research.md` for a company, valuation, financials, price, and events.
- For `finance.company-research.v1`, also read the optional `company-research-report-map` reference from `ds-financial`; the runtime contract remains authoritative.
- Read `references/simulated-research-portfolio.md` for watchlists and simulated portfolios.
- Read `references/holdings-screenshot-diagnosis.md` for anonymized screenshots or imported holdings.
- Read `references/continuous-monitoring.md` for recurring updates.
- Read `references/provenance-permissions-compliance.md` before cloud image processing, scheduled work, or research writes.
- Read `references/finance-tool-map.md` only when choosing or repairing tool calls.
- Read `../financial-report-research/references/vibe-trading-research-sop.md` progressively for long-running goals, backtest/calculation diagnosis, valuation/risk modules, and user-facing progress. It contains adapted methodology, not additional tool names or a replacement contract.

## Shared Rules

1. Verify the exact runtime contract reference and the project status receipt produced by `ds-financial` before a bound or write-capable finance call; otherwise verify the explicit `unbound_read_only` gate.
2. Use only the stable `finance_*` names in `references/finance-tool-map.md`. Never call raw provider endpoints. Never use shell, source-code search, generic tool discovery, or prior session logs to look for a missing finance tool.
3. Start with the first always-required finance read in the selected SOP. A missing named tool means the immutable conversation runtime was created without its required finance MCP; do not mislabel it as a user provider-setting error. If a tool exists but its envelope reports `provider_error` with `disabled`, `endpoint_missing`, `endpoint_rejected`, `incompatible_version`, or connection/timeout failure, report that exact adapter/runtime fault once, mark the tool unavailable, and skip it after the adapter's bounded retry policy. Continue independent finance tools, user-provided data, and primary-source evidence; do not invent the missing prices, rankings, or coverage. Publish a clearly labelled `partial` result when reviewable evidence remains, and emit `blocked` only when no reviewable route remains. Do not retry outside the adapter budget or create an empty report.
4. Establish market, timezone, currency, time window, and `asOf` before interpreting results.
5. Distinguish reported facts, inference, price confirmation, counterevidence, missing data, stale data, market closure, and `no_change`.
6. Prefer original filings and primary sources. Preserve source ids, retrieval time, upstream revision, coverage, and warnings.
7. Ask only questions that materially change the protocol. Prefer one structured request with at most three questions.
8. Do not call simulation writes, cloud image processing, or scheduled monitoring without a runtime-issued consent grant. Never invent a decision token.
9. Treat every portfolio as a research simulation. Never place or imply a real trade or investment advice.
10. After reviewable specialist data exists, follow `ds-financial`'s report publication pattern: register receipts, Evidence, claims, and versioned Artifacts, then deliver the explicit shared Science Report with bounded `card_ref` summaries and Artifact refs for full detail. Read each successful finance envelope's `reportSuggestions`, but treat them as advice rather than a fixed dashboard specification. Select the smallest useful set of cards for the current question and actual data, and set the runtime guide's compatible `moduleId` on each draft so it is placed in the Report. An Artifact or Financial Research Viewer event alone is not the final report.
11. Before composing `financeCompletion`, call `science_artifact(action="status", payload={"financeTaskContractId":"<exact runtime id>"})` once and follow its `financeCompletionGuide`. Put the manifest directly at `science_artifact.payload.financeCompletion`; never nest it inside the report or a generic `completion` field.
12. Run Finance publish preflight once after all required objects and any material project checkpoint exist. Use its `cardAuthoring` guide and normally submit `payload.cardDrafts`; the service materializes safe, versioned cards from the run's Artifact and Evidence. Repair an actionable gap once; otherwise preserve `partial` or `blocked`. Except for an early terminal preflight failure or monitor `no_change`, finish with exactly one `science_artifact(action="publish", displayIntent="open")` that carries the report, card drafts or exact cards, and completion manifest.
13. Convert a market observation to an `idea` factor candidate only after confirmation, then return to `wq-alpha-research` and `factor_registry` for validation.
14. Checkpoint only material project changes. Do not commit caches, licensed raw data, secrets, private screenshots, or an unchanged tree.
15. Keep progress useful without growing the conversation indefinitely. Emit one compact update per material transition, update cards by stable id, retain only the latest five live progress items, and move full tables, charts, provider details, and provenance into expandable report/viewer sections. A provider failure should replace the active progress row with one clear warning rather than leaving a permanent spinner.
