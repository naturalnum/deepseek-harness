# Vibe-Trading Adapted Research SOP

This reference adapts selected methodology from HKUDS/Vibe-Trading for DeepScientist Financial Report Mode. It is an implementation guide, not a second runtime contract. The upstream project is MIT-licensed; preserve attribution when redistributing adapted text.

## 1. Route before researching

Classify the request once before calling a finance tool:

- `market_observation`: market overview, security snapshot, screening, news, or price series.
- `company_research`: company, financial statement, peer, or event analysis.
- `factor_research`: discover, implement, evaluate, or backtest time-aware factors.
- `portfolio_simulation`: compare a simulated strategy and its risk, never a real account.
- `monitor`: compare a new snapshot with the previous one and preserve `no_change` when nothing material changed.

Use the injected `Financial Task Route` as the authority. Do not re-route after the first successful finance call. Map data needs to the tools that are actually present in the runtime; never copy an upstream tool name as if it were available.

## 2. User-facing progress and performance

The report workspace is a reader, not a tool trace. Stream progress as compact, stable rows:

1. `准备数据` — show market, symbols, period, and freshness.
2. `核对覆盖范围` — show returned/requested counts and missing symbols.
3. `计算指标` — show the current module and one key metric when available.
4. `检查风险` — show the check being run, not raw logs.
5. `整理报告` — show the report section currently being assembled.

Keep the first viewport useful: show the conclusion or current blocker first, then the most recent metric card, then details. Do not render every provider response, intermediate tool envelope, or full table inline.

Performance rules:

- Emit one progress event per material transition, not per row or token.
- Update a card in place using its stable `cardId`; do not append duplicate cards on retries.
- Keep the latest 5 visible progress events in the live view and collapse older events into a count/timestamp row.
- Lazy-load charts, large tables, and secondary files only after the user opens them.
- Do not poll unchanged provider state. Reuse the returned `requestId`, receipt, and data revision.
- Keep the report body virtualized or sectioned when it exceeds the normal viewport; preserve scroll position when a later card arrives.
- Provider retries are bounded by the adapter. A failed call produces one readable warning and does not make the UI spin indefinitely.

## 3. Data and evidence discipline

Every numeric statement needs an evidence path:

```text
finance result envelope -> sourceRef -> evidence item -> report card/section
```

Preserve `asOf`, `retrievedAt`, timezone, currency, coverage, missing symbols, provider status, and upstream revision. Distinguish:

- `no_data`: the requested series has no usable observations.
- `provider_error`: the provider failed; do not infer a market fact.
- `partial`: enough independent evidence remains for a labelled partial report.
- `no_change`: the monitor found no material change and should reuse the previous report.

Do not use generic web text to silently replace a failed managed finance call. A user-provided CSV or a primary filing can be an explicit alternate evidence path, but the report must label the source and changed coverage.

## 4. Research goals and acceptance criteria

Attach a research goal for a multi-step report, comparison, audit, or task that continues across turns. Use 3-5 criteria:

- define the universe and research question;
- collect current market, filing, or artifact evidence;
- compare a control or alternative;
- test the requested metric or strategy;
- record limitations and non-advice boundaries.

Add evidence to the criterion it supports. Mark a goal complete only when every required criterion has an auditable result. If a provider or input is missing, keep the goal `partial` or `blocked` with an explicit gap instead of inventing a conclusion.

## 5. Backtest and calculation diagnosis

When a backtest or calculation fails, inspect the result envelope, input metadata, and generated artifacts before editing code. Classify one root cause at a time:

- runtime/dependency error;
- schema or column mismatch;
- empty or insufficient data;
- date alignment or look-ahead violation;
- abnormal result such as zero trades, an open terminal position, or excessive idle cash;
- provider quota, rate-limit, or no-data response.

Provider-side failures are not code bugs. Record the provider gap, use the adapter's bounded retry/fallback policy, and continue independent routes. Do not invoke shell package installation from a Skill, do not rewrite an entire project to repair one issue, and stop after at most three repair iterations unless the user explicitly asks for more.

## 6. Report structure and concise presentation

Use the existing `science_artifact` and `report_chart` contracts. The output is
a compact financial research note: the user's question and the decision
relevant answer come before evidence inventory. Prefer this reader-first order:

1. **研究问题与口径 / Question and mandate** — market, universe, `asOf`,
   timezone, currency, period, actual/estimate/scenario labels, and coverage.
2. **执行摘要 / Executive summary** — one direct answer plus 3-5 supported
   points, confidence, and the fact most likely to change the view.
3. **关键数据与图表 / Key data and lead visual** — metric strip, comparison,
   trend, scenario, or event timeline with units, denominator, source and a
   one-sentence interpretation.
4. **核心观点 / Core views** — each claim separated into fact, calculation,
   interpretation, and hypothesis, with the relevant company/market/event or
   portfolio module.
5. **情景、风险与失效条件 / Scenarios and risks** — assumptions, triggers,
   impact, horizon, counterevidence, and invalidation conditions.
6. **下一步 / Decision boundary and next actions** — conditional monitoring or
   research actions, not unrequested live trading instructions.
7. **方法、来源与附录 / Method, sources and appendix** — reproducibility,
   evidence ids, formulas, detailed rows and raw provenance kept secondary.

Use explicit labels such as `bullish`, `bearish`, `neutral`, `partial`, and `not_available`. Do not generate target price, position size, or trading instructions unless the user explicitly requests a simulation; even then, keep the disclaimer and simulation boundary visible.

For tables, put units in headers, use `A/E` to distinguish actual and estimate
periods, format percentages consistently, and show a short “what this means”
sentence below the table. For charts, show the takeaway in the card title and
keep raw series in the expandable detail view. Never publish a chart merely to
fill a slot: each visual must answer a named question and be backed by real
values.

## 7. Valuation and risk safeguards

DCF, comps, and three-statement analysis are optional report modules. Require the inputs they need (cash flow, forecast horizon, discount rate, terminal assumptions, peer set, or balance-sheet fields). Missing inputs must return a structured `not_available` result with the missing list; never default silently.

For simulated portfolios, include at least maximum drawdown and a stress scenario. Add VaR/CVaR only when the sample and confidence level are explicit. Keep losses positive in the calculation layer and apply any presentation sign convention only at the UI/report layer.

## 8. Non-trading boundary

This SOP supports research, simulation, and backtesting only. It must not create live orders, submit broker instructions, log in to an exchange, manage wallets, or write real account state. A requested live action is a user-facing blocked capability, not a reason to load a different connector.

## Attribution

Adapted from selected ideas in HKUDS/Vibe-Trading Skills: `research-goal`, `data-routing`, `backtest-diagnose`, `report-generate`, `risk-analysis`, `valuation-model`, and `execution-model`. Tool names and runtime contracts above are DeepScientist-specific.
