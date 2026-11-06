# Financial Report Module Cookbook

This reference helps choose a small, evidence-backed set of report modules. It is not a fixed dashboard template. The runtime `cardAuthoring.reportModules` registry and selected Finance task contract are authoritative.

## Selection Rules

1. Start from the user's decision question and the contract's required section roles and card kinds.
2. Add a module only when verified tool output satisfies its display contract. Omit empty, duplicative, decorative, or unrelated modules.
3. Set `moduleId` on every `cardDraft`. The service derives its default `reportSectionRole`, preview view, Artifact reference, snapshot metadata, and evidence routing. Override the section role only when the runtime registry permits it.
4. Keep the reader-first explanation in Report prose and use cards for comparisons, trends, distributions, timelines, or exact bounded values. The Financial Research Viewer remains the drill-down surface for the same Artifact.
5. Use no more than 20 visible rows/items per page. Keep additional verified candidates paginated; do not discard them merely to fit the first page.
6. Never copy values from an example, convert missing values to zero, or synthesize a chart that the source data cannot support.

## Progress And Rendering Budget

- Lead with the current conclusion or blocker, then a small metric strip, then expandable analysis. Do not make users read the tool chronology to discover the result.
- Use stable `cardDraft.id` values and update an existing module instead of appending a second copy after retry, refresh, or monitor runs.
- Keep at most five current progress rows in the live conversation. Collapse older transitions into one summary row with a count and last-updated time.
- Treat full data tables, provenance, raw series, and secondary charts as drill-down content. Lazy-load them when the report section or Viewer tab is opened.
- A provider failure replaces the active progress state with a concise warning and an available next action. Never leave the report in an indefinite loading state.
- Prefer one chart that answers the decision question over multiple decorative charts. Reuse the same Artifact and Evidence references across the report and Viewer.

## Route Suggestions

| Question route               | Suggested modules                                                                       | Useful card forms                                                                                          | Typical Report placement                                               |
| ---------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Global market and themes     | `market_status`, `market_theme_ranking`, optionally `provenance_and_limitations`        | headline metrics, cross-market table, breadth line, sector treemap or horizontal rank, dated evidence      | `market_status`, `themes`, `evidence` or `limitations`                 |
| News or event impact         | `event_impact_chain`, optionally `provenance_and_limitations`                           | event timeline, impact-path ranking, price-confirmation line, counterevidence list                         | `event_facts`, `impact_paths`, `price_confirmation`, `counterevidence` |
| Company research             | `company_snapshot`, `company_financials`, `company_events_risks`                        | quote/valuation metrics, K-line, period table, revenue/profit line, event timeline, risk ranking           | `identity`, `price`, `financials`, `events`, `risks`                   |
| Simulated research portfolio | `simulation_policy`, `simulation_performance`, `simulation_holdings`, `simulation_risk` | assumptions table, NAV line, return attribution rank, holdings table, allocation donut, risk exposure rank | `simulation_policy`, `performance`, `holdings`, `risk`                 |
| Imported holdings diagnosis  | `holdings_diagnosis`, optionally `provenance_and_limitations`                           | exposure metrics, holdings table, concentration/allocation rank or donut, missing-data list                | `holdings`, `exposure`, `risks`, `data_gaps`                           |
| Continuous monitor           | `monitor_status`                                                                        | latest-change ranking, run/error timeline, policy metrics                                                  | `latest_changes`, `runs`, `errors`, `policy`                           |
| Factor research              | `factor_research_result`, optionally `provenance_and_limitations`                       | result metrics, cumulative return line, ranked robustness checks, evidence table                           | `protocol`, `result`, `robustness`, `leakage_checks`, `evidence`       |

These are suggestions, not minimum card counts. A concise company answer may need only `company_snapshot` plus a limitations paragraph; a broad market scan may need several cards.

## Visualization Contracts

- `treemap`: use a `data_table` with a label in `name`, `label`, `sector`, `theme`, or `symbol`; a finite change in `changePct`, `change_pct`, `change`, `returnPct`, or `return_pct`; and optionally `marketCap`, `market_cap`, `weight`, `size`, `breadthPct`, or `breadth_pct` for area.
- `candlestick`: use a `data_table` with `date`/`x`/`timestamp`/`time` plus finite `open`, `close`, `low`, and `high`. Each row must satisfy `low <= open, close <= high`.
- `hbar_rank`: use a `ranked_list` whose values are all finite and comparable.
- `donut`: use a `ranked_list` whose values are non-negative parts with at least one positive value. Use it for allocation or composition, not signed returns.
- `timeline`: use an `evidence_list` with valid dated Evidence. Omit `items` when registered Evidence already supplies the desired entries.
- `line` or `sparkline`: use a `timeseries` with real ordered numeric points and units where applicable.

If a requested visualization fails its contract, use the ordinary table or list. The UI also falls back to that readable form rather than rendering a blank chart.

## Example: Suggested Market Modules

```jsonc
{
  "cardDrafts": [
    {
      "id": "market-status",
      "kind": "metric_strip",
      "moduleId": "market_status",
      "title": "<evidence-backed market status title>",
      "evidenceIds": ["<registered-evidence-id>"],
      "metrics": [{ "id": "<metric-id>", "label": "<label>", "value": "<verified value>", "unit": "<unit>" }],
    },
    {
      "id": "sector-map",
      "kind": "data_table",
      "moduleId": "market_theme_ranking",
      "title": "<evidence-backed sector comparison title>",
      "visualization": "treemap",
      "pageSize": 20,
      "evidenceIds": ["<registered-evidence-id>"],
      "columns": [
        { "key": "sector", "label": "Sector" },
        { "key": "market", "label": "Market" },
        { "key": "changePct", "label": "Change", "unit": "%" },
        { "key": "size", "label": "Comparable size" },
      ],
      "rows": ["<verified rows only>"],
    },
  ],
}
```

The Report must contain sections with roles `market_status` and `themes`. The service inserts one `card_ref` for each draft into its module's default section and de-duplicates an explicit matching reference.

## Example: Suggested Company Price Module

```jsonc
{
  "id": "company-price-kline",
  "kind": "data_table",
  "moduleId": "company_snapshot",
  "reportSectionRole": "price",
  "title": "<security and verified period>",
  "visualization": "candlestick",
  "pageSize": 20,
  "evidenceIds": ["<registered-price-evidence-id>"],
  "columns": [
    { "key": "date", "label": "Date" },
    { "key": "open", "label": "Open" },
    { "key": "close", "label": "Close" },
    { "key": "low", "label": "Low" },
    { "key": "high", "label": "High" },
  ],
  "rows": ["<verified OHLC rows only>"],
}
```

Use a normal price table or line series when OHLC data is incomplete.
