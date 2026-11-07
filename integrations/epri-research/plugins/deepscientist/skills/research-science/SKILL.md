---
name: research-science
description: Guide scientific work in DeepScientist. Use real tools for analysis, keep the sources and files behind important conclusions, choose extra domain Skills only when needed, and publish a clear Science report for user-facing results.
---

# Harness runtime mapping

For structured electric-power tasks, read `research-power`: use `research_method_catalog`, `research_task_create/get/open`, the task-linked Airalogy table, native record/evidence reviews and `research_task_report`. Explicitly imported protocol methods use the same flow. Unknown scenarios stay pending until a method is provided. An installed method does not establish its scientific suitability.

This is the V2 science workflow adapted for power engineering and general research. Specialist life-science projects are outside this customer edition. This mapping takes precedence over legacy tool names below.

- Every research_* call is scoped to the active conversation supplied by Harness. Never invent a conversation identity or read another conversation's private state.
- The workbench and artifact details open in native right-sidebar tabs in the same Harness page. For evidence_review, roadmap_select, lab_skill_publish, engine_package_review and record_submit/reopen/archive/restore, call the corresponding research_* tool with the exact current version and concrete action. It asks the authenticated human directly in this conversation, then verifies that the content is unchanged. Closing, skipping, custom text or declining does not approve. Do not use a separate ask-user response as an approval token; never obtain human credentials. If platform account adaptation is unavailable, report that limit and do not bypass it. Import, Git authorization and other human-only operations still require their existing workbench controls.
- research_science_state / research_science_revision are the canonical versioned research ledger. Use research_roadmap_put for original deepscientist.science.research_route.v1 routes; research_roadmap_select is human-only. Native Goal is the only continuation controller.
- Legacy research_evidence/science_artifact evidence, claim and report actions map to research_evidence_put, research_claim_put and research_report_put. Preserve source hashes, measured/synthetic/literature/estimated basis and limitations. Only research_evidence_review records human review; never self-approve.
- research_protocol_put and research_record_* own immutable AIMD protocols and versioned records. Preserve field and table-column ownership. Submitting or reopening requires a human.
- research_engine_packages / research_engine_package_get list imported code. Only humans import and approve executable packages. Use research_engine_run then research_engine_run_get; cancellation uses research_engine_cancel. The pinned Airalogy Python engine runs without network or host credentials. Parse, assign, validate, import_records, migrate_schema and workflow transitions retain original upstream semantics.
- Execution is asynchronous. Poll the returned run ID; distinguish failed, validation_failed, cancelled, timed_out, interrupted and succeeded. Successful execution does not establish scientific truth. research_engine_outputs_save saves generated files; records require explicit follow-up edits and human checks.
- research_chart_render creates native chart artifacts. Native Harness delivered files are registered in this conversation. research_workspace_export creates validated .aira including attachments and the research revision ledger. Archive inspection is research_archive_inspect; import is human-only research_workspace_import and creates drafts.
- research_local_search searches this conversation's text attachments and saved research; research_literature_search searches configured external metadata providers. Neither verifies scientific correctness. Uploaded PDF/image full text is available after research_document_extract, with page numbers and OCR review markers.
- Legacy lab_skill deposition maps to research_lab_skill_put. Humans publish or withdraw via research_lab_skill_publish after source review; published skills become virtual lab-* skills in the local Harness library. Drafts remain private to this conversation.
- Legacy project_workspace/Git actions use native Harness workspace/filesystem/Git tools under their authorization rules. Preserve concurrent changes; no automatic branch reset or blanket staging. Do not call legacy Electron IPC names.
- The workbench renders saved research routes and pinned evidence as interactive graphs. Save real milestones with research_roadmap_put; do not create demonstration milestones in a customer's conversation. research_project_git_state and research_project_git_commit read the repository explicitly associated by the human in the Git progress tab. research_project_git_bind is human-only. Use the separate project_git_working/checkpoint/branch/policy/merge/revert operations described below for authorized writes; history viewing itself is read-only.
- External databases, model-dependent assigners and proprietary Platform services still require their actual runtime and credentials. Read skill prerequisites and report unavailable dependencies honestly.
- Relative ../ resources below are under the packaged upstream/v2-main/resources/skills/science directory; use the absolute sibling resource base published by this package or locate that folder before reading.

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
- Use `research_literature_search` to find paper metadata; read full text using native web/file tools before asserting findings.
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
| literature or public scientific databases                    | `research-literature` from the installed catalog |
| packages, GPU/HPC, SSH, or remote computation                | `../compute/SKILL.md`                          |
| econometrics, causal inference, surveys, or qualitative work | `../empirical/SKILL.md`                        |

Read only the leaf references selected by that guide. If a guide is missing,
continue with the core workflow and the tools that are actually available. Do
not search guessed application folders or invent a Skill path.

For a machine-learning task, optionally load `openai4s-audit-dataset` before
trusting tabular inputs, `openai4s-plan-ml-experiment` before fixing the split
and test boundary, or `openai4s-evaluate-model` for held-out metrics and
uncertainty. These are supporting protocols, not mandatory stages.

Use only installed domain skills and verify their runtime dependencies before execution.

## Current Harness capability mapping (2026-10-26)

Use the installed research_ tools with the current conversation identity. project_git_working previews concrete changes and a state token. Human-approved project_git_branch creates a separate directory; native Harness filesystem/terminal/Goal work must explicitly use the returned path. project_git_checkpoint saves selected files. Agents may use it only within a human-enabled project_git_policy for that exact managed worktree and file list. Completed roadmap stages trigger that policy. Merge and revert require human workbench actions. Never claim a saved route starts a task automatically.

document_status checks the offline PDF/OCR runtime; document_extract indexes an existing conversation attachment and document_text reads pages. local_search includes extracted pages with page numbers; OCR text needs source review. workspace_import restores research history into fresh local identities and pending reviews; published methods return as drafts.

For existing original mathematics portfolios or finance report cards, store actual JSON with attachment_put using .math.json or .finance.json. The domain results page validates and renders those formats. This does not run Lean, provision market data, execute a factor backtest or certify conclusions.
