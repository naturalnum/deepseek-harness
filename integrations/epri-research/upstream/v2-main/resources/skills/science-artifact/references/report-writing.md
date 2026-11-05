# Science Report Writing

Read this file when creating or updating the user-facing Science report.

## Reading order

Write for a scientifically literate reader who did not watch the run:

1. answer the question in plain language;
2. show the decisive evidence and comparison;
3. explain the relevant mechanism or method;
4. state where the conclusion may not apply;
5. give the next useful check or action.

Use `summary` for one bottom-line sentence. Give each section one reader
question and one main takeaway. Explain an uncommon abbreviation or technical
term briefly on first use, then use one consistent name.

## Report shape

Choose the lightest structure that still answers the user's question. For a
substantive research result, use this order:

1. **Question and scope** — the research question, population or dataset,
   comparison, `asOf`/study period, and the intended audience.
2. **Abstract-style answer** — one direct answer, the decisive result, and its
   confidence or evidence boundary. This is a reader-facing abstract, not a
   model-thinking summary.
3. **Key result and figure** — a real chart, table, verified image, or result
   card when it makes the answer faster to check; put a plain-language takeaway
   directly below it.
4. **Methods and provenance** — inputs, analysis method, controls/comparators,
   software/data versions, and enough detail to reproduce the result.
5. **Results and interpretation** — organize by the question or hypothesis,
   not by the order in which tools happened to run. Separate observation from
   interpretation and include alternative explanations when relevant.
6. **Limitations and next check** — missing data, uncertainty, applicability,
   failure conditions, and the smallest useful follow-up.
7. **Conclusion** — one concise restatement of what is supported, what remains
   open, and what the reader should do next.

For a manuscript-like request, use familiar Introduction/Methods/Results/
Discussion/References labels and put figure legends beside the figures. For a
short engineering or data question, keep the same logic but use compact
headings. Never turn a report into a chronological MCP log or an evidence list
without an answer.

## Evidence and numbers

- Quantify verified results with units, sample size or denominator, comparator,
  and uncertainty when available.
- Let tables and figures carry exact values. Use prose to explain the main
  pattern, why it matters, and where it may fail.
- Every visual must have a reader job: name the comparison, trend, mechanism,
  uncertainty, or quality check it shows, include units/sample size and source,
  and add one sentence explaining how it answers the question. Do not use a
  chart as decoration or repeat the same result in three visual forms.
- Put evidence ids in the block or item `evidenceIds` field. Do not type literal
  `[E1]` or internal ids into prose.
- Treat Markdown bold as a section-level reading aid. In each substantive
  answer-bearing section, normally use one to three supported bold spans when
  they improve scanning. A span may be a keyword, a key number together with
  its unit and comparator, a decisive clause, or one complete takeaway sentence.
- Very short, methods-only, reference, and process sections may use fewer or no
  bold spans. Keep emphasized text to roughly one quarter of a section or less,
  avoid two consecutive fully bold sentences, and never bold a whole paragraph,
  title, citation, evidence id, command, field label, or routine caveat list.
- If evidence is missing or conflicting, narrow the conclusion and mark the
  report `partial` or `blocked`.

## Choose report blocks

- `paragraph`: one conclusion or interpretation;
- `bullet_list`: three to five parallel findings, ordered by importance;
- `checklist`: criteria or remaining work with clear statuses;
- `artifact_embed`: one important figure, table, PDF, notebook, or HTML result
  where it supports the argument;
- `artifact_ref`, `figure_ref`, or `table_ref`: secondary material;
- `result_summary`: one primary quantitative result or validation state that
  should be visible at a glance.

Do not repeat the structured Evidence, Claims, Methods, Artifacts, or Reference
Evidence areas as decorative report cards.

## Result summary

Use at most one `result_summary` for a report. It fits experiments, model
evaluation, benchmarks, simulations, replication, engineering checks, data
audits, or quantitative evidence synthesis. Omit it for planning, file lists,
open-ended ideas, descriptive exploration, or several unrelated primary
outcomes.

Keep one takeaway, one primary metric, at most three supporting metrics, the
minimum facts needed to understand scope, and one decision-relevant note. Mark
each metric as `measured`, `synthetic`, `literature`, `estimated`, or `pending`.
Measured, synthetic, and literature values need evidence ids. A command string
alone is not a measured result. A pending primary metric keeps the report
partial.

In `result_summary`, normally bold the decisive takeaway and optionally one
contextualized comparison, key fact, or safety/scope boundary. A complete short
takeaway sentence may be bold. Do not isolate a number from the unit, denominator,
or comparator needed to interpret it, and do not bold the entire summary.

Use `variant="survival_prediction"` only for a real target-cohort evaluation.
A measured primary value then needs a confidence interval plus endpoint,
participants, events, and validation details.

## Embedded artifacts and cards

Prefer one main `artifact_embed` per section. Its caption should say what is
shown, the comparison, units or sample size when relevant, and the takeaway.
The Artifacts area already lists every declared file, so do not add one block
for every file.

## Visual review before publish

For a completed or partial report, first ask whether a visual would make the
answer faster or more accurate to understand. When useful, keep one decisive
lead visual near the result summary. Add a comparison, mechanism, robustness,
subgroup, limitation, or applicability visual only when it answers a distinct
reader question. There is no minimum count; omit every slot that lacks real
evidence or a clear reader job.

Choose the visual by the information it carries:

- use `report_chart` for a verified comparison, trend, interval, relationship,
  distribution, composition, or matrix;
- use a verified source image for morphology, spatial structure, anatomy,
  instrument output, or another scene the reader must inspect;
- use a reviewed explanatory figure for a mechanism or workflow, and label it
  as a schematic rather than experimental evidence;
- use `ds-nature-figure` when the requested deliverable is a journal-ready
  multi-panel figure package; follow its Python-or-R selection gate;
- in Codex, use `deepscientist_image_generation` for at most one or two
  explanatory bitmaps when morphology, a conceptual spatial scene, or a compact
  mechanism overview genuinely benefits from image generation. Inspect exact
  labels and scientific consistency, and register the verified file as a figure
  artifact. Never use an image model for numeric plots, evidence badges,
  citations, effect sizes, or dense text diagrams;
- use prose or a table for one or two facts, exact lookup, missing values, or
  incomparable evidence.

Every lead or supporting visual needs an `artifact_embed`, a caption that states
what is shown and why it matters, and the relevant Evidence ids on the block or
artifact. Place it immediately after the paragraph that interprets it. Do not
repeat the same result as an image, chart, and table. Keep raw data, source files,
and redundant diagnostic plots in compact references or collapsed evidence.

If no visual would improve understanding, continue without one. A brief
`payload.internalVisualWaiverReason` may preserve that editorial decision only
as private validation metadata; never copy it into reader-facing report content
or the final reply. Never generate a decorative image, turn an illustrative model image
into scientific evidence, or invent data merely to satisfy a recommendation.

For Finance reports, use the `cardAuthoring.reportModules` information returned
by the runtime. Give every `cardDraft` its `moduleId`; override its report
section only with a role the module allows. A saved card that is not referenced
by a report `card_ref` is not visible and does not count as complete.

Pages describe layout, not scientific truth. They may open reports, previews,
inspectors, code, logs, LaTeX, PDFs, notebooks, evidence, or native Viewers.
