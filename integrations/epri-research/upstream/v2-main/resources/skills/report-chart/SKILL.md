---
name: deepscientist-report-chart
description: Create simple, evidence-bound charts for DeepScientist Science, Mathematical Research, Target Discovery, Challenge, Financial, and Medical Evidence reports with the report_chart MCP tool. Use when verified structured data is easier to understand as a comparison, trend, interval, relationship, distribution, composition, or compact matrix. Prefer a table or a short sentence when a chart would add complexity rather than clarity.
---

# DeepScientist Report Chart

Make one clear chart from verified data. The default report view should show the
chart and a short caption. Keep Evidence, source details, raw values, and files
collapsed until the reader asks to inspect them.

## Choose the visual medium first

- Prefer a verified source image or a purpose-built generated figure when the
  claim depends on visible morphology, spatial arrangement, anatomy, a pathway,
  an instrument view, or another scene the reader must inspect.
- Prefer `report_chart` when exact comparison, trend, interval, relationship,
  distribution, composition, or matrix structure carries the conclusion. Prefer
  a sentence or table for one or two facts or exact lookup.
- Show the chosen visual inline near its interpretation. Do not repeat one result
  as an image, chart, and table on the primary report surface; keep supporting
  data and Evidence collapsed.

## Decide whether a chart helps

- **Bar:** compare a small set of categories, rankings, grouped series, supplied
  additive components, or an auditable change decomposition. Example: validation
  accuracy for three methods in two cohorts.
- **Line:** show a real sequence or trend. Example: revenue by quarter or error
  by iteration. Do not use a line for unrelated categories. Draw an uncertainty
  band only from supplied point-level lower and upper bounds; never add a
  decorative shadow that could be mistaken for uncertainty.
- **Interval:** compare estimates together with uncertainty or bounds. Example:
  effect sizes with 95% confidence intervals. Use a bar instead when there are no
  meaningful bounds.
- **Scatter:** show a relationship, clusters, or outliers between two numeric
  variables. Example: risk versus expected return. A scatter plot does not prove
  causation.
- **Matrix:** scan many row-by-column values or evidence states. Example: which
  studies support each claim. Use a table when exact text or exact numbers matter
  more than the overall pattern.
- **Pair:** compare exactly two named, commensurate values for each row. Example:
  baseline and post-intervention score for each cohort.
- **Distribution:** compare producer-computed summaries such as quartiles and
  whiskers. Example: audited latency summaries by system. Do not ask the renderer
  to calculate statistics from raw samples.
- **Composition:** show a small, non-overlapping part-to-whole breakdown. Example:
  enrolled participants by final disposition when the parts sum exactly to the
  declared total.
- **Flow:** show how one comparable population narrows through ordered stages.
  Example: candidates screened, validated, and prioritized. Do not use it for
  overlapping or unordered groups.
- **Timeline:** show supplied milestones, catalysts, or research decisions in
  their real order and state. Use a dependency view instead when time is not the
  important relationship.
- **Hierarchy:** show one small rooted taxonomy or dependency tree. Keep dense
  graphs and multi-parent networks in a dedicated workspace.
- **Bipolar scale:** compare supplied scores between two meaningful, named
  endpoints around an explicit center. Do not invent a score merely to fill it.
- **Rainfall sequence:** compare exactly two aligned supplied series at each
  ordered observation. Use a line or table when there are more than two series.

Do not draw a chart for one isolated fact, two unrelated facts, mostly narrative evidence, missing or
incomparable values, or decoration. A sentence or a small table is often better.
Use `research-figure-diagram` for mechanisms, pathways, workflows, architectures,
editable diagrams, or bespoke multi-panel figures. Use `ds-paper-plot` when a
paper template is the deliverable. Keep source images as image artifacts.

For Target Discovery, prefer one verified candidate ranking, evidence-channel
comparison, validation matrix, or effect interval. The Target Viewer already
derives its ranking, cross-candidate evidence matrix, and per-target evidence
profile from the current portfolio, so do not duplicate those values in the
report. For Challenge mode, compare only canonical scores produced under the
same sealed task, profile, evaluator, and metric contract; omit failed trials
and missing scores. Its workbench already derives the canonical score comparison
and, when timing exists, the score-versus-evaluation-time view.

Read [references/domain-composition.md](references/domain-composition.md) only
when deciding how several candidate visuals should be arranged for Science,
Target Discovery, or Challenge mode. It defines the primary/supporting visual
hierarchy, three controlled reader-first report compositions, and rules that
prevent the report, workspace, and detail page from repeating the same chart.

## Keep the default simple

- Show one idea per chart. Use a short title, readable units, direct labels, and
  one caption that explains the comparison in ordinary language.
- Start with `palette="auto"`, `appearance="auto"`,
  `density="comfortable"`, `showGrid=false`, `showLegend=false`, and
  `directLabels=true`. Add a grid or legend only when it helps interpretation.
- If more than eight series or groups, or long names would require severe
  truncation, split the comparison, use direct labels, or use a compact table.
  Do not turn a large legend into a separate lookup task for the reader.
- Keep Evidence and technical details available but collapsed by default. Do not
  repeat the same values as a chart, table, and card on the main report surface.
- Use `emphasis: true` for the one decisive mark when possible and never for more
  than three. On a larger chart, keep the highlighted subset near 20% or less.
  Emphasis means a subtle colored underlay plus a bolder label; it must not hide
  the value or become decoration.

## Choose an optional recipe

`recipe` selects a visual grammar; v2 recipes may also select a dedicated strict
data grammar. It never authorizes the renderer to calculate or alter values. Omit
it only for stable legacy v1 rendering. Use a recipe compatible with `schema` and
`kind` only when its stated reading task matches the evidence. Never select one
just because it looks distinctive.

Read [references/recipe-catalog.md](references/recipe-catalog.md) when choosing
among the 25 recipes documented for this build or when you need a concrete
cross-mode data example. Do not load that catalog when the default rendering
already communicates the result clearly.

The catalog spans 13 compatibility recipes under
`deepscientist.report_chart.v1` and 12 newer grammars under
`deepscientist.report_chart.v2`. This file is guidance, not capability discovery:
`report_chart(action="describe")` is always the authority for the schemas, kinds,
recipes, and required fields, plus the data grammars mounted in the current runtime. When
the chart form is undecided, call it once without filters to load the complete
decision guide. Reuse that response for the task; use `describeKind` or
`describeRecipe` only for a smaller follow-up, and never repeat an identical
`describe` call. A broader 48-item
product blueprint exists in
[references/48-capability-blueprint.md](references/48-capability-blueprint.md),
but it includes future schemas, dedicated interactive workspaces, and metric
cards. Read it only when planning a new visual capability or routing a data shape
that the runtime catalog cannot represent. Never pass a blueprint name to
`report_chart` unless `describe` lists it as an accepted recipe.

Keep `style.interaction="auto"` unless the reading context gives a reason to
choose otherwise. Use `inspect` for a chart that benefits from point-level
reading aids and `quiet` for a very dense or formal review surface. These modes
only affect the interactive preview; the formal SVG remains static. Read
[references/interaction-and-palette.md](references/interaction-and-palette.md)
when choosing an interaction profile, a signed heatmap, or a non-default
palette.

## Render once

1. Confirm that `report_chart` is available. If it is missing, report one runtime
   fault and use a verified table or static figure. Do not guess paths or retry
   equivalent tools.
2. Calculate ratios, aggregates, cumulative levels, intervals, quartiles, totals,
   and every other derived value upstream. The chart tool maps supplied values to
   marks; it never performs analysis, imputation, normalization, or reconciliation.
3. Use `report_chart(action="describe")` without filters once when the runtime
   schema, recipe choice, or required fields are not already known. It returns the
   complete recipe catalog, all unique data grammars, action inputs and outputs,
   and the Artifact handoff. Reuse that response; use `describeKind` or
   `describeRecipe` only for a smaller follow-up. Build one strict object for the
   selected recipe and normally call `report_chart(action="render")` once. Use
   `validate` only for a useful no-write preflight.
4. Fix at most one concrete schema or readability defect. Register the returned
   `artifactDraft` with `science_artifact` and reuse its `.chart.json` and
   script-free SVG for preview and export.
5. If the repair fails, preserve the verified values in a table or show a clear
   unavailable note. Do not loop through different renderers.

## Insert data with the selected runtime grammar

The specifications are strict. Do not invent fields, convert a planned blueprint
name into a recipe, or mix v1 and v2 grammars. When uncertain, read
`report_chart(action="describe")` and follow the selected entry's `schema`,
`kind`, `requiredFields`, `useWhen`, and `avoidWhen`.

Common fields:

- required: `schema`, `title`, `kind`;
- optional: `id`, `description`, `caption`, `evidenceIds`, `xAxis`, `yAxis`,
  `style`, plus the recipe and data fields accepted by that schema;
- `xAxis` and `yAxis`: `label`, `unit`, `scale`, `min`, `max`;
- `style`: `palette`, `appearance`, `density`, `showGrid`, `showLegend`,
  `directLabels`, and optional `interaction`.
- `visualIntent`: `question` (`compare | change | uncertainty | process |
  composition | relationship | hierarchy`), `readingMode` (`glance |
  editorial | explore`), `placement` (`lead | supporting | appendix`), and an
  optional one-sentence `takeaway`. Use `lead` only for a chart that directly
  answers the user's main question. Use `supporting` beside the section it
  explains and `appendix` for audit-heavy or dense diagnostics.

Allowed style values:

- `palette`: `auto | mono | nature`;
- `appearance`: `auto | light | dark | print`;
- `density`: `compact | comfortable`.
- `interaction`: `auto | inspect | quiet`.

Axis `scale` accepts `linear | time | category`. Use `time` only where the
runtime grammar accepts ordered dates or timestamps. A logarithmic v1 interval
chart uses the interval kind's own `scale="log"`; every estimate, bound,
reference, and explicit axis limit must then be positive.

### v1 compatibility grammars

- `bar`: `orientation` (`horizontal | vertical`), optional `baseline`, and
  `data[]` with `id`, `label`, `value`, and optional `group`, `note`,
  `evidenceIds`, `emphasis`;
- `line`: optional `referenceValue` and `series[]` with `id`, `label`, optional
  `unit`, `evidenceIds`, `emphasis`, plus `points[]` containing `x`, `y`, and
  optional `low`, `high`, `evidenceIds`, `emphasis`; `low` and `high` must be
  supplied together and satisfy `low <= y <= high`;
- `interval`: optional `referenceValue`, `scale` (`linear | log`), and `data[]`
  with `id`, `label`, `estimate`, `low`, `high`, and optional `weight`, `group`,
  `note`, `evidenceIds`, `emphasis`; require `low <= estimate <= high`;
- `scatter`: optional `xReferenceValue`, `yReferenceValue`, and `data[]` with
  `id`, `x`, `y`, and optional `label`, `size`, `group`, `note`, `evidenceIds`,
  `emphasis`;
- `matrix`: `rows`, `columns`, and `cells[]` with `row`, `column`, optional
  `value`, `status`, `label`, `note`, `evidenceIds`, `emphasis`, plus optional
  `valueDomain`, `colorScale` (`sequential | diverging`), and `center`. A
  diverging scale requires an explicit domain spanning `center` (zero when
  omitted). Status is `neutral`, `supports`, `against`, `mixed`, `unknown`,
  `risk`, `positive`, or `negative`.

### v2 report grammars

- `bar.grouped` and `bar.stacked`: `kind="bar"`, `categories[]` and `series[]`
  with unique `id` and `label`, and `values[]` with `categoryId`, `seriesId`,
  finite `value`, plus optional `note`, `evidenceIds`, and `emphasis`. Supply
  every category-series pair explicitly. `bar.stacked` accepts only
  non-negative additive components; it never converts them to percentages.
- `bar.waterfall`: `kind="bar"`, explicit `baseline`, optional non-negative
  `tolerance`, and ordered `steps[]` with unique `id`, `label`, `kind`
  (`start | change | subtotal | total`), `start`, `end`, and `delta`, plus
  optional evidence fields. Calculate every level upstream; the renderer checks
  `end - start = delta` within tolerance and never invents a running total.
- `line.area`: `kind="line"`, one explicit `baseline`, and exactly one
  `series` containing at least two ordered `{x,y}` points. It represents
  magnitude relative to the baseline, not uncertainty; do not pass low/high
  bounds, smoothing, imputed points, or multiple series.
- `pair.dumbbell`: `kind="pair"`, exactly two `endpoints` with unique `id` and
  `label`, and `rows[]` with unique `id`, `label`, `first`, and `second`, plus
  optional evidence fields. Supply both verified endpoint values under the same
  unit and comparator scope. The readout's signed difference is deterministic
  subtraction of those endpoints, not a new analysis result.
- `distribution.box`: `kind="distribution"` and `data[]` with unique `id`,
  `label`, positive integer `n`, `lowerWhisker`, `q1`, `median`, `q3`,
  `upperWhisker`, optional `outliers`, and `whiskerMeaning`
  (`min-max | tukey-1.5-iqr | custom`). Compute the summary upstream, keep the
  five values non-decreasing, and place outliers outside the supplied whiskers.
- `composition.waffle`: `kind="composition"`, positive `total` and `unit`, and
  `parts[]` with unique `id`, `label`, and non-negative `value`, plus optional
  evidence fields. Parts must sum to `total`; `total / unit` may not exceed 100.
  The renderer never changes the denominator or rounds values into a different
  composition.
- `flow.funnel`: `kind="flow"` and ordered `stages[]` with non-increasing,
  non-negative `value`. Every stage must refer to the same population basis.
- `timeline.lineage`: `kind="timeline"` and ordered `events[]` with unique
  `at` values and explicit `state` (`past | current | future | blocked`).
- `hierarchy.tree`: `kind="hierarchy"` and `nodes[]` containing exactly one
  root, unique ids, one parent per non-root node, no cycles, and at most four
  levels below the root.
- `scale.bipolar`: `kind="scale"`, a numeric `domain`, a `center` strictly
  inside it, two named `endpoints`, and supplied `items[].value` within the
  domain.
- `sequence.rainfall`: `kind="sequence"`, exactly two named `series`, and
  ordered `points[]` with supplied `first` and `second` values under one unit.

Keep datum and series ids unique. Matrix rows, columns, and cell coordinates must
also be unique. Explicit axis and value-domain maxima must be greater than their
minima. Never pass HTML, JavaScript, CSS, raw SVG, functions, remote scripts,
callbacks, executable formatters, or unrestricted ECharts options.

## Keep the evidence honest

- Every plotted number must be finite. Preserve real zero values. Never turn an
  unavailable, censored, pending, or not-run observation into zero. Omit an
  invalid numeric mark and disclose the omission in the caption or collapsed
  details. A matrix cell may instead use `status="unknown"` without `value`.
- Put resolvable Evidence ids, not Artifact ids, in the chart, series, point,
  datum, or cell `evidenceIds`. A reader should reach these from the collapsed
  Evidence view without crowding the chart itself.
- Put units on axes or line series. Put sample size, denominator, interval method,
  and transformations in `description`, `caption`, or a supported `note`.
- Add a baseline or reference only when the evidence defines that comparator.
  A chart presents evidence; it is not proof or causal evidence.

## Keep the chart readable

- Preserve the chart's readable natural width. On a narrow surface, let the
  chart scroll horizontally instead of shrinking labels below the figure type
  scale or letting them cover the caption and supporting details.
- Put direct line labels in the reserved right gutter, not over the last data
  points or an uncertainty band. Use leader lines when endpoints are close.
- When a scatter plot has more than 12 points, keep persistent labels only for
  emphasized points and the x/y extrema. Every point remains inspectable in the
  fixed readout below the plot.
- Supporting data, Evidence, and files stay collapsed by default. An interaction
  readout must remain in document flow below the canvas, never float over the
  next report block.
- A chart has one keyboard entry. Use Arrow keys to move between marks, Home/End
  to reach the first or last mark, Enter/Space to pin, and Escape to clear. Do
  not place hundreds or thousands of marks in the page Tab order.

## Color and handoff

The default `auto` palette uses layered black and grey, with one restrained blue
signal color only for emphasis. Use `mono` when color adds no information. Use
`nature` when several evidence-bearing series need color. It is DeepScientist's
screen-safe Morandi research palette, aligned with the project's fixed
`mist-stone`, `sage-clay`, `dust-rose`, `fog-blue`, and `lavender-ash` families
and informed by Nature figure discipline. It is not an official Springer Nature
corporate, brand, or product/UI palette. Its light structure uses `#2D2A26`,
`#5D5A55`, and `#DDDAD4`, with `#596F96`, `#4A7780`, `#716989`, and `#756C64`
for categorical series. Sage, dust rose, and ochre are reserved for positive,
negative, and risk direction. Labels, shapes, and status must still carry
meaning without color.

Accept the chart only when the schema validates, Evidence ids resolve, labels
and units are readable, intervals are correct, references are honest, and the
hashed `.chart.json`/SVG receipt is present. Place the chart immediately after
the paragraph that interprets it. Before publication, confirm that the report,
chart artifact, Evidence ids, and source checkpoint refer to the same revision.

Evidence grade, support/against, risk, safety, completion, citation, and other
semantic badges must be deterministic icon-or-symbol plus text, backed by a
traceable rule. Never generate them with an image model. Generated images are
for reviewed non-semantic identity art or evidence-appropriate explanatory
scenes, not chart thumbnails, data marks, controls, or scientific status.
