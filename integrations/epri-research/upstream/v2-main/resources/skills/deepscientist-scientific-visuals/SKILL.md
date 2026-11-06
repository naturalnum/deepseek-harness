---
name: deepscientist-scientific-visuals
description: Plan, create, place, and review optional scientific visuals for DeepScientist reports, papers, presentations, and artifact previews. Use when deciding whether a chart, verified source image, mechanism diagram, workflow, structure view, single-cell plot, or multi-panel figure would materially improve understanding; when routing to report_chart, research-figure-diagram, ds-paper-plot, or ds-nature-figure; or when checking SVG/vector legibility and a restrained grayscale-first style.
---

# DeepScientist Scientific Visuals

Treat a visual as an evidence-conditioned part of the scientific argument, not
as decoration. When a completed report contains at least two comparable numeric
observations or a real series, provide one lead visual; use two to four total
visuals only for distinct reader questions. Prefer a documented waiver over an
unsupported, redundant, or decorative one.

## SOP

1. State the reader question and the exact evidence the visual would expose.
2. Read [visual-selection.md](references/visual-selection.md) and choose the
   smallest useful medium. Stop if prose or a compact table is clearer.
3. Load only the reference required for the selected route:
   - SVG, vector, palette, typography, or accessibility:
     [grayscale-vector-style.md](references/grayscale-vector-style.md)
   - One evidence-bearing plot:
     [single-figure-quality.md](references/single-figure-quality.md)
   - One multi-panel manuscript figure:
     [multi-panel-composition.md](references/multi-panel-composition.md)
   - Figure ordering across a report or paper:
     [report-visual-narrative.md](references/report-visual-narrative.md)
4. Use the existing implementation route. Do not create a parallel visual
   backend:
   - standard typed data chart: `deepscientist-report-chart` and `report_chart`;
   - mechanism, workflow, architecture, or bespoke vector figure:
     `research-figure-diagram`;
   - paper-template plot: `ds-paper-plot`;
   - journal-ready multi-panel package: `ds-nature-figure`;
   - morphology, structure, spatial, or instrument evidence: a verified source
     image or the relevant domain viewer;
   - explanatory bitmap: `deepscientist_image_generation` only when the image is
     conceptual rather than quantitative evidence.
5. Render, inspect, and correct at most one concrete visual defect. Preserve the
   underlying data, labels, evidence ids, editable source, and a preview.
6. Register an accepted result through `science_artifact` and place it beside the
   section it explains. If no meaningful visual data exists, continue without a
   visual and pass the concrete reason only as `payload.internalVisualWaiverReason`.
   This is private validation metadata; never repeat it in the report or final reply.

## Default Style

- Recommend transparent or white backgrounds, near-black primary marks, gray
  secondary marks, and restrained linework.
- Distinguish series with line weight, dash, marker, hatch, shape, or direct
  labels before adding color.
- Allow a small semantic accent only when grayscale would hide scientific
  meaning, status, signed direction, or a domain convention.
- Prefer SVG/PDF for editable diagrams and charts. Keep text selectable and
  include an accessible title and description.
- Avoid gradients, glows, decorative shadows, dense legends, and repeated
  versions of the same result.

Run `scripts/visual_lint.py <file.svg>` for an advisory grayscale/vector check.
Its findings guide review; they never block publication by themselves.

## Boundaries

- Never infer missing values, statistics, labels, biological structures, or
  visual observations to make a figure look complete.
- Keep predictions, associations, model confidence, and experimental validation
  visually and verbally distinct.
- Do not upload private sequences, patient data, structures, or unpublished
  results to an external visual or model service without explicit authorization.
- Preserve the source and license notes in
  [openai4s-provenance.md](references/openai4s-provenance.md) when reusing the
  adapted OpenAI4S guidance.
