# Financial Report SOP

This is a reader-facing research note, not a transcript of tool calls or a
generic evidence dump. The report must answer the user's question first and
then make the answer checkable. Use only sections that have material content;
never create an empty “valuation”, “forecast”, or “risk” box just to resemble a
broker report.

## Reader contract and order

Use this order unless the user explicitly asks for another format:

1. **Question, mandate, and `asOf`** — restate the decision question, market
   and universe, timezone, currency, period, data coverage, and whether values
   are actual, estimate, or scenario.
2. **Executive answer** — answer the question in one short paragraph followed
   by three to five evidence-backed bullets. State the stance or conclusion,
   confidence, and the single fact that would most change it. Do not hide the
   answer below sources or progress logs.
3. **Key numbers and lead visual** — show the smallest useful metric strip,
   comparison, trend, scenario, or event timeline. Include units, denominator,
   period, and source/as-of in the caption, followed by one sentence explaining
   what the visual means for the question.
4. **Drivers and analysis** — choose the relevant modules: market regime and
   themes; company identity, financial statements, cash flow and balance-sheet
   quality; price/volume and events; factor or portfolio diagnostics. Distinguish
   reported fact, calculation, interpretation, and hypothesis.
5. **Scenarios, risks, and invalidation** — for each bull/base/bear or
   upside/base/downside case, give assumptions, observable triggers, impact,
   time horizon, and what would falsify the case. A scenario is not a forecast
   unless its assumptions and uncertainty are explicit.
6. **Decision boundary and next actions** — give conditional research or
   monitoring actions. Do not turn an informational report into a buy/sell
   instruction or an invented target price.
7. **Sources, method, and reproducibility** — list the primary sources,
   evidence ids, transformations, sample window, freshness, and unresolved data
   gaps. Keep raw tool output, logs, and large tables in collapsible files.

For a simple lookup, use a compact answer plus scope, source, and limitation;
do not force the full note template. For a company report, never omit the
business identity and period-comparable revenue/profit/cash-flow context when
those fields are available. For a market or thematic report, state the regime,
breadth/flows or comparable market measures, and the catalysts that could
change the view.

## Publication

- Register evidence before publishing claims that depend on external sources.
- Use the standard Science Report artifact and existing report card.
- Give every chart/card a metric contract, source references, units, frequency,
  sample range, and a plain-language “what this means” caption. A chart without
  a reader question is not a useful visual.
- Publish one final report. Update that report instead of producing duplicate terminal reports.
- The report is the primary preview; raw files and Git remain inspectable from the project workspace.
- Do not repeat the same result as prose, a chart, and a table unless each form
  answers a different reader question. Keep the lead visual near the executive
  answer and move detailed evidence/provenance below it.

## Completion

Complete only after the published report receipt is available. A prose answer
without the report receipt is partial. A provider failure may produce a Partial
Report when reviewable evidence remains; label the missing coverage and stop
after the bounded repair. A missing required field, unresolved identity
mismatch, or no reviewable evidence is blocked, never a zero value.
