# Git and Worktree Minimum

Use this reference when a Workflow stage needs durable optimization state,
branch isolation, or recovery after multiple research attempts.

## Principle

Separate editable research state from artifact provenance:

- Project repository: code, manuscripts, notebooks, configs, and normal git
  branches/worktrees.
- DeepScientist artifact ledger: `.deepscientist/artifact-repo`, managed by
  `science_artifact(action="snapshot")`, preserving reports, metadata, files,
  hashes, pointers, state, and events.

Do not manually edit `.deepscientist/artifact-repo`. Use `science_artifact`.

## Minimal Filesystem Layout

Create these only when a project needs Workflow state:

```text
.deepscientist/
  workflow/
    project-plan.md
    ledger.jsonl
    branches/
      <branch-id>/brief.md
    runs/
      <run-id>/manifest.json
    decisions/
      <decision-id>.md
```

Keep these files concise. They are control records, not manuscript prose.

## Branch Naming

Use stable, readable names:

- `os/idea/<slug>` for candidate research directions.
- `os/run/<slug>` for implementation or experiment branches.
- `os/analysis/<slug>` for follow-up analyses.
- `os/paper/<slug>` for manuscript/rebuttal work.

If the project is not a git repository, use directory isolation instead:
`experiments/<stage>-<slug>/`, then snapshot the directory through
`science_artifact`.

## Worktree Rules

Create a worktree when:

- a candidate may change code substantially;
- two alternatives need parallel comparison;
- a run is expensive and should not dirty the main workspace;
- a manuscript/rebuttal branch should be isolated from computational code.

Do not create a worktree when:

- the work is only reading, planning, or writing a small note;
- the current branch is already the correct isolated branch;
- uncommitted user changes make the base unsafe and the user has not
  authorized how to handle them.

Before creating a worktree:

1. Inspect current git status.
2. Identify base branch/commit.
3. Name the branch and worktree path.
4. Record the reason in `.deepscientist/workflow/ledger.jsonl`.
5. Ask for user approval if creating the worktree would touch uncertain user
   changes, remote state, protected branches, or large data.

## Stage Records

Each Workflow stage should write or update one small record:

```json
{
  "time": "2026-07-02T00:00:00.000Z",
  "stage": "idea|baseline|experiment|analysis|write|review|decision|finalize",
  "skillId": "ds-idea",
  "branch": "os/idea/celltype-labels",
  "worktree": "../project-worktrees/celltype-labels",
  "baseCommit": "abc1234",
  "objective": "Improve label readability without changing data processing",
  "status": "created|running|accepted|rejected|merged|parked",
  "evidenceIds": [],
  "artifactIds": [],
  "notes": "Concise control note only"
}
```

Use absolute paths in internal agent reasoning only when necessary. Prefer
project-relative paths in artifacts, evidence, and final reports.

## Snapshot Rules

After meaningful file-producing work, call `science_artifact(action="snapshot")`
with:

- `.deepscientist/workflow/` as an included folder;
- changed code/config/notebook/script files;
- generated outputs, logs, result tables, figures, manuscripts, or PDFs;
- branch/worktree notes when they explain provenance.

Snapshot after:

- creating or selecting an idea branch;
- accepting or waiving a baseline;
- completing a run, ablation, robustness check, or failure analysis;
- generating or versioning a figure/table/notebook/manuscript;
- making a route decision;
- finalizing or pausing the project.

Never snapshot secrets: `.env`, tokens, SSH keys, cloud credentials, private
keys, or paid-service credentials.

## Promotion and Merge

Promotion is a scientific decision before it is a git operation.

1. Use `ds-decision` to compare evidence and choose accept, continue, branch,
   merge, park, or reject.
2. Record the decision as evidence/provenance.
3. Snapshot the decision and affected artifacts.
4. Merge or delete worktrees only when the user authorized the operation.

If a branch is rejected, keep enough evidence to understand why. Do not erase
failed branches from the artifact ledger just because the final report is
cleaner without them.
