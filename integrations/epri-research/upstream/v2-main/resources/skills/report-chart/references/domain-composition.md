# Domain Chart Composition

Read this reference only when a domain report has several plausible visuals or
when the report could repeat charts already derived by a specialized workspace.

## Compose the page

1. Lead with the decision or takeaway in one sentence.
2. Show one primary visual that answers the main comparison; use a second lead
   visual only when the decision genuinely has two independent reading tasks.
3. For a non-trivial report, add a small number of supporting visuals beside the
   sections they explain. Aim for roughly two to six evidence-bearing visuals in
   total, not six variants of the same result.
4. Follow each visual with one plain-language interpretation. Keep evidence,
   sources, raw values, and files collapsed below it.
5. Preserve a readable chart width. Let the plot scroll horizontally before
   shrinking labels, marks, or fixed action buttons.

Set `visualIntent` on every new v2 chart so the report can preserve that
hierarchy after refresh:

- `placement="lead"` for the one chart that directly answers the user's main
  question;
- `placement="supporting"` for a chart that belongs beside one explanatory
  section;
- `placement="appendix"` for dense diagnostics and audit views;
- `readingMode="glance"` for a quick conclusion, `editorial` for normal report
  reading, and `explore` for mark-level inspection.

The renderer exposes the exact source table behind every native chart. This is
an alternate inspection view, not permission to duplicate the table as another
primary report block.

Do not put a chart inside another decorative card. Use the report section as the
outer structure, keep chart chrome quiet, and highlight no more than one to three
decisive marks. Start with the default palette, direct labels, no legend, and no
grid; add a legend or grid only when the reader needs it.

## Controlled report compositions

These compositions borrow the reader-first sequence used by
[Observable Framework](https://github.com/observablehq/framework) data reports,
but they do not load Observable at runtime. They are page-order templates, not a
second chart grammar. Every visual must still come from a normalized
`report_chart` artifact or an existing structured report card. Never insert
arbitrary JavaScript, remote components, HTML, or an unverified chart option.

Choose one composition for a report; do not combine all three:

- **Reader brief:** one-sentence `result_summary`, one primary visual, three to
  five findings, optional supporting visuals for mechanism or limitations, then
  collapsed evidence and technical details.
  Use this for a direct answer or a single dominant result.
- **Experiment comparison:** one-sentence `result_summary`, one interval forest,
  dumbbell, grouped bar, or other complete comparator visual, one plain-language
  interpretation, robustness or failure cases, then collapsed methods. Use this
  when the decision depends on comparable methods, cohorts, or conditions.
- **Evidence map:** one-sentence `result_summary`, one claim matrix, heatmap, or
  punchcard, strongest supporting and contradictory evidence, limitations, then
  references. Use this when evidence coverage and direction matter more than one
  effect estimate.

Every additional visual must answer a distinct question such as comparison,
mechanism, robustness, subgroup behavior, failure mode, or applicability. If
data are missing, heterogeneous, or not comparable, keep the result as prose, a
table, or an explicit visual waiver. Do not fabricate a chart to fill the
template.

## Science

- Use a grouped bar for complete method-by-cohort comparisons.
- Use a line only for a real ordered sequence. Add an uncertainty band only
  when every point has verified lower and upper bounds.
- Use an interval forest for estimates with meaningful confidence or credible
  intervals.
- Use a claim matrix when evidence direction across claims and sources is the
  main reading task.
- Prefer a table when exact values, exclusions, or heterogeneous units matter
  more than a pattern.
- Use `flow.funnel` for a real screening or attrition chain and
  `timeline.lineage` for study milestones. Use `hierarchy.tree` only for a small
  mechanism or dependency hierarchy, normally as supporting content.

## Finance

- Lead with the comparison that answers the investment or operating question:
  a true time series, scenario comparison, valuation bridge, or explicit
  risk-opportunity scale.
- Use `bar.waterfall` only when every bridge level reconciles upstream. Use
  `scale.bipolar` only for an auditable bounded score with named endpoints.
- Keep catalysts on `timeline.lineage`, scenario details in a table or grouped
  bar, and risk triggers near the conclusion. A report is not improved by
  plotting every available market field.

## Financial Factor

- Use a line for real ordered performance, an interval or box summary for
  stability, and `sequence.rainfall` for exactly two aligned factor sequences.
- Keep the factor portfolio workspace as the canonical factor index. Report
  charts should answer out-of-sample performance, robustness, turnover, or
  failure-mode questions rather than repeat the portfolio table.
- Never combine windows with different universes, costs, horizons, or metric
  definitions in one visual without making the incompatibility explicit.

## Mathematics

- Prefer the proof trace and formal artifact for logical validity. A chart may
  support convergence, error, runtime, sensitivity, or benchmark comparisons,
  but it cannot stand in for a proof.
- Use `hierarchy.tree` for a small theorem dependency structure and
  `timeline.lineage` for an auditable proof or repair history.

## Medical Evidence

- Prefer intervals with named confidence or credible interval methods for
  effects, and a claim matrix for evidence direction. Preserve denominators and
  distinguish observed outcomes from hypotheses.
- Use a screening funnel only when every stage belongs to the same review or
  participant population. Put applicability, contraindications, and data gaps
  in prose beside the visual rather than reducing them to decorative scores.

## Target Discovery

The Target Viewer already derives three canonical views from the current
portfolio:

- candidate priority ranking;
- cross-candidate evidence-channel matrix;
- per-target evidence profile.

Do not submit those same values again through `report_chart`. Add a report chart
only for a different verified result, such as an external-validation effect
interval, a complete efficacy-safety comparison with explicit axes, or a
prespecified cohort result not represented by the Viewer. Call a priority index
a score or index, never a probability unless it is actually calibrated as one.
Leave untested channels unknown rather than plotting zero.

## Challenge

The Challenge workbench derives the canonical score comparison and, when two or
more valid trials record comparable elapsed seconds, a score versus evaluation
time scatter plot. Do not redraw either view in progress updates.

The final report may add one different verified view, for example score
progression when trials have a real chronological order, or a complete error-case
composition when all categories and the denominator are known. Never mix sealed
tasks, profiles, evaluator versions, metric contracts, failed trials, or missing
scores in one chart.

## Avoid

- Decorative charts with no decision attached.
- The same values repeated as a workspace chart, report chart, table, and card.
- Imputed zeros, invented bounds, arbitrary smoothing, or causal language from
  correlation alone.
- More than two primary-surface charts for one conclusion.
- A large legend that forces the reader to decode every mark elsewhere.
