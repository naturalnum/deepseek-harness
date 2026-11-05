# Visual Composition

Visuals are explanatory interfaces, not decoration. Choose a visual only when
it makes the user's question faster or safer to understand.

## Select by reader question

| Reader question | Preferred view | Notes |
| --- | --- | --- |
| What changed over time? | line or step chart | Label period, unit and as-of; do not smooth away gaps. |
| Which items differ? | ranked bar or comparison table | Keep the denominator visible and sort by the user's decision metric. |
| What are the possible outcomes? | scenario bars or range chart | Name assumptions and mark scenarios as scenarios, not forecasts. |
| How does a process or mechanism work? | editable flow or reviewed schematic | Label it as explanatory; it is not experimental evidence. |
| What does the source actually show? | verified source image or artifact preview | Preserve source caption and provenance. |
| Is the result robust? | interval, subgroup, or sensitivity view | Show uncertainty and the comparator, not just the point estimate. |
| Where does a process narrow? | funnel | Every stage must use the same population basis. |
| Which milestones matter? | lineage timeline | Preserve supplied order and state; do not invent dates. |
| How is a small structure organized? | rooted hierarchy | Use only for a bounded one-parent tree. |

## Financial notes

Place one lead visual directly below the executive answer. Good combinations are
a metric strip plus one trend, or one scenario chart plus a compact risk-trigger
table. Add a second or third visual only for a distinct decision question. Avoid
charts with no units, hidden denominators, unlabeled dates, or a legend that is
needed to understand the conclusion.

## Scientific reports

Use a figure to carry the decisive comparison, mechanism, morphology, spatial
structure, or uncertainty. A paper-like figure should have a short title, panel
labels when needed, a legend that explains the comparison, and a one-sentence
takeaway beside it. Use `report_chart` for verified numeric data, a source image
for what the reader must inspect, and a reviewed schematic for a mechanism.
Use `ds-nature-figure` only when a journal-ready multi-panel deliverable is
actually requested. Never use image generation to invent numeric observations,
effect sizes, citations, or dense scientific labels.

## Preview behavior

The report preview is primary. Keep chart/card blocks compact and readable on a
first viewport; put raw files, provenance, and large tables behind the existing
file or detail affordances. A chart caption must answer "what am I looking at?"
and "why does it matter here?" in plain language.

For native v2 charts, set `visualIntent.placement` deliberately: one `lead`
visual may appear near the answer, while `supporting` and `appendix` visuals stay
in their authored sections. Set a one-sentence `takeaway` when it lets the reader
understand the chart without decoding every mark. The preview provides a
Chart/Data switch for exact-value inspection; do not repeat that data table as a
separate primary block.

## Design basis

The reader path follows SEC MD&A guidance (explain changes and implications
rather than restating tables), CFA's common equity-research report elements,
Nature's paper structure and figure guidance, and the modular skill patterns
used by public scientific and finance agents:

- https://www.sec.gov/rules-regulations/2003/12/commission-guidance-regarding-managements-discussion-analysis-financial-condition-results-operations
- https://www.cfainstitute.org/sites/default/files/-/media/documents/support/research-challenge/challenge/rc-equity-research-report-essentials.pdf
- https://www.nature.com/srep/author-instructions/submission-guidelines
- https://research-figure-guide.nature.com/figures/preparing-figures-our-specifications/
- https://github.com/K-Dense-AI/scientific-agent-skills
- https://github.com/Yuan1z0825/nature-skills
- https://github.com/HKUDS/Vibe-Trading

These sources inform the outline and visual jobs only. The active DeepScientist
MCP schema, available tools, and user request remain authoritative.
