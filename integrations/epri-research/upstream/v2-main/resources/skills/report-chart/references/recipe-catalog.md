# Report Chart Recipe Catalog

Use this catalog only after choosing the correct visual medium and chart `kind`.
A recipe never repairs weak evidence, performs a calculation, changes values, or
turns unrelated categories into a sequence. Input order remains meaningful and
deterministic; sort upstream when a ranked display requires it.

This catalog documents the 25 recipes shipped across the v1 compatibility and v2
report grammars in this build. It is not capability discovery:
`report_chart(action="describe")` is the runtime authority for accepted schemas,
kinds, recipes, required fields, and limits. If this file and `describe` differ,
follow `describe`.

## Fast selector

| Reading task                             | Recipe                   | Visible effect                                        | Good example                                      | Avoid when                                                               |
| ---------------------------------------- | ------------------------ | ----------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Read an ordered comparison quickly       | `bar.ranked`             | Quiet horizontal bars with direct values              | Target candidates ranked by verified score        | Input is not intentionally ordered                                       |
| Compare distance from one baseline       | `bar.rung`               | Fine baseline-to-value stem with a terminal dot       | Mathematical error relative to a threshold        | A filled magnitude is the main message                                   |
| Compare gains and losses                 | `bar.diverging`          | Signed bars on both sides of one reference            | Factor contribution or change from control        | Values do not cross the baseline, or groups carry another color meaning  |
| Compare several series within categories | `bar.grouped`            | Side-by-side bars inside each category                | Methods compared across the same cohorts          | Category-series pairs are missing or components are additive             |
| Compare supplied components and totals   | `bar.stacked`            | Non-negative components stacked to a category total   | Source counts split by evidence type              | Values are signed, non-additive, incomplete, or already normalized       |
| Audit an additive progression            | `bar.waterfall`          | Explicit start/end bars joined by level connectors    | Revenue bridge from baseline to final result      | Running levels cannot be supplied and reconciled upstream                |
| Follow a small number of sequences       | `line.direct`            | Standard lines with endpoint labels                   | Convergence by iteration or revenue by quarter    | X is an unordered category                                               |
| Read a denser, subtle trend              | `line.hairline`          | Thin, print-safe strokes and small marks              | Several nearby validation trajectories            | Individual points must dominate                                          |
| Read a trend with real uncertainty       | `line.uncertainty-band`  | Band between supplied low/high bounds                 | Estimated response with a 95% confidence band     | Bounds were not computed at every point                                  |
| Read magnitude relative to a baseline    | `line.area`              | One ordered line with a restrained baseline fill      | Verified cumulative volume over time              | Fill would imply uncertainty, points are missing, or series are multiple |
| Compare estimates and uncertainty        | `interval.forest`        | Fine interval whisker plus weighted estimate mark     | Effect sizes with 95% confidence intervals        | Bounds are not meaningful or comparable                                  |
| Compare compact bounded ranges           | `interval.range-capsule` | Rounded range band with a central estimate tick       | Sensitivity range for several assumptions         | The estimate is unavailable                                              |
| Turn two thresholds into a decision view | `scatter.quadrant`       | Explicit x/y reference lines and four regions         | Target efficacy versus safety threshold           | Either threshold is arbitrary or missing                                 |
| Reveal exactly overlapping observations  | `scatter.jitter`         | Small deterministic display-only offsets              | Replicated measurements at identical coordinates  | Offset could be mistaken for measurement error without a caption         |
| Scan categorical evidence direction      | `matrix.claim-matrix`    | Shape and restrained color encode support state       | Claim by study: supports, against, mixed, unknown | Cells lack an explicit status                                            |
| Compare non-negative cell magnitude      | `matrix.punchcard`       | Circle area, not radius, encodes value                | Evidence count by endpoint and subgroup           | Values are negative or exact lookup is primary                           |
| Scan continuous cell intensity           | `matrix.heatmap`         | Tone encodes a bounded numeric value                  | Correlation, risk, or activity matrix             | Cells lack values or a meaningful shared domain                          |
| Compare exactly two values per entity    | `pair.dumbbell`          | Two endpoint marks joined by a quiet rule             | Baseline versus follow-up by cohort               | Rows have more than two observations or incompatible units               |
| Compare audited distribution summaries   | `distribution.box`       | Whiskers, quartile box, median, and supplied outliers | Latency summaries across systems                  | Only raw samples exist or multimodal shape carries the result            |
| Read a small part-to-whole composition   | `composition.waffle`     | At most 100 deterministic unit cells by part          | Participant disposition totaling the enrolled set | Parts overlap, omit cases, or do not sum to the declared total           |
| Audit ordered attrition                  | `flow.funnel`            | Decreasing stage bands with direct counts              | Screened candidates narrowed to validated leads   | Stages overlap, increase, or use different population bases              |
| Follow milestones and states             | `timeline.lineage`       | Ordered events with past/current/future/blocked states | Research decisions or catalyst calendar           | Dependencies matter but event order does not                             |
| Inspect a small rooted structure         | `hierarchy.tree`         | Parent-child branches with explicit node states        | Mechanism or theorem dependency hierarchy         | Nodes have multiple parents, cycles, or a dense graph                     |
| Balance named opposing endpoints         | `scale.bipolar`          | Supplied items on a centered semantic scale            | Risk versus opportunity assessment                | Scores are invented, ordinal only, or unbounded                           |
| Compare two aligned sequences            | `sequence.rainfall`      | One paired connector at every ordered observation      | Baseline versus candidate factor by window        | More than two series or incompatible units must be compared               |

## Compatibility rules

- `bar.ranked` and `bar.rung` require `orientation="horizontal"`.
- `bar.diverging` uses `baseline` (zero when omitted), requires values on both
  sides of it, and accepts no `group` values.
- `scatter.quadrant` requires both `xReferenceValue` and `yReferenceValue`.
- `line.uncertainty-band` requires `low` and `high` on every point, with
  `low <= y <= high`. The renderer never invents, smooths, or extrapolates the
  band.
- `scatter.jitter` changes only rendered pixel positions for exactly overlapping
  points. Axes, labels, tables, tooltips, hashes, and Evidence retain true values.
- `matrix.claim-matrix` requires `status` on every supplied cell.
- `matrix.punchcard` requires a non-negative `value` on every supplied cell and
  maps value to circle area with a square-root radius scale.
- `matrix.heatmap` requires `value` on every supplied cell.
- `interval.range-capsule` always displays the `estimate` as well as `low` and
  `high`.
- `bar.grouped` and `bar.stacked` use `deepscientist.report_chart.v2` and require
  an explicit value for every declared category-series pair. Missing is not zero.
- `bar.stacked` accepts non-negative additive components only. Supply absolute
  values; the renderer does not normalize them to shares or percentages.
- `bar.waterfall` requires an explicit baseline and producer-supplied `start`,
  `end`, and `delta` for every step. The renderer validates rather than computes
  the progression.
- `line.area` requires exactly one series, at least two ordered points, and an
  explicit baseline. It accepts no uncertainty bounds.
- `pair.dumbbell` requires exactly two named endpoints and commensurate `first`
  and `second` values for every row.
- `distribution.box` accepts producer-computed summaries, not raw samples. It
  requires positive `n`, ordered whisker/quartile values, and a stated whisker
  meaning.
- `composition.waffle` requires non-negative parts whose sum equals `total`, with
  positive `unit` and at most 100 cells (`total / unit <= 100`).
- `flow.funnel` requires non-increasing non-negative stage values on one
  population basis.
- `timeline.lineage` requires unique, strictly increasing numeric or time event
  positions and does not accept a y axis.
- `hierarchy.tree` requires exactly one root, valid parent ids, no cycles, and
  no more than four levels below the root.
- `scale.bipolar` requires `domain[0] < center < domain[1]` and every item value
  inside the domain.
- `sequence.rainfall` requires exactly two unique series and comparable values
  for every ordered point.

## Data insertion examples for the v2 recipes

The numbers and Evidence ids below are structural examples only. Never copy them
into a report. Calculate and verify all values upstream, preserve their real units
and denominator, then replace every example value and Evidence id.

### `bar.grouped`

**Use when:** the same complete set of methods, cohorts, or conditions must be
compared within each category. Readers should compare bars within a category and
then scan the same series across categories.

**Avoid when:** values are additive components of totals, any category-series pair
is missing, or there are more than six series. Use `bar.stacked`, an honest table,
or split the question instead.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Validation accuracy by cohort",
  "kind": "bar",
  "recipe": "bar.grouped",
  "categories": [
    { "id": "cohort-a", "label": "Cohort A" },
    { "id": "cohort-b", "label": "Cohort B" }
  ],
  "series": [
    { "id": "method-a", "label": "Method A" },
    { "id": "method-b", "label": "Method B" }
  ],
  "values": [
    { "categoryId": "cohort-a", "seriesId": "method-a", "value": 0.81, "evidenceIds": ["E1"] },
    { "categoryId": "cohort-a", "seriesId": "method-b", "value": 0.76, "evidenceIds": ["E2"] },
    { "categoryId": "cohort-b", "seriesId": "method-a", "value": 0.73, "evidenceIds": ["E3"] },
    { "categoryId": "cohort-b", "seriesId": "method-b", "value": 0.7, "evidenceIds": ["E4"] }
  ],
  "yAxis": { "label": "Accuracy", "unit": "proportion" }
}
```

### `bar.stacked`

**Use when:** each category is an additive total built from the same complete,
non-negative components and both the total and composition matter.

**Avoid when:** components overlap, values are signed, values are already shares,
or a missing component is being treated as zero. Compute shares upstream and use a
future explicit normalized grammar rather than silently normalizing here.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Included evidence by source type",
  "kind": "bar",
  "recipe": "bar.stacked",
  "categories": [{ "id": "claim-1", "label": "Primary claim" }],
  "series": [
    { "id": "trials", "label": "Trials" },
    { "id": "reviews", "label": "Systematic reviews" },
    { "id": "guidelines", "label": "Guidelines" }
  ],
  "values": [
    { "categoryId": "claim-1", "seriesId": "trials", "value": 12, "evidenceIds": ["E1"] },
    { "categoryId": "claim-1", "seriesId": "reviews", "value": 4, "evidenceIds": ["E2"] },
    { "categoryId": "claim-1", "seriesId": "guidelines", "value": 2, "evidenceIds": ["E3"] }
  ],
  "yAxis": { "label": "Included sources", "unit": "count" }
}
```

### `bar.waterfall`

**Use when:** the evidence supplies an auditable starting level, every additive
change, any subtotal, and the final level. Each step must explain part of one
reconciled progression.

**Avoid when:** only deltas or only the final total are known, changes are
multiplicative, or consecutive levels cannot be reconciled. Calculate every
`start`, `end`, and `delta` upstream before inserting data.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Change from baseline to final result",
  "kind": "bar",
  "recipe": "bar.waterfall",
  "baseline": 0,
  "steps": [
    {
      "id": "start",
      "label": "Baseline",
      "kind": "start",
      "start": 0,
      "end": 120,
      "delta": 120,
      "evidenceIds": ["E1"]
    },
    {
      "id": "loss",
      "label": "Exclusions",
      "kind": "change",
      "start": 120,
      "end": 105,
      "delta": -15,
      "evidenceIds": ["E2"]
    },
    { "id": "total", "label": "Final", "kind": "total", "start": 0, "end": 105, "delta": 105, "evidenceIds": ["E3"] }
  ],
  "yAxis": { "label": "Participants", "unit": "count" }
}
```

### `line.area`

**Use when:** one complete ordered sequence should be read as magnitude relative
to a meaningful baseline. The baseline and every point must be supplied.

**Avoid when:** the fill would be interpreted as uncertainty, multiple series must
be compared, x is unordered, or a missing point would need interpolation. Use
`line.uncertainty-band` only for real point-level lower and upper bounds.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Verified cumulative observations",
  "kind": "line",
  "recipe": "line.area",
  "baseline": 0,
  "series": [
    {
      "id": "observed",
      "label": "Observed",
      "unit": "count",
      "points": [
        { "x": "2026-01", "y": 12, "evidenceIds": ["E1"] },
        { "x": "2026-02", "y": 19, "evidenceIds": ["E2"] },
        { "x": "2026-03", "y": 27, "evidenceIds": ["E3"] }
      ]
    }
  ],
  "xAxis": { "label": "Month", "scale": "time" },
  "yAxis": { "label": "Observations", "unit": "count" }
}
```

### `pair.dumbbell`

**Use when:** every entity has exactly two comparable endpoint values under the
same unit and scope, and direction plus magnitude of change matter.

**Avoid when:** rows have more than two observations, endpoints use different
units or denominators, or pairing is not real. Insert the two verified endpoint
values; do not fabricate a pair from unrelated aggregates.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Baseline and follow-up score",
  "kind": "pair",
  "recipe": "pair.dumbbell",
  "endpoints": [
    { "id": "baseline", "label": "Baseline" },
    { "id": "follow-up", "label": "Follow-up" }
  ],
  "rows": [
    { "id": "cohort-a", "label": "Cohort A", "first": 42, "second": 58, "evidenceIds": ["E1"] },
    { "id": "cohort-b", "label": "Cohort B", "first": 47, "second": 51, "evidenceIds": ["E2"] }
  ],
  "xAxis": { "label": "Score", "unit": "points" }
}
```

### `distribution.box`

**Use when:** upstream analysis already produced auditable sample sizes, quartiles,
whiskers, outliers, and the meaning of each whisker for comparable groups.

**Avoid when:** only raw samples are available, whisker definitions differ without
clear disclosure, or density/multimodality carries the conclusion. Compute the
summary with the domain analysis tool and pass the result; the renderer is not a
statistics engine.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Latency distribution summaries",
  "kind": "distribution",
  "recipe": "distribution.box",
  "data": [
    {
      "id": "system-a",
      "label": "System A",
      "n": 120,
      "lowerWhisker": 18,
      "q1": 24,
      "median": 31,
      "q3": 39,
      "upperWhisker": 52,
      "outliers": [61],
      "whiskerMeaning": "tukey-1.5-iqr",
      "evidenceIds": ["E1"]
    }
  ],
  "xAxis": { "label": "Latency", "unit": "ms" }
}
```

### `composition.waffle`

**Use when:** a small number of mutually exclusive, non-negative parts exactly
sum to one meaningful total and a countable unit view improves comprehension.

**Avoid when:** parts overlap, unknown cases are omitted, totals do not reconcile,
or more than 100 cells are required. Choose `unit` upstream; never let display
rounding change the denominator or a part's exact value.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Participant disposition",
  "kind": "composition",
  "recipe": "composition.waffle",
  "total": 100,
  "unit": 1,
  "parts": [
    { "id": "completed", "label": "Completed", "value": 72, "evidenceIds": ["E1"] },
    { "id": "withdrawn", "label": "Withdrawn", "value": 18, "evidenceIds": ["E2"] },
    { "id": "lost", "label": "Lost to follow-up", "value": 10, "evidenceIds": ["E3"] }
  ]
}
```

### `flow.funnel`

**Use when:** one population is filtered through ordered, auditable stages and
the attrition itself helps answer the question.

**Avoid when:** groups overlap, a later stage can exceed an earlier one, or the
denominator changes. Explain those cases in prose or a table instead.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Candidate screening funnel",
  "kind": "flow",
  "recipe": "flow.funnel",
  "visualIntent": {
    "question": "process",
    "readingMode": "glance",
    "placement": "lead",
    "takeaway": "Independent validation is the main narrowing stage."
  },
  "stages": [
    { "id": "screened", "label": "Screened", "value": 820, "evidenceIds": ["E1"] },
    { "id": "eligible", "label": "Eligible", "value": 214, "evidenceIds": ["E2"] },
    { "id": "validated", "label": "Validated", "value": 36, "emphasis": true, "evidenceIds": ["E3"] }
  ]
}
```

### `timeline.lineage`

**Use when:** supplied milestones or decisions have a meaningful numeric or time
order and their states matter to the conclusion.

**Avoid when:** tasks form a dependency graph but dates are incidental. Use the
project graph or a compact hierarchy instead.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Research decision lineage",
  "kind": "timeline",
  "recipe": "timeline.lineage",
  "xAxis": { "label": "Study day", "scale": "linear" },
  "visualIntent": { "question": "process", "readingMode": "explore", "placement": "supporting" },
  "events": [
    { "id": "scope", "label": "Scope frozen", "at": 0, "state": "past", "evidenceIds": ["E1"] },
    { "id": "analysis", "label": "Primary analysis", "at": 5, "state": "current", "evidenceIds": ["E2"] },
    { "id": "validation", "label": "External validation", "at": 10, "state": "future" }
  ]
}
```

### `hierarchy.tree`

**Use when:** the reader needs a small rooted taxonomy or one-parent dependency
structure beside the section it explains.

**Avoid when:** the structure has cycles, multiple parents, or enough nodes to
require pan and zoom. Route those to a dedicated graph workspace.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Mechanism hierarchy",
  "kind": "hierarchy",
  "recipe": "hierarchy.tree",
  "visualIntent": { "question": "hierarchy", "readingMode": "explore", "placement": "supporting" },
  "nodes": [
    { "id": "root", "label": "Primary mechanism", "state": "current", "emphasis": true },
    { "id": "signal", "label": "Signal response", "parentId": "root", "state": "complete", "evidenceIds": ["E1"] },
    { "id": "metabolism", "label": "Metabolic response", "parentId": "root", "state": "neutral", "evidenceIds": ["E2"] }
  ]
}
```

### `scale.bipolar`

**Use when:** upstream analysis supplies values on one bounded, centered scale
with two meaningful semantic endpoints.

**Avoid when:** labels are subjective but no auditable score exists. Do not make
up a scale to decorate qualitative judgments.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Risk and opportunity balance",
  "kind": "scale",
  "recipe": "scale.bipolar",
  "domain": [-5, 5],
  "center": 0,
  "endpoints": [
    { "id": "risk", "label": "Higher risk" },
    { "id": "opportunity", "label": "Higher opportunity" }
  ],
  "visualIntent": { "question": "compare", "readingMode": "glance", "placement": "lead" },
  "items": [
    { "id": "demand", "label": "Demand visibility", "value": 3.4, "emphasis": true, "evidenceIds": ["E1"] },
    { "id": "financing", "label": "Financing sensitivity", "value": -2.6, "evidenceIds": ["E2"] }
  ]
}
```

### `sequence.rainfall`

**Use when:** two supplied series are aligned on the same ordered observations,
units, and denominator, and crossings or separations matter.

**Avoid when:** more than two series are needed, observations are unordered, or
the two values are not directly comparable.

```json
{
  "schema": "deepscientist.report_chart.v2",
  "title": "Factor performance by validation window",
  "kind": "sequence",
  "recipe": "sequence.rainfall",
  "series": [
    { "id": "baseline", "label": "Baseline" },
    { "id": "candidate", "label": "Candidate" }
  ],
  "yAxis": { "label": "Rank IC" },
  "visualIntent": { "question": "change", "readingMode": "explore", "placement": "appendix" },
  "points": [
    { "id": "w1", "label": "Window 1", "first": 0.031, "second": 0.047, "evidenceIds": ["E1"] },
    { "id": "w2", "label": "Window 2", "first": 0.028, "second": 0.041, "evidenceIds": ["E2"] }
  ]
}
```

## Report handoff

The interactive report preview may show a delayed reading tooltip, focus guide,
or enlarged invisible hit area and may pin a mark on click or keyboard
activation. Clicking it again or pressing Escape releases the focus. These aids
never move, magnify, smooth, or mutate data. The formal Artifact remains the
deterministic, script-free SVG and normalized chart JSON returned by
`report_chart(action="render")`.
