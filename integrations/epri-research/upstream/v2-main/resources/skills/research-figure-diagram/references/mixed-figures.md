# Mixed Figures

Use this reference when a manuscript figure combines workflows, model/structure diagrams, quantitative plots, images, or tables.

## Layout Strategy

Choose one anchor:

- Schematic-led: the diagram explains the method or mechanism and occupies `40-60%` of the figure.
- Data-led: the main quantitative result dominates and the diagram is a compact orientation panel.
- Image-led: image plates dominate; plots validate or quantify the visual pattern.

Do not force equal panel sizes. The most important evidence should be largest.

## Assembly Options

Code-first assembly:

- Generate every chart and diagram as SVG/PDF.
- Assemble with matplotlib `GridSpec` or `subplot_mosaic`.
- Best when reproducibility and exact sizes matter.

Vector-editor assembly:

- Generate all assets from code.
- Assemble in Inkscape, Illustrator, or draw.io.
- Best when final manual alignment, arrows, or callouts matter.

Hybrid:

- Use Python for data panels and rough placement.
- Use vector editor only for final callouts and journal polish.

## Cross-Panel Consistency

- Match module colors in diagrams to data-series colors in plots.
- Use one panel-label style throughout.
- Align top edges and gutters.
- Use shared legends or direct labels; avoid per-panel legend clutter.
- Keep panel text smaller than diagram node labels unless it is an axis label.

## Review Checklist

- Can the reader understand what happens first, what is measured, and what result supports the claim?
- Does each arrow correspond to a real relation?
- Does each data panel answer a distinct question?
- Are units, sample sizes, and statistics visible or caption-ready?
- Are all generated assets editable enough for final revision?

