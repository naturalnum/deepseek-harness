# Company Research

## Contract

- Contract: `finance.company-research.v1`
- Artifact: `company_research`
- Required capabilities: `finance.security.read`, `finance.price.read`, `finance.news.read`

## Inputs And Workflow

Establish company identity, exchange, symbol, comparison basis, `asOf`, timezone, currency, and window. Use `finance_sector_search` to disambiguate, then call `finance_security_snapshot`, `finance_price_series`, `finance_news_events`, and `science_artifact`.

Preserve financial period, filing publication time, and data availability time to prevent look-ahead. Separate issuer disclosures, third-party estimates, and model inference. Comparisons must use the same currency, period, accounting basis, and valuation date.

## Report And Decisions

Treat `provider_error`, timeout, and `retry_exhausted` as explicit partial reasons after the adapter retry budget. Continue independent evidence paths and publish a clearly limited partial report when reviewable evidence remains; block only when no reviewable route remains.

Publish `identity`, `financials`, `price`, `events`, `risks`, and `limitations` with `metric_strip`, `timeseries`, `data_table`, `ranked_list`, and `evidence_list` cards.

Require `resolve_ambiguous_security`, `change_comparison_basis`, or `create_watchlist` only when the corresponding decision is needed. Accept `financials_unavailable`, `price_series_unavailable`, or `news_unavailable` as partial reasons. Stop as `blocked` when the security cannot be resolved or the core snapshot capability is unavailable.

For the report handoff, use the optional `company-research-report-map` reference
from `ds-financial`: lock the data boundary, compute derived values from the
returned envelope, and then publish only the evidence-backed cards and sections
needed by the user's question. Do not force every section or write a manual
HTML dashboard.
