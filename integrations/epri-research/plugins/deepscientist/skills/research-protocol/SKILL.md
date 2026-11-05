---
name: research-protocol
description: Create, refine, or reuse an executable research workflow and its structured run records when Knowledge Deposition is active. Use only for repeatable multi-step laboratory, computational, evidence, or analysis procedures with explicit inputs, checkpoints, reviewable outputs, and a real need for reproducibility or handoff; do not use for one-off work or abstract method notes.
---

# Harness integration

Interactive records: read `record.calculationBinding` before editing a run. For a bound record, `research_record_update` automatically executes the approved Airalogy `mode="auto"` assigners, validates and saves the input and computed results together, and updates declared charts. Write only evidence-backed editable inputs; do not invent automatic values, copy stale results into inputs, or set human review checks. Preserve `expectedRevision` and use a stable request id for retries; reload on a version conflict. Inspect `record.calculation` for pending/error fields and producing run/source metadata, and resolve failures before requesting submission. Binding a source package to a record is a human-only workbench action, with exact protocol source matching. Imported archives retain historical results but never restore code approval or active execution bindings. The engineering example is `examples/interactive-power/`; its UI entry is “载入设备数据质量示例” in the execution workspace.

The original V2 authoring guidance follows. Use research_protocol_put/get and research_record_create/get/update/export. Human record submission and reopen/archive/restore are requested through the corresponding research_* tool: it shows the exact action, current record and checks as a native question in the conversation. Only an explicit authenticated human confirmation executes it; a declined or stale question never approves. Do not obtain human credentials or set checks on the human's behalf. Agent data changes reset prior review checks. Use research_attachment_put/get for real files up to 2 MiB; a file field must contain the returned attachment:SHA256 reference, not a filename. Python execution uses research_engine_* with a pinned Docker image and human-approved source packages; research_engine_package_review requests native conversational confirmation for an exact source hash. Check research_engine_status before running; poll research_engine_run_get and preserve validation failures. Export .aira with research_workspace_export; inspection uses research_archive_inspect and import is human-only research_workspace_import in the workbench. Imported records are drafts. Saving AIMD alone is not proof of Python validation. Use research_lab_skill_put for drafts and research_lab_skill_publish to request human publication confirmation. Native Harness tools handle project Git; legacy lab_skill/project_workspace IPC APIs and official Platform cloud synchronization are not available. This customer edition serves power engineering and general research. Read the preserved references under upstream/v2-main/resources/skills/deepscientist-protocol-workflow.

# DeepScientist Protocol Workflow

Turn a confirmed reusable method into a concrete, executable research protocol without creating a second project state system. Protocol source remains in project Git; run results remain separate records.

## Entry Conditions

- Knowledge Deposition being active only makes this skill available; it does not by itself justify creating a workflow.
- Use this skill only when the user explicitly requests a reusable executable workflow, or when all five gates below are true:
  1. The procedure is expected to be run more than once.
  2. It has at least two meaningful dependent steps.
  3. Typed inputs, decisions, or checkpoints materially reduce ambiguity or error.
  4. It has an observable output and a reviewable completion criterion.
  5. Reproduction, audit, comparison, or handoff matters to the project.
- If any gate is false, do not create a protocol. For a one-off task, answer or execute directly. For abstract guidance without a concrete run sequence, update `memory/methods` instead. For an exploratory long-running effort, keep the main work in its active research/goal workflow and standardize only a stable subprocedure.
- Reuse the installed Airalogy data plugin and its research_* tools. Keep editable protocol source in the workspace, publish immutable versions through research_protocol_put, and store runs through research_record_* tools. Do not start a second data authority.

## Read Before Authoring

1. Read relevant entries under `memory/methods`, then `memory/knowledge` and `memory/lessons` only when they change this procedure.
2. Read existing `protocol/*.aimd` files and reuse compatible fields or sub-protocols instead of creating synonyms.
3. Read [AIMD authoring](references/aimd-authoring.md) before creating or materially changing syntax.
4. Read [Protocol quality gates](references/protocol-quality-gates.md) before declaring a protocol ready.

## File Contract

```text
protocol/
  <stable-protocol-name>.aimd
protocol-runs/
  <run-id>.record.json
reports/
  <run-summary>.md
memory/
  methods/
  knowledge/
  lessons/
```

- `protocol/*.aimd` is the versioned procedure specification.
- `protocol-runs/*.record.json` contains values, step/check states, timestamps, outcomes, and references from one real execution.
- A human-readable Markdown report may summarize one or more protocol runs, but must link the corresponding `.aimd` source and run record instead of duplicating their technical ids throughout the narrative.
- Never place real run values, patient identifiers, credentials, or hidden reasoning in the protocol source.
- A completed record is immutable. Corrections create a new record or an explicit amendment; they do not rewrite the original run.
- Protocol changes use the existing project Git/checkpoint workflow. Do not initialize another repository.

## Authoring Workflow

1. State the workflow purpose in one sentence: when it is used, what decisive action it performs, and what reviewable result it leaves behind. Then state scope, prerequisites, inputs, and stop conditions.
2. Define typed `var` fields only for values needed to execute, validate, compare, or reproduce the run.
3. Define three to seven top-level `step` fields in execution order. Start every title with an observable action. Add `subtitle` only when the completion boundary is not already obvious from the nearby fields, decision, or output; never restate the title. Use nested levels only when the child cannot stand alone.
4. Add `check` gates only where a wrong result should stop, branch, or require review. If the step completion control and a check express the same fact, keep the step and omit the duplicate check.
5. Label each field with `owner="human"`, `owner="agent"`, or `owner="system"`. Use `human` for observations only a person can supply, `agent` for evidence-backed Agent output, and `system` for runtime timestamps, hashes, derived counters, or immutable metadata. An Agent suggestion is never silently accepted as a measured value.
6. Use stable snake_case ids. Human-facing wording belongs in `title` and `description`.
7. Give every reusable protocol an explicit final outcome section: named output files, conclusion/decision field, blocking caveats, and the evidence or check that makes the outcome reviewable.
8. Preview the `.aimd` file in DeepScientist, perform one dry run, and apply the quality gates.
9. Checkpoint the protocol only with the exact protocol and supporting verification paths.

## Reader-Facing Contract

Write for a capable project member who did not participate in the original run. The first screen must let that reader answer four questions without opening technical details: when should I use this workflow, where do I start, what counts as complete, and what result will remain.

Use this information order unless the domain requires a stricter safety order:

1. One-sentence purpose.
2. `When to use` with an explicit non-applicable boundary.
3. `Before you start` with only required inputs and prerequisites.
4. Three to seven action-led phases.
5. Decision or blocking checks at the point where they matter.
6. `Final result` naming the decision, output files, unresolved caveats, and reuse conditions.

Treat the visible page as a report narrative, not a tutorial outline. Purpose, applicability, preparation, and cautions should normally be short lead paragraphs with inline emphasis. Do not turn every sentence-level idea into a standalone heading or an equal-weight card. Reserve headings for real execution phases and the final result.

Each phase has one job. Its title says what to do; optional supporting text is justified only when it changes how the work is performed or judged. Keep routine completion wording, field ownership labels, commands, runtime ids, file hashes, parser metadata, and activity history in technical details or exported records. A completed main view should read like a concise report: recorded values, meaningful decisions, exceptions, and the final result. Treat phase numbers as quiet report structure, not as decorative icons or competing status badges.

Place related typed fields directly beneath their action-led phase title as one compact field group. Do not wrap them in sentences such as “record the following”, “check each item”, or “the specific record is”; add a short sentence only when it explains scientific meaning, a threshold, an exception, or how the result changes the next action. Use human-facing titles for table columns so the completed run reads as a report rather than a schema dump.

Do not add a generic wrapper heading such as “execution process” before the real phases. Do not add filler labels or micro-sections such as “detailed record”, “check each item”, “operation notes”, “execution details”, “具体记录”, “分别检查”, “逐项确认”, or “填写以下内容”. Keep a phrase only when it names a real observation, decision, blocking condition, or deliverable. Do not repeat status, duration, ownership, or completion instructions beside every phase; the runtime and technical-details view already preserve them.

Keep the visible phase line compact: one action-led title followed by the fields, evidence, choice, or result that belongs to it. Put ids, provenance, ownership, timestamps, automatic-operation logs, and parser metadata in technical details or the exported record. Do not ask the reader to understand the storage format before they can understand the scientific conclusion.

For a completed run, emphasize the values actually recorded and the option actually selected. Do not repeat disabled editing controls, unchecked alternatives, empty action columns, or routine completion controls in the report-facing view; those belong to an active run or technical details.

Do not make an unvalidated method sound standard through polished wording. Label it as a trial workflow, name the missing validation, and keep the strongest wording inside the available evidence. Prefer concrete user language such as “Confirm samples match their data files” over system language such as “Register input entities”.

Before finalizing, perform a newcomer read-through:

- Can the reader identify the use case and non-use case after one pass?
- Does every phase have one dominant action and an unambiguous completion criterion without repeating itself?
- Does every important decision map to a visible check, choice, or output?
- Can the exported result be understood without replaying the chat or reading internal ids?

## Runtime Conduct

- At run start, load the protocol version from the current Git revision and create a unique record id.
- Treat the user-facing concept as a research workflow or run, not as “AIMD”. The `.aimd` extension is an implementation detail that belongs in file and technical-detail views.
- Fill only fields backed by current evidence. Ask the user for missing human observations using concise choices where possible.
- Do not ask the user to re-enter a value already available to the Agent or runtime. Write Agent/system values with their source, timestamp, and producing step into the run record; leave an unresolved automatic field visibly pending when no valid source exists.
- Complete a step only after its described action and validation are complete.
- If a required check fails, mark the record blocked or failed, retain the observation, and explain the next safe action.
- Store large data by project-relative reference plus checksum or source metadata; do not inline large datasets in Record JSON.
- When a failure reveals a reusable limitation, add a concise `memory/lessons` entry. When repeated runs validate an improvement, update `memory/methods` and then revise the protocol.

## Examples

Create a protocol when the user says:

- “把这套电力设备运行数据质量检查流程沉淀成每次都能填写和复核的步骤。”
- “Make our evidence screening SOP executable with reviewer checkpoints.”
- “Reuse the validated factor robustness workflow for a new cohort.”

Do not create a protocol when the user says:

- “解释一下这篇论文的方法。”
- “临时把这个 CSV 的前三行打印出来。”
- “总结我们目前知道的项目事实。”

## Completion Contract

A protocol is ready only when parsing succeeds, every required field has an explicit owner, every step is actionable, every blocking condition has a visible check, expected outputs and final conclusion are named, related AIMD/Markdown records can be opened from the project preview, and a dry-run record can be exported without embedding secrets or unrelated data.
