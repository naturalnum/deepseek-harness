---
name: report-authoring
description: Write reader-first financial research notes and scientific reports that answer the user's question clearly, choose useful evidence-bound visuals, and publish a concise, reusable result. Use when a task asks for a report, research summary, paper-style result, financial note, chart-led explanation, or a polished answer that should remain openable in DeepScientist Preview.
---

# Report Authoring

## Purpose

This is a shared editorial layer for Financial Report Mode and Science Mode. It
does not replace either mode's MCP contract, domain Skill, or evidence rules.
It makes the result useful to a reader who did not watch the run: answer first,
show the decisive comparison or visual, explain what it means, then expose the
supporting detail.

Read progressively:

1. `../financial-report-research/references/report-sop.md` for financial notes;
2. `../science-artifact/references/report-writing.md` for scientific reports;
3. `references/report-templates.md` for a lightweight outline;
4. `references/visual-composition.md` when a figure, chart, or preview is useful;
5. `references/chart-workflow.md` when a native DeepScientist chart must be
   selected, rendered, registered, embedded, or repaired;
6. `references/report-templates.md#worked-examples` when the expected writing
   level is unclear or the draft reads like a tool log;
7. `references/deep-research-sop.md` for a comprehensive or multi-turn report;
8. `references/editorial-rubric.md` once, before publish, as a warning checklist.

## Workflow

1. Restate the user's question as a one-sentence reader goal. If the request is
   a simple lookup, use a compact answer and do not force a long report.
2. Freeze only the scope needed to avoid ambiguity: population or universe,
   period/as-of, units, comparison, and intended decision. Ask one concise
   structured question only when the missing choice changes the answer.
3. Gather the smallest sufficient inputs. Keep facts, computed values,
   interpretations, hypotheses, and missing values distinguishable.
4. Draft the direct answer before the evidence inventory. Put the strongest
   result and one useful visual near the top; give every visual a reader job,
   caption, units or denominator, period, and a nearby plain-language takeaway.
   For a native chart, follow `references/chart-workflow.md`; do not stop after
   rendering because the returned Artifact must also be registered and embedded.
5. Use only sections with material content. Do not add empty risk, valuation,
   methods, or appendix blocks merely to imitate a broker or journal template.
6. Keep evidence and permissions as guardrails, not as the user experience:
   never fabricate a value or source, but do not make the reader walk through
   receipts, raw JSON, or tool chronology to reach the answer. Put those in
   collapsible detail or the project files.
7. Publish one structured Science Report when the request calls for a report.
   Update it rather than creating duplicate terminal reports. A provider gap may
   yield a clearly labelled Partial Report when useful evidence remains.
8. End with a conditional next action or an explicit open question. A report is
   complete when the reader knows what is supported, what is uncertain, and what
   to do next, not merely when a tool call succeeds.

## Presentation defaults

- Prefer short paragraphs, descriptive headings, and one to three bold reading
  anchors per substantive section. Never bold an entire paragraph.
- Lead with a quiet black/gray answer surface; use status color only for a small
  state marker. Keep source lists, raw logs, and large tables secondary.
- Use one lead visual and add supporting visuals only for distinct questions.
  Prefer deterministic charts, tables, verified source images, and editable
  diagrams over decorative or generated numeric imagery.
- For every new native v2 chart, set `visualIntent.question`, `readingMode`, and
  `placement`. Use `lead` only when the runtime marks the recipe lead-eligible
  and the chart directly answers the user's main question.
- Let Preview provide the Chart/Data switch for exact-value inspection. Do not
  repeat the same values as another primary table or card.
- Keep the first viewport scannable: title, answer, as-of/scope, lead visual or
  compact metrics, then the first interpretation. Longer provenance is lazy or
  collapsible.

## Boundaries

Follow the active mode and MCP schema for saving, evidence links, permissions,
and publication. This Skill provides optional editorial guidance; it must never
invent facts, bypass access controls, turn a simulation into trading advice, or
block a useful partial answer merely because an optional module is unavailable.
