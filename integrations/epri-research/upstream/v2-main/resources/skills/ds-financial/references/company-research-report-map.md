# Company Research Report Map

This is an optional, reader-first map for `finance.company-research.v1`. The
runtime task contract, finance tool receipts, and `report-module-cookbook.md`
remain authoritative. Use only the sections supported by the available data.

## Three-phase handoff

Keep one stable `runId` and pass the same evidence and artifact references
through each phase. The output of one phase is the input to the next; do not
re-read the same state after a successful mutation receipt.

1. **Lock the question and data boundary.** Resolve the security and exchange,
   comparison basis, currency, timezone, time window, `asOf`, filing/publication
   time, data-availability time, and expected coverage. Preserve the raw finance
   result envelope and its receipt as the data checkpoint. Mark missing symbols,
   stale data, and provider warnings before interpretation.
2. **Compute before writing.** Derive ratios, growth rates, returns, valuation
   spreads, peer ranks, and scenario values from the returned data in a command
   or reproducible project file. Attach the input evidence ids to the derived
   result. Use a small number of targeted searches for context or counterevidence;
   searches explain a result but do not replace computation.
3. **Publish a decision memo.** Select only the report modules that answer the
   user's question. Draft cards from verified rows/points, write the report
   around those cards, and publish once with the completion manifest. The reader
   path is facts -> interpretation -> implication -> triggers/risks ->
   limitations; it is not a tool diary or a dashboard dump.

## Optional company-research backbone

Use these slots as questions, not as a mandatory checklist. A focused report
usually needs three to five slots; omit an empty or duplicate slot.

| Slot                 | Reader question                                                            | Typical module or evidence                     |
| -------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| 0. Identity          | What security and comparison basis are being analyzed?                     | `company_snapshot`, security evidence          |
| 1. Market/cycle      | Which market, macro, or industry conditions change the reading?            | dated market/event evidence                    |
| 2. Chain/quality     | What operating or supply-chain facts support the business view?            | `company_financials`, filings                  |
| 3. Earnings/scenario | What has changed, and what is the measured scenario range?                 | financial table, timeseries, scenario evidence |
| 4. Risk              | What could invalidate the interpretation?                                  | `company_events_risks`, counterevidence        |
| 5. Valuation/timing  | What is the comparison date and valuation frame?                           | snapshot/price evidence; no invented target    |
| 6. Peers             | Is the comparison like-for-like in period, currency, and accounting basis? | ranked/table card                              |
| 7. Tracking          | What should be checked next, and when?                                     | triggers and limitations                       |

The backbone is not a license to manufacture a target price or a complete
investment recommendation. A missing core capability keeps the report partial
and names the exact missing verification.

## Handoff and evidence rules

- Store raw results, derived calculations, and the final report as ordinary
  project files or Science artifacts so Git remains the durable memory.
- Every decision-bearing paragraph, metric, and card must carry `evidenceIds`
  or an explicit limitation. A derived value must identify the inputs and
  method; literature or news context must not be presented as measured data.
- Prefer `query_many` for independent reads and one `transact` for related
  writes. Do not poll each phase or repeat `status/get` after a successful
  receipt.
- Use `report_chart` only when a verified numeric relationship is clearer as a
  chart. Do not duplicate one result as a chart, table, and prose block, and do
  not hand-write an HTML report or pass raw chart-library code.
- Checkpoint material project changes once at the meaningful stage, then call
  `science_artifact(action="status")` and perform the single terminal publish.
