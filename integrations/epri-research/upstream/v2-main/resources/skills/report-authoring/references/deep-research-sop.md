# Deep Research SOP

Use this reference when the user asks for a comprehensive financial note,
scientific report, literature-grounded answer, comparison, or a result that
will be revisited across multiple turns. It is a reusable research process,
not a second MCP contract. The active mode, available tools, user scope, and
publication schema remain authoritative.

## 0. Define the mandate before collecting material

Write a compact research brief before the first broad search:

```text
Question: the decision or explanation the reader needs
Population/universe: entities, sample, market, or dataset
As-of and horizon: cutoff time, forecast window, timezone
Comparison: baseline, peer, control, alternative, or counterfactual
Deliverable: answer, note, chart, paper section, or full report
Acceptance criteria: 3-5 observable conditions for a useful result
Non-goals: claims or actions explicitly outside the request
```

If one missing choice would materially change the answer, ask one structured
question. Otherwise choose a reasonable scope, state it, and continue. Do not
turn routine uncertainty into a blocking questionnaire.

## 1. Build a question map, not a linear tool list

Break the mandate into 3-7 answer-bearing subquestions. For each one record:

- the claim it may support;
- the input or source needed;
- the calculation or comparison required;
- the visual that would make the result easier to inspect;
- the condition that would weaken or falsify it;
- the next action if the evidence is missing.

The map is allowed to branch. A new result may create a follow-up experiment,
an alternative explanation, or a request for a more specific source. Reuse the
same goal and stable ids when the work resumes.

## 2. Search in breadth, then depth

Use a small number of deliberate search rounds instead of repeated free-form
queries:

1. **Breadth:** search the main question, the closest alternative, the baseline
   or comparator, and a contradiction or risk angle. In literature work, start
   from seed papers and expand backward/forward or by citation graph.
2. **Triage:** deduplicate sources, rank primary/official material above
   commentary, and retain only candidates that can change the answer.
3. **Depth:** read the selected sources, extract the exact number, definition,
   date, population, method, and limitation needed for each subquestion.
4. **Saturation:** stop a round when new searches mostly repeat the existing
   source set. Broaden the search only when a key claim has one weak source or a
   credible contradiction remains unresolved.

Financial research normally prioritizes filings, regulators, exchanges, audit
reports, company disclosures, and clearly dated market data. Scientific work
normally prioritizes primary papers, systematic reviews, benchmark datasets,
registered protocols, and reproducible code. Commentary is context, not a
replacement for primary evidence.

## 3. Maintain a claim-to-source ledger

Before drafting, keep a compact ledger with one row per important claim:

```text
Claim | type (fact/computed/inference/hypothesis) | source/evidence id
As-of | definition and unit | transformation or formula
Confidence | counterevidence | unresolved gap | next check
```

Verify that every number in the draft maps to the ledger and that the source
actually contains the stated population, period, unit, and comparison. Never
turn a missing value into zero, a scenario into a forecast, or an association
into causality. Mark an unverifiable citation instead of guessing.

## 4. Reconcile and compute before interpreting

Run the smallest reproducible calculation that answers the subquestion:

- normalize symbols, units, currencies, timezones, identifiers, and corporate
  actions;
- label actual versus estimate versus scenario values;
- record sample size, missingness, inclusion/exclusion rules, and software or
  data versions;
- preserve the raw input and derived output needed to repeat the calculation;
- use sensitivity, subgroup, alternative baseline, or stress checks when the
  decision depends on an assumption.

For financial notes, valuation, forecasts, and simulated portfolios are
optional modules. Require the inputs before using DCF, multiples, drawdown,
VaR, or factor metrics. For scientific reports, separate observation,
interpretation, and alternative explanation; do not claim a mechanism just
because a plot looks plausible.

## 5. Challenge the draft before publishing

Run three short reviews, in this order:

1. **Reader review:** Does the first paragraph answer the question? Can a
   reader understand the lead chart without opening raw files?
2. **Claim review:** Does every important fact, number, comparison, and causal
   phrase have a traceable source or computation? Are the strongest claims
   narrower than the evidence boundary?
3. **Visual review:** Does each chart have a named reader question, unit,
   denominator, period, source, uncertainty or scenario label, and a nearby
   takeaway? Remove decorative or duplicate visuals.

If an issue is critical, repair the source/calculation or narrow the claim. Do
not polish a weak claim into confidence. A second review may be delegated a
clean copy of the draft and result files so it does not inherit the author's
assumptions; a meta-review is useful for long manuscript packages but is
optional for a normal report.

## 6. Compose for the reader and publish once

Use the shortest structure that answers the mandate:

1. direct answer or blocker;
2. scope, as-of, and coverage;
3. lead metric/figure/table and its takeaway;
4. drivers, methods, and interpretation;
5. scenarios, limitations, and invalidation conditions;
6. concrete next action;
7. sources, reproducibility, and optional appendix.

For a long report, keep the first viewport decision-oriented and put detailed
evidence, raw logs, and large tables behind existing detail affordances. Publish
one stable report and update its sections/cards on retries. Do not publish a
second report merely because one provider or one visual failed.

## 7. Resume and failure policy

Persist the research goal, acceptance criteria, source ledger, open items,
latest result ids, and next action in the existing runtime/project records.
When resuming, read that state before asking the user or repeating a search.

- A transient provider error: record one readable gap, use bounded retry and
  independent evidence, then publish a labelled partial report if the answer
  remains reviewable.
- No reviewable evidence: keep the run blocked and state exactly what is
  missing; do not create an empty report.
- Conflicting evidence: show the disagreement, compare definitions/as-of, and
  narrow the conclusion until a resolving check is available.
- Calculation or rendering failure: preserve the last good result, repair once,
  and update the same report/card rather than appending duplicate output.

## Depth profiles

Choose depth from the user's request, not from a fixed source quota:

- **Compact:** direct answer, scope/as-of, one supporting value/source, one
  limitation, and next action.
- **Standard:** the full reader path, a claim ledger, at least one visual when
  numeric comparison is meaningful, and a brief challenge review.
- **Comprehensive:** question map, breadth-to-depth search, multiple viewpoints
  or a comparator, reproducible calculations, scenarios/sensitivity, explicit
  gaps, and reader/claim/visual review before publication.

## Design basis

This SOP synthesizes publicly documented patterns from [Hermes research-paper-
writing](https://github.com/NousResearch/hermes-agent/tree/main/skills/research/research-paper-writing),
[Academic Research Agent Skill](https://github.com/ngtiendong/Academic-Research-Agent-Skill),
[Financial Research Analyst Agent](https://github.com/gsaini/financial-research-analyst-agent),
[LangAlpha](https://github.com/Chen-zexi/LangAlpha),
[Anthropic financial-services](https://github.com/anthropics/financial-services),
and [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading). The optional Chinese
note path also follows the public [China Investor Network research-report
guide](https://www.investor.org.cn/xxzx/tjzl/tjnrgmjytx/bk/kj/202302/P020230316545012962048.pdf),
which emphasizes a clear first-page view, data-supported industry/company
analysis, valuation assumptions, and explicit risks. These sources are
references for workflow shape and quality checks only; DeepScientist's MCP
tools, permissions, and user request remain the source of truth.
