---
name: deepscientist-writing
description: Router for scientific writing, literature review, PDF exploration, manuscript/report generation, figure polish, citation checking, LaTeX, slides, and reviewer-facing revisions in Science Mode.
---

# DeepScientist Writing Router

Use this skill when the task is primarily about literature synthesis, writing,
figures, tables, reports, manuscripts, LaTeX, PDF reading, citations, review,
rebuttal, or presentation material.

## Merge Map

Prefer one narrow route:

- Literature scouting/review: `ds-scout`, `ds-write`,
  `kdense-literature-review`, `kdense-paper-lookup`, AERS
  `aer-lit-review-*`, `aer-literature-survey-generator`.
- Scientific and technical reports: `kdense-scientific-writing` for
  reader-first structure, precise quantitative wording, reporting guidelines,
  and figure/table selection; use `ds-write` when the output belongs to a
  durable paper evidence contract.
- Manuscript architecture: `ds-paper-outline`, `ds-write`,
  `ds-nature-polishing`, `ds-nature-data`, AERS `aer-paper-*`.
- Independent review/rebuttal: `ds-review`, `ds-rebuttal`, AERS
  `aer-referee-report`, `aer-paper-referee-revise`,
  `aer-reference-verify`, `aer-citation-fidelity`.
- Figures and tables: `ds-nature-figure`, `ds-figure-polish`,
  `ds-paper-plot` as a quarantined template reference, `kdense-matplotlib`,
  `kdense-seaborn`, `kdense-scientific-visualization`,
  AERS `aer-figure`, `aer-latex-table`.
- PDF and format work: `kdense-pdf`, `kdense-docx`, `kdense-pptx`,
  `kdense-markitdown`, AERS `aer-md-to-docx`, `aer-compile-latex`.
- Presentation and dissemination packs: `deepscientist-presentation` for
  reusable paper assets, posters, bilingual blogs, narrated videos, and
  interactive reel viewers.
- Slides/posters: `ds-nature-paper2ppt`, `kdense-scientific-slides`,
  `kdense-latex-posters`, AERS `aer-create-talk`, `aer-marp-*`; route
  poster/reel-style packages through `deepscientist-presentation` first when
  the user wants a shareable research communication bundle.
- JimLiu science-skills equivalents, when materialized later:
  `literature-review`, `pdf-explore`, `figure-style`, `figure-composer`,
  `paper-narrative`, `indication-dossier`.

## SOP

1. Decide whether the output is a report, manuscript, figure, table, PDF,
   slide deck, or review package.
2. Choose one route first; add a second only when there is a real stage change.
3. Use `research_evidence` for literature/database claims.
4. Register citations, PDFs, extracted passages, figure sources, tables,
   LaTeX source, compile logs, and generated PDFs as evidence/artifacts.
5. Use artifact `version` for revised figures/manuscripts and snapshot the
   source plus rendered output.
6. For a Science report panel, keep the `science_artifact` reader-first block
   and card contract authoritative; writing skills improve structure and
   explanation but do not introduce unsupported UI surfaces.

## Boundaries

Writing skills provide workflow and style guidance. They are never evidence by
themselves. Claims still need evidence ids and claim types.
