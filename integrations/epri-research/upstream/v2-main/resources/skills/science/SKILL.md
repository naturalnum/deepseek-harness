---
name: deepscientist-science
description: Guide scientific work in DeepScientist. Use real tools for analysis, keep the sources and files behind important conclusions, choose extra domain Skills only when needed, and publish a clear Science report for user-facing results.
---

# DeepScientist Science

Do the scientific work in the real runtime, keep enough information to check
the result, and explain the answer clearly to someone who did not watch the
process.

For user-facing reports, read `../report-authoring/SKILL.md` before choosing the
outline or visual hierarchy. For comprehensive or multi-turn work, also read
`../report-authoring/references/deep-research-sop.md`. These are editorial and
research-process layers, not replacements for the scientific evidence and
artifact contracts below.

## Core rules

- Use shell, Python, R, LaTeX, notebooks, project pipelines, SSH, or an
  explicitly approved remote tool for real computation and inspection.
- Before presenting a command as runnable, record its working directory and run
  a small relevant check from that directory. If data, software, hardware, or
  credentials are unavailable, say that the result was not verified.
- Use `research_evidence` to find and read papers or database records.
- Use `science_artifact` to save evidence, conclusions, reports, files,
  versions, and Preview pages.
- Use `deepscientist-scientific-visuals` when deciding whether a visual helps
  or which visual form fits. Use `deepscientist-report-chart` and
  `report_chart(action="render")` for a standard evidence-bound chart embedded
  in the report. Register its returned artifact draft and reuse the same typed
  spec and SVG for Preview and export. Visuals are optional and have no quota.
- Use `project_workspace` for the project's Git status and saved research
  stages. Every meaningful research checkpoint records the route that produced
  it as `explore`, `deepen`, `fuse`, `repair`, or `stop`; initialization and
  presentation-only checkpoints are exempt.
- A tool or Skill explains how to work; it is not evidence for a scientific
  conclusion.
- Unless the user asks only to brainstorm in chat, update the task's Science
  record and publish a concise report before the final reply.
- Do not create `SUMMARY.md`, `REPORT.md`, or a similar file merely to repeat
  the answer. Create a document file only when it is itself a requested output.
- When the request is a governed Kaggle or competition task involving rules,
  kernels/notebooks, leaderboard evidence, or submission, recommend Challenge
  Mode once through `user_input` if it is not active. Until the user chooses,
  keep capability discovery Lead-owned and bounded; do not fan out repeated CLI,
  authentication, network, or submission probes across a general Science Team.

## Main workflow

1. Identify the question, project, expected output, available inputs, and
   assumptions. Reuse these facts across turns.
2. Check the earlier conversation, answered questions, and saved project state
   before asking the user again.
3. Inspect the input data or sources before making claims. Choose only the
   extra topic guide needed for the current step.
4. Run the analysis. Keep the command, working directory, inputs, outputs,
   relevant software, logs, and failures.
5. Register the sources and results that support the answer. Do not register
   every routine step as a separate item.
6. Create or update the main report or run bundle. Attach useful figures,
   tables, datasets, notebooks, manuscripts, PDFs, or interactive views. Do
   not duplicate one dataset as a chart, table, and card without distinct
   analytical roles.
7. Save the files needed to inspect or repeat the work. Do not include secrets.
8. Keep one to three stable conclusions for the same objective and update them
   when the evidence changes.
9. Publish the report. If publication identifies a missing link between a
   conclusion and its source, repair it once. If it is still missing, keep the
   report partial and explain what remains unverified.

## When to ask the user

- Continue a single safe and inexpensive route without interrupting the user.
- When two to four meaningfully different routes are available, show the
  choices through the DeepScientist MCP `user_input` tool and wait for the
  answer before continuing. In Codex, resolve the exact
  `mcp__deepscientist_user_input__user_input` entry from `ALL_TOOLS`; never call
  native `request_user_input`, which cannot open the DeepScientist question card
  in Default mode.
- Ask again only when the user changes the scope or an earlier answer no longer
  applies.
- A proposed route is not a Git branch. Create a branch only after the user has
  chosen it and the work actually needs isolation.

## Describe results honestly

Label important conclusions by how they were obtained:

- `computed`: produced by a real run in the current project;
- `parsed`: read from supplied files, papers, databases, or metadata;
- `digitized`: extracted from a figure, PDF, screenshot, or selected region;
- `hypothesis`: plausible but not yet verified.

A computed conclusion should point to its inputs, code or command, output, and
environment when those exist. A Preview rendering is not proof by itself. Do
not turn association, docking, model confidence, or a polished explanation into
stronger evidence than the underlying result supports.

## Save and display results

- Keep the same `runId` and stable ids for the same objective. Update existing
  items instead of creating a new copy after every message.
- Read the current revision before the first update, then reuse the revision
  returned by each successful update.
- Create a new version when a visible scientific result changes. Keep earlier
  versions available unless the user asks otherwise.
- Save the source files, outputs, code, logs, configuration, notebooks, and
  small derived tables needed to inspect or repeat the work.
- Use an interactive Viewer only when it makes the result easier to inspect.
  Exact report, file, citation, and Viewer instructions live in
  `deepscientist-science-artifact`.

## Choose extra Skills only when needed

Start with this Skill and `deepscientist-science-artifact`. After reading the
request and current project state, choose at most one main topic guide and one
supporting guide:

| Need                                                         | Read                                           |
| ------------------------------------------------------------ | ---------------------------------------------- |
| first project setup or missing environment information       | `../onboarding/SKILL.md`                       |
| multi-stage research, saved stages, or worktrees             | `../workflow/SKILL.md`                         |
| hypotheses, novelty, or candidate research directions        | `../ds-idea/SKILL.md`                          |
| manuscripts, reports, figures, citations, or review          | `../writing/SKILL.md`                          |
| optional visual selection, composition, or vector review     | `../deepscientist-scientific-visuals/SKILL.md` |
| slides, posters, blogs, or research videos                   | `../presentation/SKILL.md`                     |
| literature or public scientific databases                    | `../databases/SKILL.md`                        |
| targets, sequences, omics, pathology, or structures          | `../deepscientist-bio/SKILL.md`                |
| packages, GPU/HPC, SSH, or remote computation                | `../compute/SKILL.md`                          |
| econometrics, causal inference, surveys, or qualitative work | `../empirical/SKILL.md`                        |

Read only the leaf references selected by that guide. If a guide is missing,
continue with the core workflow and the tools that are actually available. Do
not search guessed application folders or invent a Skill path.

For a machine-learning task, optionally load `openai4s-audit-dataset` before
trusting tabular inputs, `openai4s-plan-ml-experiment` before fixing the split
and test boundary, or `openai4s-evaluate-model` for held-out metrics and
uncertainty. These are supporting protocols, not mandatory stages.

Route diagnosis, treatment, patient-facing reports, and clinical decisions to
Medical Evidence Mode when possible.
