# Market Theme Scan

## Contract

- Contract: `finance.market-theme.v1`
- Artifact: `market_theme`
- Required capabilities: `finance.market.read`, `finance.sector.read`, `finance.security.screen`

## Inputs And Workflow

Establish `asOf`, markets, timezone, currency, window, asset universe, and optional watchlist. Then call `finance_market_overview`, `finance_sector_movers`, and `finance_security_screen` in that order. Call `finance_news_events` when claiming a catalyst and `finance_price_series` when claiming price confirmation. Register sources, then call `science_artifact`.

“这些股票”, “值得关注的股票”, “相关标的”, and similar collective wording do not create a company-research subtask when no company or ticker was named. Treat the bounded `finance_security_screen` candidates as the list to aggregate inside this market-theme run. This matches the provider rule that market-wide or theme screens use the market/sector screen rather than repeated company lookup.

After each finance read, inspect its normalized envelope before continuing. `available`, `market_closed`, and contract-allowed partial data may continue with explicit limits. A missing tool is an immutable conversation-runtime fault; a present tool that reports configuration, connection, or version failure is an adapter/runtime fault. Report the exact gap once, continue the remaining independent tools, and do not blame an unconfigured user setting or publish an empty Report.

Each read is independently degradable. After the adapter retry budget, a `provider_error`, connection failure, timeout, or `retry_exhausted` is recorded once and that read is skipped; continue other independent reads, user-provided data, or primary-source evidence. Omit unsupported candidate/ranking claims rather than filling them from generic web prose. If the remaining evidence is reviewable, publish a `partial` report with the missing read and its limitation; block only when no reviewable evidence remains.

Separate market status, breadth, themes, candidate securities, catalyst evidence, price confirmation, and counterevidence. A news match is not price confirmation; missing data is not no movement; a closed market is `market_closed`.

## Report And Decisions

Publish Report roles `market_status`, `themes`, `evidence`, and `limitations`, with at least `ranked_list` and `evidence_list` cards. Open the stable Market Theme Preview for full detail.

Viewing, filtering, and sorting require no confirmation. Require the `change_research_scope`, `create_watchlist`, or `create_monitor` gate before those changes. Treat `provider_error`, connection failure, timeout, and `retry_exhausted` as explicit runtime limitations alongside `market_closed`, `coverage_incomplete`, `news_unavailable`, and `price_series_unavailable`. Stop as `blocked` only when an always-required capability is unavailable and no reviewable alternative remains.
