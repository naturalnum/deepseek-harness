---
name: research-figure-diagram
description: >-
  Create publication-ready scientific figures and clean research workflow/structure diagrams. Use when Codex needs to draw, revise, or audit Nature-style or high-impact-journal data plots, bespoke multi-panel manuscript figures, statistical charts, heatmaps, model/system architecture diagrams, method pipelines, flowcharts, mechanism schematics, Graphviz/Mermaid/draw.io-friendly diagrams, or mixed figures combining plots and diagrams. Supports Python/matplotlib/seaborn for data figures and Graphviz/Mermaid/draw.io-style workflows for diagrams, with SVG/PDF/PNG/TIFF export guidance. For a standard typed chart embedded in a DeepScientist report, use deepscientist-report-chart instead.
---

# Research Figure Diagram

## Operating Contract

Treat every figure as a visual argument, not decoration.

When this skill is used from Medical Evidence Mode, treat the figure as part of a clinical evidence brief. The visual hierarchy must follow the same evidence hierarchy as the report:

1. Current guidelines, consensus statements, regulatory labels, and drug labels for safety/dose/contraindication questions.
2. Systematic reviews and meta-analyses.
3. Randomized controlled trials.
4. Prospective cohorts and high-quality real-world evidence.
5. Case-control studies, case series, registries, conference abstracts.
6. Preprints, mechanistic studies, and expert background.

For source tiering, use:

- Tier A: guidelines, regulatory/drug labels, and systematic reviews/RCTs from leading or authoritative journals; use as primary evidence only when population, intervention, outcome, and anchor match.
- Tier B: specialty-journal RCTs, robust cohort studies, and real-world evidence; use as supporting or applicability evidence.
- Tier C: registries, abstracts, preprints, case series, and mechanistic work; use as signal/background and label limitations clearly.

In clinical figures, do not let low-tier sources visually dominate high-tier sources. If a lower-tier source is shown because it is newer or visually useful, mark it as preliminary or contextual in the caption.

When the figure or table is embedded in Medical Evidence Mode, match the clinical report surface:

- For a non-trivial medical evidence report, usually consider one compact visual
  element. Keep it only if it improves comprehension of the clinical decision,
  evidence hierarchy, applicability boundary, source distribution, mechanism, or
  medication safety point.
- Prefer draw.io-friendly diagrams when the visual is a clinical pathway,
  decision tree, source-weighting map, or applicability boundary that may need
  later manual editing. Always pair a `.drawio` artifact with an SVG or PNG
  preview path so the report can render it immediately.
- Use an editorial single-column reading flow. Do not propose two-column figure/card grids for the final answer.
- Tables should default to an academic three-line style: strong top rule, header rule, bottom rule, no heavy cell grid, compact cells, and tabular numerals for counts/years.
- Use card-like modules sparingly and semantically. The default is a plain, no-border editorial block; do not create several modules that differ only by border color. Use takeaway for the clinical bottom line, applicability for population/boundary notes, safety for red flags or medication cautions, claim_map for conclusion-to-evidence mapping, visual_evidence for real images/charts/drawio outputs, and quality_references for a few high-value citations only when those blocks genuinely improve scanning.
- Treat search_strategy, source_coverage, and paperclip_trace as method/process material. They may be useful for audit views, but they should not visually compete with the final clinical conclusion.
- Do not duplicate one fact as both a card and a chart. If a source-distribution chart is present, the adjacent card should explain how that distribution changes the clinical decision.
- In Medical Evidence Mode, every visual claim must be evidence-bound before it is drawn. If PaperClip retrieval or source anchors show that missing patient/context information could change the interpretation, ask the user a short clarification question before producing a final clinical visual.

Before drawing, write a compact contract:

1. **Claim**: one sentence the figure must defend.
2. **Evidence map**: each panel or diagram block and the unique job it performs.
3. **Figure type**: choose `data-only`, `diagram-only`, or `mixed`.
4. **Output contract**: required formats, final size, editable text/vector needs, and whether the output must be manuscript, slide, or draft quality.
5. **Review risks**: possible ambiguity, missing statistics, overplotting, unreadable text, unsupported causal arrows, or layout crowding.

Drop panels or diagram blocks that do not carry evidence. Prefer one dominant panel or dominant workflow spine plus smaller supporting panels over equal-sized dashboard layouts.

## Route

Use this decision tree:

- **Native report chart**: use `deepscientist-report-chart` and `report_chart`
  when the output is a standard evidence-bound comparison, trend, interval,
  ranking, matrix, or coverage chart inside a DeepScientist report. Do not build
  a parallel HTML/ECharts/Python chart for the same report data.
- **Data plots / manuscript figures**: use Python and read `references/data-figures.md`. Use `scripts/pubfig.py` for style, palettes, panel labels, and multi-format export.
- **Flowcharts / method pipelines / architecture diagrams**: read `references/diagrams.md`. Prefer Graphviz for precise directed structure, Mermaid for fast Markdown-native drafts, and draw.io when the user needs hand-editable diagrams.
- **Mixed figure**: read both references. Generate plots and diagrams as separate SVG/PDF assets first, then assemble with matplotlib, Inkscape, Illustrator, or another vector editor depending on the requested deliverable.
- **Science or Medical Evidence explanatory bitmap in Codex**: use the mounted `deepscientist_image_generation` MCP tool only after the report claim and evidence map are stable. Use this route for a compact mechanism overview, conceptual spatial scene, applicability boundary, evidence hierarchy, or reader-friendly explanation that benefits from editorial illustration; keep quantitative plots and manuscript-critical labels on the vector/data routes above.
- **Nature/high-impact multi-panel deliverable**: use `ds-nature-figure` when the figure package, journal export, panel logic, and final QA are themselves part of the deliverable. Respect its blocking Python-or-R selection gate. Do not route ordinary report charts through it.

Do not use AI-generated bitmap diagrams for manuscript-critical labels unless the user explicitly asks for that route and accepts manual text QA. For paper figures, favor editable vector assets.

### Codex Explanatory Image Route

1. Call `deepscientist_image_generation`; do not claim to have generated an image without a successful tool result. The configured model should be GPT-Image-2 or a newer GPT Image model.
2. Write the prompt in English using the imagegen contract: scientific-educational use case, asset type, primary request, composition, exact visible text, style, and constraints. Keep visible labels in the report language and limit the figure to one title plus 3-5 short labeled regions.
3. Use `workspace_dir` as the active project root, `output_dir` as `output/medical-evidence/figures` for Medical Evidence or `output/science-report/figures` for other Science reports, `quality` as `high`, and a descriptive `file_name`. Prefer a white, restrained editorial surface and 4K landscape output when the configured model supports it.
4. Do not include patient-identifying imagery, decorative stock scenes, unsupported causal arrows, invented effect sizes, or evidence-free recommendations. The visual evidence map must use the same evidence IDs as the report.
5. Inspect the saved image for readability, exact language, spurious text, clipped labels, and evidence consistency. Retry once only for a specific visible defect; otherwise use the vector route or omit the figure. Normally keep generated explanatory bitmaps to one or two per report.
6. Register the verified file with `evidence_attach_figure`, including `kind:"image"`, `imagePath`, title, caption, alt text, and supporting `evidenceIds`; then reference its figure ID in `evidence_submit_panel`.

## Data Figure Workflow

Use Python/matplotlib/seaborn unless the user explicitly requests another backend.

1. Inspect data and identify statistical units, sample size, error definition, and comparison groups.
2. Pick the simplest plot that supports the claim: line for trends, dot/box/violin for distributions, scatter for relationships, heatmap for matrices, forest plot for effect sizes.
3. Apply a restrained style via `scripts/pubfig.py`.
4. Use direct labels when possible; otherwise use one shared legend.
5. Export vector first (`SVG`, `PDF`), then raster (`PNG`, optional `TIFF`).
6. Render/inspect final output for clipped labels, tiny text, bad contrast, and ambiguous colors.

Minimal pattern:

```python
from pathlib import Path
import matplotlib.pyplot as plt
from pubfig import apply_style, save_figure, add_panel_label

apply_style()
fig, ax = plt.subplots(figsize=(3.35, 2.25))
ax.plot([0, 1, 2], [0.2, 0.7, 1.0], marker="o")
ax.set_xlabel("Time (h)")
ax.set_ylabel("Response")
add_panel_label(ax, "a")
save_figure(fig, Path("figures/example"), formats=("svg", "pdf", "png"))
```

When panels are assembled in Python, use `subplot_mosaic` or `GridSpec`; avoid manual pixel nudging unless final alignment requires it.

## Diagram Workflow

Use vector-first diagramming.

1. Define nodes as nouns and edges as verbs or transformations.
2. Choose one reading direction: left-to-right for pipelines, top-to-bottom for protocols, radial only for hub-centric mechanisms.
3. Keep each node label short. Put implementation details in captions or annotations, not inside boxes.
4. Use one neutral family, one signal family, and at most one accent color.
5. Export `.dot` or `.mmd` source plus rendered SVG/PNG when tools are available.

Graphviz pattern:

```python
from pathlib import Path
from diagram_helpers import graphviz_pipeline, write_text

dot = graphviz_pipeline(
    nodes=[
        ("data", "Raw data"),
        ("qc", "Quality control"),
        ("model", "Model"),
        ("eval", "Evaluation"),
    ],
    edges=[
        ("data", "qc", "filter"),
        ("qc", "model", "train"),
        ("model", "eval", "test"),
    ],
)
write_text(Path("figures/workflow.dot"), dot)
```

Mermaid pattern:

```python
from pathlib import Path
from diagram_helpers import mermaid_flowchart, write_text

mmd = mermaid_flowchart(
    nodes=[("A", "Cohort"), ("B", "Assay"), ("C", "Analysis"), ("D", "Validation")],
    edges=[("A", "B", ""), ("B", "C", ""), ("C", "D", "")]
)
write_text(Path("figures/workflow.mmd"), mmd)
```

## Mixed Figures

For a figure combining diagrams and charts:

1. Put the workflow/architecture as the visual anchor if it explains the method.
2. Put quantitative validation panels beside or below it.
3. Reuse colors semantically: the module color in the diagram should match the corresponding line/bar/category in the plots.
4. Keep diagram text larger than axis tick text; keep panel labels consistent.
5. Save intermediate assets so the final figure remains editable.

## Quality Gates

Before final delivery, check:

- Claim is visible from the figure without reading the whole caption.
- Every arrow has a defensible meaning: sequence, data flow, regulation, or dependency.
- Text remains legible at target journal width.
- Colors remain distinguishable in grayscale or by colorblind readers.
- Axes include units and error definitions where relevant.
- Statistics include test, `n`, sidedness, and correction when shown.
- SVG/PDF text is editable where possible.
- No panel is only decorative.

## References

- Read `references/data-figures.md` for Nature-style data figure rules, palettes, export policy, and common plot patterns.
- Read `references/diagrams.md` for flowchart, architecture, mechanism, Graphviz, Mermaid, and draw.io guidance.
- Read `references/mixed-figures.md` when assembling diagrams plus plots into one multi-panel page.

## Attribution

This skill is an original workflow scaffold inspired by public research-figure skill patterns, especially the contract-first approach used by Apache-2.0 `Yuan1z0825/nature-skills`. It does not vendor upstream source files.
