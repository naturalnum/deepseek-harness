---
name: research-gewu
description: Persistent DeepScientist Discovery Mode for iterative work toward a user-defined target, with compact progress summaries, blocker discipline, and concrete next actions.
---

# Harness compatibility mapping

This is the complete copied V2 Discovery/格物 skill with a continuation-controller adapter. Only enable persistent work when the user authorizes it. Harness native Goal and its current pause/resume/blocked rules take precedence.

The canonical research ledger is research_science_state. Persist routes and completion contracts with research_roadmap_put, evidence with research_evidence_put, and reports with research_report_put. Request human route decisions through research_roadmap_select: the native conversation question confirms only the selected current route revision, never starts a model task or Git operation. Do not maintain a competing file ledger or second scheduler. Legacy project_workspace maps to native Harness filesystem/Git tools. Protocol records and engine runs document experiments; they are not Goal controllers.

Legacy runtime-bound runId/goalId and stage-limit semantics below are not implemented here. Do not infer completion from a report, turn limit or stopped route. Use native user-interaction tools instead of legacy user_input. Git commits remain subject to the user's authorization.

Saved routes appear in the workbench progress graph. For an existing repository associated by the human, research_project_git_state and research_project_git_commit provide read-only history and patches. Separate project_git_working/checkpoint/branch/policy/merge/revert operations support authorized writes and managed worktrees as described below. Task execution still uses native Harness tools and Goal.

# DeepScientist Discovery Mode

Use this skill when the user enables DeepScientist Discovery Mode (internal id: `loop-goal`). The goal is to keep useful work moving across repeated turns without losing the user's stated target.

## Operating Contract

- Preserve one durable user objective. A research stage tests part of it and
  must never replace or silently narrow it.
- Use DeepSeek Harness native Goal as the sole continuation controller. Call its create_goal/get_goal/update_goal only under their current authorization rules. This copied skill supplies research discipline, not a second scheduler.
- Stop or ask only when user input, credentials, approval, or an external state
  change is truly required. Difficulty, uncertainty, elapsed time, or one
  exhausted route is not a terminal blocker.
- Treat a time or attempt budget as a reflection boundary, not completion.

## Source Discipline

- Treat current project files, checkpoints, portfolios, and registered evidence
  as authoritative. Use the conversation only to locate them.
- If Science Mode is also active, keep the Science artifact and evidence rules in force.
- If Mathematical Research is active, keep its portfolio, two evidence lanes, formal verification, and review gates primary; this mode controls continuation only.
- If Lab Skill Deposition Mode is also active, keep source boundaries strict and do not use unrelated memory.

## Continuation Discipline

- Follow `$deepscientist-project-workspace` for project status, checkpoints,
  history, and branch safety. Project Git remains active with or without this
  mode; this skill controls continuation, not persistence.
- At kickoff or resume, inspect `project_workspace(action="status")` once.
  Inventory completed checkpoints, accepted evidence, rejected/exhausted
  routes, active work, and dirty provisional work before choosing a stage.
  An initializer-only repository without meaningful project files, evidence,
  or research checkpoints is fresh: derive the first substantive stage from
  the user objective and do not create a restoration or inventory stage.
- Call `research_roadmap(action="get")` once at kickoff/resume. If absent, use
  its typed starter/schema, validate once, then submit; reuse mutation revisions.
- The runtime binds the Discovery objective and Science run internally. Omit
  `runId` and `goalId` for `research_roadmap` and `project_workspace`; reject a
  mismatch instead of guessing or copying an id from chat.
- Resume from the latest verified project, roadmap, and artifact state. Do not
  repeat prior work unless a premise, method, data source, tool, or budget
  changed and the stage records why.
- Keep one roadmap `completionContract`. Give each global requirement a stable
  id, status, and evidence ids; satisfied/unsatisfied criteria require evidence.
- Continue one safe route directly. When two to four materially different
  routes require a decision, refresh `project_workspace(action="frontier")`,
  present the virtual choices through `user_input`, and wait for the result.
- Virtual candidates are predictions, not Git branches. Prepare a branch only
  after the corresponding route was selected and only when isolation adds real
  value.
- Keep the selection lightweight: compare research value, information gain,
  and validation burden; retain the chosen reason, the smallest decisive test,
  and its stop condition in the focused roadmap node. When that choice later
  produces a meaningful verified checkpoint, carry the same compact rationale
  into `directionDecision`. Do not rerun the comparison or create a decision-
  only commit.
- Use the roadmap `routeMode` to keep the current direction explicit:
  `explore` for materially different possibilities, `deepen` for the
  strongest current route, `fuse` for compatible verified routes, `repair` for
  a data/tool/reproducibility fault, and `stop` when no defensible next work is
  available. Change this one marker when evidence or constraints change and
  explain why in the focused node; do not create a separate round log.
- Keep proposed `explore` routes virtual until selected. `deepen` and `repair`
  normally stay on the current branch unless isolation is useful. For `fuse`,
  compare branches and create an integration branch only when compatible,
  verified source branches actually need file-level integration. Do not create
  a branch or checkpoint only to mark `routeMode`, including `stop`; checkpoint
  only meaningful project changes.
- `stop` recommends pausing or ending the current direction. It does not satisfy
  the completion contract or authorize `nextAction=complete` by itself.
- Do not create a parallel plan file merely to mirror a route projection.
- Reuse `currentRevision` or `resultingRevision` from a successful mutation as
  the next `baseRevision`. Re-read only on kickoff/resume, when current contents
  are needed, or after a revision mismatch. Read a schema once and validate a
  complex object before its first mutation instead of probing by failure.
- On each automatic continuation, read project status and the roadmap once,
  preferably in parallel. Do not repeat schema, validate, get, status, or
  frontier calls again in the same turn unless a revision conflict or real
  outside change requires it.

## Stage Contract

Before substantive work, create or resume the single `research_roadmap`, then
select exactly one current node and record:

- objective and why it is the highest-information next step;
- `priorWorkRefs` and concrete `doNotRepeat` items;
- success evidence and failure/refutation evidence criteria;
- authoritative checks and expected artifacts;
- a bounded reflection budget.

A research stage may span multiple Agent turns. A turn ending is not a stage
boundary. Resume the same running stage until its acceptance, failure,
exhaustion, reflection-budget, or real-blocker condition is reached; do not
close it just to make an automatic continuation look complete.

Work until the stage is `supported`, `refuted`, `exhausted`, `inconclusive`, or
`runtime_failed`. Negative evidence and a well-supported route rejection are
valid progress. A tool/runtime failure is not scientific refutation; record it
in the roadmap/runtime event without manufacturing a source Git checkpoint.
Finite Discovery limits count unique checkpointed research stage ids, not chat
turns; `runtime_failed`, schema retries, and duplicate receipts do not consume them.

After a meaningful stage, update the route-node outcome and create one
`project_workspace(action="checkpoint")` for the runtime-bound objective with a
matching `routeMode` and a `researchStage` receipt. The receipt must include the stage id and objective,
success/failure criteria, prior work, disposition, supporting/refuting evidence
ids, belief delta, reflection, and next objective. Update the root `README.md`
when this changes the human-readable result, limitation, or next step.

If no evidence or belief changed, do not repeat the same stage. Reflect and
change the premise, route, data, method, or verification condition first.

## Progress Shape

Only these outcomes count as productive research progress:

- new supporting or refuting evidence;
- a verified implementation, experiment, proof attempt, or review result;
- an evidence-backed route rejection or scope correction;
- a concrete blocker that names the exact missing external condition.

State reads, schema retries, metadata-only edits, repeated summaries, delivery
failures, and tool retries do not count. Before declaring the objective complete,
audit every completion criterion against current authoritative evidence; every
criterion must be satisfied, otherwise continue.

## Final Turn Style

An automatic continuation turn is not terminal delivery. Do not publish,
checkpoint, or generate a final report merely because the turn is ending.
Require a material evidence/state change or an evidence-backed terminal result.

Keep summaries short. State the evidence delta, changed judgment, disposition,
and why the next objective is better than the alternatives.

## Current Harness capability mapping (2026-10-26)

Use the installed research_ tools with the current conversation identity. project_git_working previews concrete changes and a state token. Human-approved project_git_branch creates a separate directory; native Harness filesystem/terminal/Goal work must explicitly use the returned path. project_git_checkpoint saves selected files. Agents may use it only within a human-enabled project_git_policy for that exact managed worktree and file list. Completed roadmap stages trigger that policy. Merge and revert require human workbench actions. Never claim a saved route starts a task automatically.

document_status checks the offline PDF/OCR runtime; document_extract indexes an existing conversation attachment and document_text reads pages. local_search includes extracted pages with page numbers; OCR text needs source review. workspace_import restores research history into fresh local identities and pending reviews; published methods return as drafts.

For existing original mathematics portfolios or finance report cards, store actual JSON with attachment_put using .math.json or .finance.json. The domain results page validates and renders those formats. This does not run Lean, provision market data, execute a factor backtest or certify conclusions.
