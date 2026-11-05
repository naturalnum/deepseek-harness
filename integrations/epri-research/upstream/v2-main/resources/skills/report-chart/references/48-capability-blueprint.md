# 48-Recipe Capability Blueprint

This is a product roadmap and routing reference, not an accepted MCP enum.
`report_chart(action="describe")` is always the runtime source of truth. This
build documents 25 stable recipes across the v1 compatibility and v2 report
grammars. Never pass a blueprint name as `spec.recipe` unless `describe` lists it.

For the original shipped seven-recipe expansion and the three remaining full-workspace
candidates, use [`next-10-recipe-plan.md`](next-10-recipe-plan.md). It records
their status, explicit data contracts, validation rules, and remaining delivery
order.

The source reviewed for this blueprint contains 48 presentation templates:
18 Glance, 15 Lupi Editorial, 12 Lupi Basics, and 3 large interactive views.
They are not 48 independent statistical contracts. The audit found roughly 28
data contracts, 13 layout variants, and 7 animation/scale/interaction variants.
DeepScientist should therefore share data grammars and rendering primitives
instead of maintaining 48 unrelated components. No source code, template, or
asset from that project is copied here.

## Status legend

- `v1`: a comparable evidence-safe reading task is available now through a
  listed v1 recipe. It is not a claim of pixel or template equivalence.
- `v1-next`: the existing v1 fields can carry the data, but a new deterministic
  recipe and matching React/static-SVG render path are still required.
- `v2`: an accepted v2 report recipe is named explicitly in the route.
- `planned`: honest support still needs a new declarative grammar, renderer, or
  evidence contract; it is not an accepted runtime recipe.
- `workspace`: use a dedicated full-width interactive Artifact; do not force it
  into the compact v1 renderer.
- `card`: a metric or structured report card is clearer than a chart.

## Glance ideas (18)

| ID  | Presentation idea  | DeepScientist reading task                  | Route                           | Default interaction                    |
| --- | ------------------ | ------------------------------------------- | ------------------------------- | -------------------------------------- |
| G1  | Range Capsules     | Ordered min-max ranges with an estimate     | `v1` `interval.range-capsule`   | Inspect, pin, Evidence                 |
| G2  | Petal Rose         | Small categorical composition for a cover   | `planned` composition           | Quiet; exact values in readout         |
| G3  | Chunky Bars        | Fast ranked comparison                      | `v1` `bar.ranked`               | Quiet, pin                             |
| G4  | Dot Waffle         | Honest parts of a whole                     | `v2` `composition.waffle`       | Segment focus, table link              |
| G5  | Pictorial Bar      | Countable fixed units per category          | `v1-next` unit bar              | Inspect units; deterministic icon      |
| G6  | Circular Graph     | Small node-edge network                     | `planned` network               | Neighbor focus, pin                    |
| G7  | Tree LR            | Two-to-four-level hierarchy                 | `v2` `hierarchy.tree`           | Expand/focus without relayout surprise |
| G8  | Rainfall Dual Area | Two aligned supplied sequences              | `v2` `sequence.rainfall`        | Shared cursor, no causal inference     |
| G9  | Scatter Morph      | Same entities in several declared views     | `workspace` multi-view          | Pause, step, choose view               |
| G10 | Diverging Bar      | Signed change around a real baseline        | `v1` `bar.diverging`            | Quiet, pin                             |
| G11 | Force Graph        | Small draggable network                     | `workspace` network             | Drag, zoom, neighbor focus             |
| G12 | Stagger Wave       | Dense ordered categorical distribution      | `v1-next` dense bar             | Replay optional; reduced-motion safe   |
| G13 | Big Slice          | Supplied share and supplied intensity       | `planned` bivariate composition | Inspect both channels                  |
| G14 | Single Axis        | Period-by-period magnitude matrix           | `v1` `matrix.punchcard`         | Row/column focus                       |
| G15 | Jitter Strip       | Grouped record-level distribution           | `v1` `scatter.jitter`           | Inspect, pin, search label             |
| G16 | Bar Race           | Ranking across declared time slices         | `workspace` rank timeline       | Pause, scrub, step                     |
| G17 | Dynamic Stream     | Live sliding-window monitoring              | `workspace` live dashboard      | Pause and freeze snapshot              |
| G18 | Draw-in + Counter  | Cumulative sequence plus one headline value | `card` + `line.direct`          | Replay optional; value remains static  |

## Lupi Editorial ideas (15)

| ID  | Presentation idea  | DeepScientist reading task                      | Route                      | Default interaction                  |
| --- | ------------------ | ----------------------------------------------- | -------------------------- | ------------------------------------ |
| L1  | Launch Fan         | Entity start time plus current magnitude        | `planned` lifecycle        | Entity focus, search                 |
| L2  | Dot Cascade        | Ranked countable units                          | `v1-next` unit bar         | Inspect category                     |
| L3  | Barcode Lollipop   | Dense scalar time sequence                      | `v1-next` barcode line     | Inspect date, pin extrema            |
| L4  | Arc Matrix         | Category-by-category magnitude                  | `v1` `matrix.punchcard`    | Cell focus                           |
| L5  | Radial Convergence | Record-to-one-group assignment                  | `planned` assignment flow  | Focus group or record                |
| L6  | Cluster Field      | Evidence-bound hub-and-satellite network        | `planned` network          | Quiet poster or neighbor focus       |
| L7  | Brand Spectrum     | Bipolar scales with named endpoints             | `v2` `scale.bipolar`      | Compare entities, read endpoints     |
| L8  | Dotty Matrix       | Group-by-grid magnitude                         | `v1` `matrix.punchcard`    | Cell and group focus                 |
| L9  | Bubble Almanac     | Time-by-category magnitude, status, annotations | `planned` annotated matrix | Inspect cell and event note          |
| L10 | Radial Patchwork   | Event time, magnitude, and supplied density     | `planned` polar events     | Inspect event; no decorative opacity |
| L11 | Trend Lineage      | Entity lifecycle states and milestones          | `v2` `timeline.lineage`    | Search entity, focus milestones      |
| L12 | Type Colonnade     | Auditable record-to-owner assignment            | `planned` assignment flow  | Search, focus owner bundle           |
| L13 | Hourglass Stream   | Stage counts and transitions                    | `v2` `flow.funnel`         | Stage focus, attrition readout       |
| L14 | Hundred Field      | Exactly 100 honest units of composition         | `v2` `composition.waffle`  | Segment focus                        |
| L15 | Ballot Tally       | Independent percentages that need not total 100 | `v1-next` unit bar         | Category focus                       |

## Lupi Basics ideas (12)

| ID  | Presentation idea | DeepScientist reading task                | Route                              | Default interaction         |
| --- | ----------------- | ----------------------------------------- | ---------------------------------- | --------------------------- |
| F1  | Rung Bars         | Sparse countable category comparison      | `v1` `bar.rung`                    | Quiet, pin                  |
| F2  | Hairline Line     | Restrained scalar sequence                | `v1` `line.hairline`               | Inspect point               |
| F3  | Hairline Area     | Supplied sequence with baseline fill      | `v2` `line.area`                   | Inspect point               |
| F4  | Tick Donut        | Parts of a whole as countable ticks       | `planned` composition              | Segment focus               |
| F5  | Tick Rows         | Horizontal ranked unit comparison         | `v1` `bar.ranked`                  | Quiet, pin                  |
| F6  | Paired Rungs      | Two named values per category             | `v2` `bar.grouped`                 | Compare endpoints           |
| F7  | Stacked Rungs     | Category totals split into supplied parts | `v2` `bar.stacked`                 | Segment and total focus     |
| F8  | Plumb Scatter     | Small labeled XY relationship             | `v1` scatter or `scatter.quadrant` | Inspect point               |
| F9  | Rung Waterfall    | Supplied additive change decomposition    | `v2` `bar.waterfall`               | Step focus, running total   |
| F10 | Dot Heat          | Compact row-by-column magnitude           | `v1` `matrix.punchcard`            | Cell focus                  |
| F11 | Tick Gauge        | One goal-progress value                   | `card` metric/progress             | No chart interaction        |
| F12 | Dumbbell Queue    | Before-after pair with direction          | `v2` `pair.dumbbell`               | Compare endpoints and delta |

## Large interactive ideas (3)

| ID  | Presentation idea | DeepScientist reading task       | Route                 | Required interaction                           |
| --- | ----------------- | -------------------------------- | --------------------- | ---------------------------------------------- |
| B1  | Big Circular      | Large circular node-edge network | `workspace` network   | Zoom, search, neighbor focus, pin              |
| B2  | Big Force         | Large spatial force network      | `workspace` network   | Zoom, pan, drag, search, reset                 |
| B3  | Big Threads       | Record-level multi-stage paths   | `workspace` path flow | Hover path/bundle, pin, search, status readout |

## Architecture required before broad expansion

1. Create one recipe registry containing grammar, reading task, required and
   forbidden fields, mark limits, interaction profile, and stability state.
2. Compile `spec -> scene` once. The scene should use shared primitives such as
   axis, line, area, rect, point, interval, cell, label, leader, and reference.
   React and script-free SVG become adapters over the same geometry.
3. Keep the shipped v2 grammars for categorical series, waterfall steps, area
   sequences, paired values, box summaries, and waffle parts declarative.
    Future network, map, and larger flow grammars must meet
   the same rule: renderers never infer statistics or invent records.
4. Build recipe thumbnails from fixed example specs through the real renderer.
   Do not generate thumbnails with an image model.

## Interaction contract

- One Tab stop enters a chart. Arrow keys move among marks; Home/End move to
  the first/last mark; Enter/Space pins; Escape clears.
- Hover/focus only previews. Pinning never changes data or the coordinate domain.
- Dense scatter, matrix, network, and long sequences may expose bounded viewport
  zoom plus reset. Ranked bars and forest plots should remain quiet.
- Legend focus may dim other series but must not remove data or rescale axes.
- A full Artifact may expose SVG/PNG/CSV export and a linked data table. Report
  embeds should keep only inspection and an open-full-view action.

## Generated imagery and badges

Semantic badges are deterministic UI, never generated images. Evidence grade,
support/against, risk, safety, regulatory state, completion, citation, and exact
numbers require a standard icon or symbol plus text and a traceable rule. Chart
controls use familiar deterministic icons.

An image model may create a non-semantic project crest, section thumbnail,
report-cover illustration, or explanatory morphology/mechanism image when that
visual is useful. Generate it offline, without embedded text, review it, version
it, record provenance, and keep a text label in the UI. It must not replace a
data chart, source image, evidence state, or scientific observation.
