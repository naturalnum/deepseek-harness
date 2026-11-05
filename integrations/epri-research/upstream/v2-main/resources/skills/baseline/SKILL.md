---
name: baseline
description: Run and inspect the local comparator for a sealed Challenge task, using either explicit practice confirmation or a pre-run autonomous lock. Use after task_import and evaluator_audit pass, or when a baseline run must be resumed, diagnosed, or gated before native idea and experiment work.
---

# Challenge Baseline

Establish one honest local comparator under the active task seal, verify its
immutable evidence, apply the selected human-control policy, and stop.

## Keep one authority

- Treat the Python Competition Coordinator behind `ioai_competition` as the
  only writer of baseline runs, confirmation receipts, metric contracts,
  budgets, and frontier state.
- Do not edit `.deepscientist/competition/` or replace a result packet.
- Do not use a generic research-artifact confirmation API or any legacy
  orchestration API. Confirm only with `baseline_run` through the Competition
  MCP.
- Treat every metric as local sealed-evaluator evidence, never an official
  hidden-test score. Require `official_submission_enabled: false` in every
  response.
- Never arm a competition lock from baseline. It must already exist before task
  import or the project remains in manual practice mode.

## Preconditions

Require an absolute `project_root`, the active `seal_id` and `seal_hash`, and a
matching passed evaluator audit from `task-contract`. If engine status has not
been checked in the current session, call:

```text
ioai_competition(action="system_status")
```

Read [baseline-contract.md](references/baseline-contract.md) before creating or
changing the candidate file.

Read the competition lock before running. If `competition_lock` read returns a
verified active lock, follow **Locked autonomous mode** below. If no lock exists,
follow **Manual practice mode**. Do not silently fall back to manual mode when
the session was declared autonomous.

## Run or resume

1. If a `run_id` already exists, read it before launching another run:

   ```text
   ioai_competition(
     action="baseline_run",
     operation="read",
     project_root="<absolute-project-root>",
     seal_id="<seal-id>",
     run_id="<baseline-run-id>"
   )
   ```

   Do not add an idempotency key to a read.

2. Otherwise, write one project-relative version 1 baseline candidate. Prefer
   the official starter-kit baseline when it is runnable. Use a legal format or
   constant comparator only to prove the path when no stronger comparator is
   available, and label that limitation explicitly.

3. Derive a stable idempotency key from the active seal and candidate content.
   Reuse it only for an exact retry.

4. Run the candidate:

   ```text
   ioai_competition(
     action="baseline_run",
     operation="run",
     project_root="<absolute-project-root>",
     seal_id="<seal-id>",
     candidate_path="competition/baseline/candidate.json",
     idempotency_key="baseline-run-<seal-id>-<candidate-hash>"
   )
   ```

5. Verify identity and evidence before opening the comparison gate. Require a matching
   `seal_id`/`seal_hash` and evaluator audit, `status: passed`, a non-null finite
   `primary_metric`, the correct `maximize` or `minimize` direction, complete
   `metrics_summary`, `packet_hash`, `result_ref`, and a non-null
   `baseline_ref`. Re-read the run when resuming or when immutable evidence is
   in doubt.

6. If the run failed, do not confirm it. Preserve `failure_kind`, inspect the
   returned evidence refs, change the candidate or environment only when that
   addresses the failure, and use a new idempotency key for changed content.

## Validation discipline

- Freeze a split that mirrors the sealed test independence boundary. Use
  group-, entity-, or time-aware separation when the sealed data exposes that
  structure; do not let random rows from one independent unit cross folds.
- Fit every learned transform inside each training fold, including imputation,
  scaling, encoding, feature selection, calibration, threshold fitting, and
  blend-weight fitting. Reusing a transform fitted on all rows invalidates the
  comparison.
- Preserve fold metrics and out-of-fold predictions when the evaluator permits
  them. Aggregate score alone must not hide a collapsing fold or error slice.
- Keep public-leaderboard results separate from local validation. They may flag
  a possible distribution mismatch, but must not tune candidates, select
  thresholds, promote a line, or override the frozen local CV contract.

## Locked autonomous mode

The pre-run policy is `auto_confirm_first_passing.v1`. The engine consumes one
attempt only after the candidate, seal, audit, case/fixture identities, and
aggregation pass static validation and a real evaluator execution begins. A
static precondition rejection consumes no attempt and creates no baseline run
packet. The engine automatically confirms the first passing baseline in the
same `baseline_run` command. Do not ask the user to inspect or approve the
score. Never call `operation="confirm"` while a competition lock is active.

For a passing run, require `confirmed: true`,
`confirmation_mode: "competition_lock"`, the expected
`competition_lock_hash`, `competition_lock_status: "baseline_confirmed"`, and
all confirmation refs. For a failed run, preserve its evidence and check the
remaining pre-authorized attempts. Stop when the lock is exhausted; do not ask
the human for more attempts after execution started.

## Manual practice mode

Present the comparator identity, source, local metrics, direction, deviations,
and failure/caveat status. Obtain explicit user approval for this run. Never
infer acceptance from a passed score or from a general automation policy.

Then call:

```text
ioai_competition(
  action="baseline_run",
  operation="confirm",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  run_id="<baseline-run-id>",
  idempotency_key="baseline-confirm-<baseline-run-id>-<packet-hash>"
)
```

Accept completion only when `confirmed` is true and `confirmation_hash`,
`confirmation_ref`, and `metric_contract_ref` are all present, with
`confirmation_mode: "manual_post_run"` and no competition lock hash. These
engine records open the comparison gate; a chat summary or copied score does
not.

## Completion gate

Finish with the confirmed run identity, packet hash, primary metric, full
metric summary, source and deviations, confirmation refs, and any remaining
caveats. Route next to native `ds-idea`. Do not start trials or generate an official
submission in this workflow.
