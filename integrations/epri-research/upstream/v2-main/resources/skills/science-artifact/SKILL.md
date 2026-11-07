---
name: deepscientist-science-artifact
description: Use the science_artifact MCP tool to save and update scientific evidence, conclusions, reports, files, versions, annotations, and Preview pages. Use when a Science Mode result must remain openable, checkable, or reusable.
---

# DeepScientist Science Artifact

Use `report-authoring` for the reader-facing structure, visual hierarchy, and
answer-first prose. Use `science_artifact` to keep the answer and the material
behind it together.
Use `project_workspace` for the source project's Git history. Use
`research_roadmap` only for a research goal with stages or route choices.

## Usual sequence

1. Reuse a current runtime summary; otherwise call `status` once when starting
   or resuming.
2. Create or update the main report or run bundle.
3. Save the important sources, results, conclusions, files, and links between
   them.
4. Call `snapshot` when new or changed files are needed to inspect or repeat the
   work.
5. Call `publish` before the final reply so the result appears in Preview.

Keep one `runId` and one to three stable conclusion ids for one objective.
Update them as the work changes instead of creating a copy after every message.

## Choose an action

| Action       | Use it for                                                                         |
| ------------ | ---------------------------------------------------------------------------------- |
| `describe`   | read the full payload and display instructions when this Skill is not enough       |
| `status`     | inspect the current run and project records                                        |
| `reserve_id` | choose a stable id before a file or result exists                                  |
| `get`        | read current content and revision when starting, resuming, or resolving a conflict |
| `list`       | find saved reports, files, evidence, conclusions, or warnings                      |
| `query_many` | read two or more bounded targets from one run/project snapshot                     |
| `transact`   | atomically create, patch, or replace a related batch and return all receipts       |
| `create`     | add a new report, file, evidence item, conclusion, page, or source link            |
| `patch`      | change part of an existing item                                                    |
| `replace`    | intentionally replace an entire item                                               |
| `append`     | add an event, log, message, Skill-use note, or link                                |
| `version`    | save a changed scientific output while keeping the earlier version                 |
| `snapshot`   | preserve the files needed to inspect or repeat a result                            |
| `publish`    | make the current report visible in Preview                                         |
| `annotate`   | attach a user note to a file or selected region                                    |
| `focus_page` | open or focus a report, file, or Viewer page                                       |

The older Git actions on this tool still work, but use `project_workspace` for
new project status, checkpoint, branch, or comparison work.

## Update without duplicates

- For two or more independent reads, use one `query_many` call and request only
  fields needed for the next decision.
- For related writes, use one `transact` call with unique `opId` values, stable
  explicit target ids, and `atomicity=all_or_nothing`. An invalid later item
  leaves no earlier mutation. Reuse `nextContext.revisions`; do not call
  `status` or `get` immediately after success.
- Let the host-provided `toolCallId` act as the idempotency key when available.
  A retry replays the same receipt; never reuse a command id with changed data.
- Read an existing item once before the first change. Pass its revision as
  `baseRevision`.
- After a successful change, reuse `mutationReceipt.currentRevision`,
  `resultingRevision`, or the returned revision for the next change. Read again
  only after a mismatch or possible concurrent edit.
- Use `patch` for metadata, labels, report text, pages, or display settings.
- Use `version` when the scientific content or generated file changes.
- Use `replace` only when the whole object is intentionally being rewritten.
- For an item created in an earlier conversation in the same project, use
  `list`, then `get` with its original `runId`, id, and version. Do not recreate
  it in the current run merely because the conversation changed.

## Read details only when needed

| Need                                                    | Read                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| save files, revisions, exact code lines, or annotations | [references/files-and-revisions.md](references/files-and-revisions.md) |
| write or update a Science report                        | [references/report-writing.md](references/report-writing.md)           |
| add a native scientific Viewer or structure preview     | [references/viewers.md](references/viewers.md)                         |
| present route choices or connect a route to Git         | [references/research-roadmap.md](references/research-roadmap.md)       |

Do not read all references by default. If an exact payload remains unclear,
call `describe` instead of guessing fields.

## Keep conclusions checkable

- Save an important observation or analysis output once, then link it only to
  the conclusion or report text it supports.
- A non-hypothesis conclusion must point to saved evidence or a saved result.
- Keep methods, files, logs, and environmental details available, but do not
  turn the report into a chronological tool log.
- Save short factual memory only for changes, paths, evidence ids, and
  decisions. Never save chain-of-thought, credentials, tokens, or private
  prompts.
- If support is incomplete or conflicting, narrow the conclusion and leave the
  report `partial` or `blocked` with a plain explanation.

## Use the right dedicated tool

Do not use `science_artifact` to change these domain lists:

- financial factors: use `factor_registry`;
- target candidates: use `target_portfolio`;
- mathematics statements: use `math_portfolio`;
- staged research routes: prefer `research_roadmap`.

Use `science_artifact` for the evidence, figures, tables, files, conclusions,
and final reports that those domain records refer to.

When the appropriate visual form is not already clear, read
`deepscientist-scientific-visuals` first. For a standard data chart embedded in
a report, then read `deepscientist-report-chart` and use `report_chart` so the typed specification,
evidence links, Preview render, and export files stay aligned. Use
`research-figure-diagram` for mechanisms, workflows, architectures, and mixed
figures. Use `ds-nature-figure` only when a journal-ready multi-panel figure or
Nature/high-impact export package is itself a deliverable. In Codex, use
`deepscientist_image_generation` for a small number of reviewed explanatory
bitmaps when a deterministic chart or editable vector diagram cannot carry the
idea clearly; never use it to invent scientific observations or numeric plots.

## Before publishing

- the main answer is easy to find;
- every included visual has a distinct reader job and a nearby interpretation;
- when the report contains at least two comparable numeric observations or a
  real series, one evidence-bound lead visual is required for completed status;
  use two to four total visuals only when they answer different questions;
- generated explanatory bitmaps are normally limited to one or two per report;
  charts, verified source images, and editable diagrams should carry the rest;
- when no meaningful visual data exists, continue without a visual and pass a
  concrete `payload.internalVisualWaiverReason`; this private validation value
  must never appear in report prose, cards, limitations, data gaps, evidence, or
  the final reply, and observations must never be invented to fill a view;
- each important conclusion has supporting material or is labelled as a
  hypothesis;
- generated files exist and are attached to the correct version;
- the report states important conflicts, missing checks, and limitations;
- the Preview page opens the intended report or Viewer; and
- no secret or temporary local URL was saved.

If `publish` reports a missing link, correct it once and publish again. If the
problem remains, preserve the partial result and tell the user what is missing.
