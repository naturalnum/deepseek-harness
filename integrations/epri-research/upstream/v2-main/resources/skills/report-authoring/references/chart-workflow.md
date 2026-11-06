# DS Report Chart Workflow

Read this file when a DeepScientist report needs a native chart. It connects
the editorial decision to the runtime handoff; `deepscientist-report-chart`
and `report_chart(action="describe")` remain authoritative for exact schemas.

## Contents

- [Complete path](#complete-path)
- [Give the visual one job](#1-give-the-visual-one-job)
- [Select from the mounted registry](#2-select-from-the-mounted-registry)
- [Set presentation intent explicitly](#3-set-presentation-intent-explicitly)
- [Render and register once](#4-render-and-register-once)
- [Embed where the answer is explained](#5-embed-where-the-answer-is-explained)
- [Publish and repair conservatively](#6-publish-and-repair-conservatively)

## Complete path

```text
user question
  -> one reader question for the visual
  -> choose a runtime-supported recipe
  -> render verified values with report_chart
  -> register the returned artifactDraft with science_artifact
  -> reference that Artifact from one report artifact_embed
  -> publish the same report
  -> Preview shows the chart, takeaway, metadata, and Chart/Data switch
```

Rendering alone does not make a chart visible in the report. Registration,
embedding, and publication are required parts of the same handoff.

## 1. Give the visual one job

Choose the reader question before choosing a shape:

| Reader question                     | `visualIntent.question` | Common choices                         |
| ----------------------------------- | ----------------------- | -------------------------------------- |
| Which values differ?                | `compare`               | ranked/grouped bar, dumbbell, interval |
| What changed?                       | `change`                | line, area, waterfall, timeline        |
| How uncertain or robust is it?      | `uncertainty`           | interval, uncertainty band, box        |
| Where does a process narrow?        | `process`               | funnel or timeline                     |
| How is a total composed?            | `composition`           | stacked bar or waffle                  |
| Which variables move together?      | `relationship`          | scatter, heatmap, rainfall             |
| How is a small structure organized? | `hierarchy`             | rooted tree                            |

Use a table or sentence for one or two lookup values. Use a verified image or
reviewed schematic when morphology, anatomy, spatial structure, or mechanism is
the evidence. A chart must not be decorative.

## 2. Select from the mounted registry

When the grammar is not already known, call `report_chart(action="describe")`
once and reuse the result. Filter its `visualRegistry` in this order:

1. the current domain and reader question match;
2. the recipe accepts the desired `readingMode` and `placement`;
3. the mark count does not exceed `maxRecommendedMarks`;
4. a `lead` candidate has `leadEligible=true`;
5. `useWhen` describes the actual data and `avoidWhen` does not apply.

Use `describeRecipe` only for one smaller follow-up. Do not hard-code a roadmap
item or assume that every documented recipe is mounted in another build.

## 3. Set presentation intent explicitly

Every new v2 specification must include:

```json
{
  "visualIntent": {
    "question": "compare",
    "readingMode": "glance",
    "placement": "lead",
    "takeaway": "One supported sentence explaining what the comparison means."
  }
}
```

- `glance`: first-viewport result or compact decision view.
- `editorial`: normal report reading with nearby interpretation.
- `explore`: denser diagnostic or point-level inspection.
- `lead`: directly answers the user's main question and is lead-eligible.
- `supporting`: explains one nearby section.
- `appendix`: dense robustness, audit, or diagnostic detail.

Prefer one lead visual. Additional visuals must answer different questions.

## 4. Render and register once

Calculate every ratio, interval, quartile, scenario, cumulative level, and
derived value upstream. Attach resolvable Evidence ids to the relevant chart
marks. Normally call `report_chart(action="render")` once.

Pass the returned `artifactDraft` once to the active `science_artifact`
create/transact flow. Preserve its normalized chart JSON, script-free SVG,
viewer metadata, paths, hashes, and evidence links; do not reconstruct the
Artifact from prose or hand-written SVG.

## 5. Embed where the answer is explained

Add one report block with `type="artifact_embed"`, the registered `artifactId`,
and `renderer="report_chart"`. Place it immediately after the paragraph that
interprets it. Give the block a caption that names the comparison, scope,
period, unit or denominator, and why it matters.

Preview automatically uses `visualIntent.placement` to keep a valid lead chart
near the answer while supporting and appendix charts remain in their authored
sections. It also supplies the Chart/Data switch and exact-value table. Do not
create another primary table containing the same values.

## 6. Publish and repair conservatively

Publish the same stable report only after the Artifact and embed reference are
present. If validation reports one concrete schema or readability defect,
repair it once and republish. After another failure, preserve the verified
values in a table or show a visible unavailable note. Never invent observations
or rotate through renderers until something passes.

Before completion, confirm that the answer, chart Artifact, Evidence ids,
source checkpoint, report revision, and publication receipt describe the same
run. Reopening the report must restore the same chart and Data view.
