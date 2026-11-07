---
name: deepscientist-project-workspace
description: Manage the Git-backed DeepScientist project workspace shared by every conversation mode, including status, selective knowledge reuse, verified checkpoints, history, and approved research branches.
---

# DeepScientist Project Workspace

This is the common source-project persistence contract for every DeepScientist
mode. Git records implemented project facts. Science artifacts, evidence
graphs, reports, and Viewer state are complementary records and do not replace
the source-project history.

## Task lifetime

- Every task with a bound project reads `project_workspace(action="status")`
  once before substantive work.
- In an ordinary mode, Git is task-scoped memory. Save only meaningful verified
  file changes needed to resume or deliver that task, and stop managing its
  state when the task ends. Do not create `research_roadmap` or long-lived route
  state.
- Discovery Mode keeps the same project Git record and adds the long-lived
  `research_roadmap`. Its directions may evolve across many continuations, but
  neither a continuation boundary nor a route-mode switch requires a checkpoint.

## Start or resume

1. Treat the project root, project id, and conversation id in the runtime
   contract as already created and bound before the Agent starts. Do not run
   setup, create a second project, or initialize another repository.
2. From that single status response, read `completedResearchStages` as the
   compact resume ledger and use `checkpointContract` for the bound domain,
   allowed stages, verification shapes, and examples. Omit identity arguments
   unless a tool action explicitly requires them; the runtime resolves the
   binding.
3. Work only inside the project root bound by the runtime.
4. Classify the entry from actual state. An initializer-only repository with no
   meaningful project files, portfolio, artifacts, or research checkpoints is
   a fresh task, even when the request arrived through a retry envelope. Do not
   describe it as restore/resume or load `intake-audit`.
5. On an actual resume, read the current branch, latest checkpoint, and
   outstanding changes before deciding what to modify.
6. Treat commits and real branches as completed facts. Treat plans, proposed
   routes, and uncommitted changes as provisional state.

## Connect a repository

When the user explicitly provides an HTTPS or SSH Git URL and the conversation
has no bound project, call `project_workspace(action="clone")` once with
`payload.remoteUrl` and either `payload.destination` or `payload.baseDir`.
Never overwrite a non-empty directory, push changes, or change a remote in an
existing checkout. After a successful clone, call `project_workspace(action="status")`
once and keep the returned binding for the rest of the run. For a local folder,
use the desktop import action; do not represent a local import as a clone.

## Checkpoints

Use `project_workspace(action="checkpoint")` only after a meaningful project
stage produced attributable file changes and its verification was run.

- Provide a concise `message`, an allowed `stage`, explicit project-relative
  `includePaths`, and concrete `verification` entries.
- When the same meaningful checkpoint records a material route choice, add one
  optional `directionDecision` with schema `deepscientist.direction.v1`, the
  chosen disposition, one concise reason, one to three decisive
  evidence/artifact/commit references, and `nextTest`/`stopIf` when the route
  continues. Include a Git commit only when it materially informed the choice.
  Omit the object for routine progress, and never create an empty commit only
  to save a decision. The tool writes the readable body and trailers; do not
  hand-author either format.
- Every meaningful research checkpoint must pass `routeMode`: `explore`
  compares a materially different route, `deepen` advances the strongest route,
  `fuse` combines compatible verified routes, `repair` corrects a concrete
  data/tool/reproducibility fault, and `stop` records a defensible pause. For
  `repair`, also pass `repairsNodeId`. Project initialization and
  presentation-only report, writing, review, or final checkpoints are exempt.
  The tool writes the subject prefix and Git trailers; do not hand-write them
  or create an empty checkpoint for a label.
- In a runtime-bound Discovery task, omit `runId` and `goalId`; the tool attaches
  the authoritative values. Put only `researchStage` inside `payload`.
- `verification` accepts a string, `{command, exitCode, summary}`, an array of
  those, or `{checks:[...]}`. A non-zero check may document negative evidence,
  but it must not be described as a successful verification.
- When Discovery Mode is active, attach one `researchStage` receipt. Record the
  stage objective, success and
  failure/refutation criteria, prior work, disposition, supporting/refuting or
  exhaustion evidence ids, belief delta, reflection, and next objective.
  `supported` needs support, `refuted` needs refutation, and `exhausted` needs
  evidence of the searched route/region. Tool failure is never refutation.
- Include measured `metrics` and a stable `metricContext` only when results are
  genuinely comparable. Never invent values or rank incompatible protocols.
- Do not create empty checkpoints.
- Never use implicit whole-repository staging or `git add -A`.
- Never include credentials, private keys, tokens, caches, generated build
  trees, pre-staged changes, or unrelated user work.
- Keep the root `README.md` useful for a human reader when a meaningful change
  alters the project objective, reproduction path, verified result, limitation,
  or next step. Do not rewrite it for trivial changes.
- Treat `completedResearchStages` as the compact resume ledger. Do not repeat a
  stage without a changed premise, method, data, tool, or budget.

## Project knowledge

Project files and Git history are the only durable project memory. There is no
separate Memory CRUD protocol.

- Scope is the bound project, never application-global or implicitly
  cross-project. A conversation produces candidates; tracked checkpoints make
  them reusable across conversations.
- Recall only relevant tracked files, diffs, or commits when prior work can
  change the current decision. Do not scan the whole memory tree at kickoff.
- Use `deepscientist-project-memory` for entry lifecycle, evidence, privacy, and
  Team ownership rules. Add or revise zero to three entries at the next
  meaningful verified checkpoint; otherwise write nothing.
- Current evidence and explicit user instructions take precedence over memory.

## Routes and branches

- Use `project_workspace(action="frontier")` only when route state matters,
  such as kickoff/resume, a material checkpoint, or a route comparison.
- Proposed routes are user choices, not Git branches.
- `explore` needs a branch only when isolation has practical value. `deepen`
  normally remains on the current branch. `fuse` needs an integration branch
  only when compatible verified source branches require file-level integration;
  evidence synthesis alone does not. `repair` preserves the failed history and
  identifies the repaired node. `stop` creates neither a branch nor an empty
  commit.
- Call `project_workspace(action="prepare_branch")` only after an explicit
  route selection and only when
  isolation has practical value.
- Call `project_workspace(action="activate_branch")` only for an existing
  approved route from a clean workspace. Re-read the project landing page and
  latest checkpoint after switching.
- Use `project_workspace(action="compare_branches")` only when the underlying
  evaluation contracts are compatible. Do not oscillate between routes without
  new evidence.

## Boundaries

- If the runtime contract explicitly says Project Git is unavailable because
  no binding was supplied, do not call `project_workspace` or claim a
  checkpoint or branch exists. Continue without Git.
- If the contract lists an authorized project but the tool reports no binding
  or a mismatch, treat it as a runtime fault. Do not reopen or migrate the
  conversation, guess another id or path, omit values to bypass validation,
  initialize a repository, or create a replacement project.
- Do not run `git init`, reset, clean, force-checkout, rewrite history, relocate
  the repository, or change remotes unless the user explicitly asks.
- Do not create a second project repository. The hidden
  `.deepscientist/artifact-repo` is an internal artifact provenance ledger and
  must remain separate from the source-project Git repository.
- Discovery/continuation mode changes how work advances; it does not own or
  toggle project persistence.
