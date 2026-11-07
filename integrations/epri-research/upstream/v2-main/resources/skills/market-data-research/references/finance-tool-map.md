# Market Data and Simulation Tool Map

Use only the stable DeepScientist tools below. Never call raw provider endpoints directly.

| Tool                         | Purpose                                       | Side effect                      |
| ---------------------------- | --------------------------------------------- | -------------------------------- |
| `finance_market_overview`    | Market indices and status                     | Read only                        |
| `finance_sector_search`      | Sector and symbol disambiguation              | Read only                        |
| `finance_sector_movers`      | Sector breadth and movers                     | Read only                        |
| `finance_security_screen`    | Bounded security candidates                   | Read only                        |
| `finance_security_snapshot`  | Profile, quote, financial, valuation snapshot | Read only                        |
| `finance_news_events`        | Bounded news and event lookup                 | Read only                        |
| `finance_price_series`       | Adjusted historical series                    | Read only                        |
| `finance_relationship_map`   | Evidence-linked derived relationship graph    | Read only                        |
| `finance_research_portfolio` | Watchlist and research simulation state       | Consent-gated write except `get` |
| `finance_holdings_parse`     | Redacted structured/local/cloud parsing       | Cloud path is consent-gated      |

## Adapter Mapping

The local sidecar, not the Agent, maps the stable tools to bounded provider capabilities:

| Stable tool                  | Audited upstream capability                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `finance_market_overview`    | `get_market_overview`                                                                       |
| `finance_sector_search`      | `search_sector_taxonomy`                                                                    |
| `finance_sector_movers`      | `get_sector_movers`                                                                         |
| `finance_security_screen`    | `screen_market_stocks`, or `filter_sector_constituents` after an exact taxonomy resolution  |
| `finance_security_snapshot`  | `search_company_ticker` only for a named company, then batched quote/financial capabilities |
| `finance_news_events`        | `get_ticker_news_and_events`                                                                |
| `finance_price_series`       | `get_ticker_price_trends`                                                                   |
| `finance_relationship_map`   | DeepScientist evidence-linked derivation; no raw upstream equivalent                        |
| `finance_research_portfolio` | Research portfolio services behind DeepScientist consent gates                              |
| `finance_holdings_parse`     | DeepScientist redaction/import boundary; no raw upstream equivalent                         |

Preserve these provider constraints in the adapter: a generic theme or collective phrase such as “these stocks” is not a company lookup; market-wide screens use `screen_market_stocks`; a taxonomy basket must copy canonical ids from `search_sector_taxonomy`; and candidate ticker calls should be batched where the provider permits it. Never point the DeepScientist endpoint directly at an unwrapped dashboard or MCP server.

Every successful result must use `deepscientist.finance.result.v1` and include request id, data status, `asOf`, retrieval time, timezone, stale/partial flags, warnings, source refs, and bounded data. Preserve zero values. `no_data`, `no_change`, `market_closed`, `permission_denied`, and `provider_error` are distinct states.

Use `research_evidence` for sources, `science_artifact` for structured versions and the Report, `project_workspace` for approved Git status/checkpoints, `user_input` for decisions, and existing `cron` for monitors. Do not expose a raw trading, shell, terminal, code execution, broker, account, or provider-write tool.
