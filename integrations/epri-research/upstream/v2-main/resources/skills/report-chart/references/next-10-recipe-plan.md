# Report Chart Expansion: Seven Shipped, Three Planned

This document records one ten-recipe expansion slice; it is not an accepted MCP
enum. The runtime source of truth remains `report_chart(action="describe")`.
Seven report-ready recipes from this slice now ship through the v2 grammar. The
three full-workspace candidates remain plans and must not appear in a chart
specification unless a future `describe` response lists them.

The compatibility recipes cover single-series categories, sequences, uncertainty
intervals, XY relationships, and matrices. The seven shipped v2 additions cover
categorical series, supplied additive progressions, magnitude area, paired values,
distribution summaries, and part-to-whole composition. Gantt, choropleth, and
Sankey still need larger Artifact workspaces because they require spatial layout,
navigation, assets, or more room for labels.

## Recommended set

| Status  | Recipe               | Reading task                                       | Route                        | Shared primitives             |
| ------- | -------------------- | -------------------------------------------------- | ---------------------------- | ----------------------------- |
| Shipped | `bar.grouped`        | Compare several methods within each category       | Report and full Artifact     | rect, axis, legend, label     |
| Shipped | `bar.stacked`        | Compare totals and their supplied components       | Report and full Artifact     | rect, axis, legend, label     |
| Shipped | `bar.waterfall`      | Explain an additive change step by step            | Report and full Artifact     | rect, connector, zero rule    |
| Shipped | `line.area`          | Read one supplied sequence relative to a baseline  | Report and full Artifact     | area, line, point, axis       |
| Shipped | `pair.dumbbell`      | Compare two named values for every row             | Report and full Artifact     | rule, point, label            |
| Shipped | `distribution.box`   | Compare supplied five-number summaries             | Report and full Artifact     | rule, rect, tick, point       |
| Shipped | `composition.waffle` | Read a countable part-to-whole composition         | Report and full Artifact     | cell, label, legend           |
| Planned | `timeline.gantt`     | Read stage windows, overlap, and milestones        | Full Artifact; compact <= 12 | ranged rect, point, time axis |
| Planned | `map.choropleth`     | Compare a verified measure across regions          | Full Artifact only           | geo path, legend, label       |
| Planned | `flow.sankey`        | Audit how a supplied quantity moves between stages | Full Artifact only           | node, link, label             |

`bar.stacked` initially supports absolute non-negative values only. A normalized
100 percent mode should be a later recipe or require explicitly supplied shares;
the renderer must not silently convert totals to percentages. Signed values stay
with `bar.diverging` unless a dedicated diverging-stack contract is introduced.

## Data grammars

### Categorical series

`bar.grouped` and `bar.stacked` share one grammar:

```ts
type CategoricalSeriesSpec = {
  categories: Array<{ id: string; label: string }>;
  series: Array<{ id: string; label: string }>;
  values: Array<{
    categoryId: string;
    seriesId: string;
    value: number;
    evidenceIds?: string[];
    emphasis?: boolean;
  }>;
};
```

Every category-series pair must be explicit. Missing values are not zero. The
validator rejects duplicate pairs, unknown IDs, negative stacked values,
and more than six visible series in an embedded report.

### Waterfall

```ts
type WaterfallStep = {
  id: string;
  label: string;
  kind: 'start' | 'change' | 'subtotal' | 'total';
  start: number;
  end: number;
  delta: number;
  evidenceIds?: string[];
};
```

The producer supplies all three numeric fields. Validation checks
`end - start == delta` within a declared tolerance and checks that consecutive
steps connect where the recipe requires it. The renderer only maps these values
to geometry; it does not invent a running total.

### Area sequence

`line.area` reuses the existing line grammar. The shipped version accepts exactly
one series, at least two points, and a required numeric `baseline`. Numeric/time
x values must be unique and strictly increasing, the value axis must contain the
baseline, and uncertainty `low`/`high` fields are forbidden. It must retain
visible gaps and never smooth or extrapolate. This is a magnitude view, not an
uncertainty band.

### Pair

```ts
type PairSpec = {
  endpoints: [{ id: string; label: string }, { id: string; label: string }];
  rows: Array<{
    id: string;
    label: string;
    first: number;
    second: number;
    evidenceIds?: string[];
  }>;
};
```

The readout shows both values and the exact signed difference. Direction can use
position and an arrowhead or endpoint shapes; it must not rely on red/green alone.

### Distribution summary

```ts
type BoxSummary = {
  id: string;
  label: string;
  n: number;
  lowerWhisker: number;
  q1: number;
  median: number;
  q3: number;
  upperWhisker: number;
  outliers?: number[];
  whiskerMeaning: 'min-max' | 'tukey-1.5-iqr' | 'custom';
  evidenceIds?: string[];
};
```

The validator requires positive integer `n` and enforces non-decreasing summary
values. Outliers must lie outside the supplied whiskers. The chart and table show
`n` and `whiskerMeaning`; the renderer does not calculate quartiles from raw
samples. A future histogram or raincloud recipe should accept pre-binned or
pre-computed density data rather than hide statistical choices in the UI
renderer.

### Composition

```ts
type WaffleSpec = {
  total: number;
  unit: number;
  parts: Array<{
    id: string;
    label: string;
    value: number;
    evidenceIds?: string[];
  }>;
};
```

All values are finite and non-negative, `sum(parts.value) == total`, and
`total / unit <= 100`. Partial cells are allowed only when the exact fractional
value is preserved in the readout and table. A segment label and shape/fill
combination remains available in monochrome and color-vision-deficient contexts.

### Timeline

```ts
type TimelineItem = {
  id: string;
  label: string;
  start: string | number;
  end: string | number;
  group?: string;
  milestones?: Array<{ id: string; at: string | number; label: string }>;
  evidenceIds?: string[];
};
```

Dates must parse deterministically and satisfy `start <= end`. The report embed
caps visible items at 12; longer plans open in the full Artifact. Status is text
plus shape, never color alone.

### Map

```ts
type ChoroplethSpec = {
  geometryRef:
    | { kind: 'builtin-atlas'; atlasId: string; sha256: string }
    | { kind: 'project-asset'; assetId: string; sha256: string };
  featureKey: string;
  projection: 'equal-earth' | 'mercator' | 'albers-usa';
  values: Array<{
    regionId: string;
    label: string;
    value: number;
    evidenceIds?: string[];
  }>;
};
```

Never accept an arbitrary remote geometry URL. Resolve only a versioned built-in
atlas or a registered project asset, verify its hash, and record its source,
license, feature key, and projection in the receipt. Unmatched regions remain
neutral and the Artifact reports matched and unmatched counts. No hand-drawn
geography is permitted.

### Flow

```ts
type SankeySpec = {
  flowMode: 'conserved' | 'descriptive';
  stages: Array<{ id: string; label: string; order: number }>;
  nodes: Array<{ id: string; label: string; stageId: string; order: number }>;
  links: Array<{
    id: string;
    source: string;
    target: string;
    value: number;
    evidenceIds?: string[];
  }>;
};
```

Links require known nodes and positive finite values. Reject duplicate IDs,
self-links, unsupported cycles, unspecified ordering, and links that move
backward across stages. `conserved` mode validates incoming and outgoing flow at
every internal node; losses require an explicit node or link. Layout is
deterministic from the supplied order; dragging may inspect but must never mutate
a formal report layout.

## Interaction profiles

- All report recipes keep one Tab stop per chart. Arrow keys move through marks,
  Home/End jump to boundaries, Enter/Space pins, and Escape clears.
- Grouped and stacked bars focus one segment while keeping category totals visible.
- Waterfall highlights the selected step, its connector, and the supplied running
  level. It never recomputes neighboring steps.
- Area and dumbbell use a data-anchored crosshair or guide line. Hover and focus
  preview; click pins.
- Box plots expose median, quartiles, whisker meaning, and outliers in one readout.
- Waffle focuses a segment, not every individual cell, to avoid 100 Tab stops.
- Gantt supports bounded time-window zoom plus reset in the full Artifact.
- Choropleth supports pointer/keyboard region focus, search, zoom, and reset. It
  always keeps a non-color legend and an accessible region table.
- Sankey focuses a node or link and dims unrelated paths. It keeps exact values in
  the readout and linked table; flow width is not the only numeric channel.

## Architecture and MCP changes

1. Introduce one recipe registry with grammar, reading task, required and
   forbidden fields, mark limits, interaction profile, and stability state.
2. Compile a validated spec into a shared scene of axis, rect, range, line, area,
   point, cell, label, geo-path, node, and link primitives. React preview and
   script-free SVG export become adapters over the same scene.
3. Generate `report_chart(action="describe")`, the skill catalog, examples, and
   recipe enum tests from the registry. The runtime catalog contains only shipped
   recipes; planned workspace names never appear as accepted enum values.
4. Keep the v1 schema stable. The seven report grammars use a versioned v2 union;
   promote later recipes only after schema, React, SVG, table fallback, receipt,
   MCP description, skill example, and tests all land together.
5. Build recipe thumbnails from fixed example specs through the real renderer.
   Do not use generated images for chart thumbnails, data marks, legends, or
   semantic badges.

## Remaining delivery order

The seven report-ready recipes above are shipped as v2. The remaining sequence is:

1. Add the full-workspace `timeline.gantt` after bounded zoom and label collision
   checks are stable.
2. Add `map.choropleth` only after asset registration, projection, hash receipts,
   and unmatched-region reporting exist.
3. Add `flow.sankey` after deterministic layout and conservation validation.

## Explicit non-goals for this slice

- Radar, gauge, donut, and 3D recipes are not core evidence views. The later
  bounded `flow.funnel` grammar covers audited attrition without changing the
  larger Sankey requirement. Grouped bars, metric cards, waterfall/Sankey,
  waffle, and aligned axes are more precise for their usual reading tasks.
- GPT image generation may make a non-semantic report cover, section thumbnail,
  or mechanism illustration. It must not generate data charts, geography,
  evidence badges, numeric legends, or recipe thumbnails.
- Animation can orient attention, but never changes values or hides a mark. Formal
  SVG and table exports remain complete without animation.

## Primary references

- Vega-Lite grouped bar: https://vega.github.io/vega-lite/examples/bar_grouped.html
- Vega stacked bar: https://vega.github.io/vega/examples/stacked-bar-chart/
- Vega-Lite waterfall: https://vega.github.io/vega-lite/examples/waterfall_chart.html
- Observable Plot area mark: https://observablehq.com/plot/marks/area
- Vega-Lite ranged dot: https://vega.github.io/vega-lite/examples/layer_ranged_dot.html
- Vega-Lite pre-aggregated box plot: https://vega.github.io/vega-lite/examples/boxplot_preaggregated.html
- Observable Plot waffle: https://observablehq.com/plot/marks/waffle
- Vega-Lite Gantt: https://vega.github.io/vega-lite/examples/bar_gantt.html
- Vega-Lite choropleth: https://vega.github.io/vega-lite/examples/geo_choropleth.html
- D3 Geo: https://d3js.org/d3-geo
- D3 Sankey: https://github.com/d3/d3-sankey
