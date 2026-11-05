# News Impact Chain

## Contract

- Contract: `finance.news-impact.v1`
- Artifact: `event_impact`
- Required capabilities: `finance.news.read`, `finance.relationship.derive`, `finance.price.read`

## Inputs And Workflow

Establish the event cutoff, publication and revision timestamps, affected markets, timezone, currency, and event window. Verify the original event with `finance_news_events`; then call `finance_relationship_map`, `finance_security_screen`, `finance_price_series`, and `science_artifact`.

Classify each path as demand, supply, valuation, liquidity, regulation, competition, or sentiment. Map upstream, downstream, competitors, substitutes, and cross-market securities. Every relationship edge must carry Evidence ids. Price and volume within the event window can confirm co-movement but do not prove causality.

## Report And Decisions

Treat `provider_error`, timeout, and `retry_exhausted` as explicit partial reasons after the adapter retry budget. Continue independent evidence paths and publish a clearly limited partial report when reviewable evidence remains; block only when no reviewable route remains.

Publish `event_facts`, `impact_paths`, `price_confirmation`, `counterevidence`, and `limitations` with `ranked_list`, `timeseries`, and `evidence_list` cards.

Require `create_simulated_portfolio` before a simulation and `route_to_factor_research` before creating an `idea` candidate. Accept `price_series_unavailable`, `relationship_incomplete`, or `coverage_incomplete` as partial reasons. Stop as `blocked` if the source event cannot be verified or an always-required capability is absent.
