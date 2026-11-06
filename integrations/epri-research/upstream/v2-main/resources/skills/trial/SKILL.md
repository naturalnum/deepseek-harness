---
name: trial
description: Score the first valid Challenge candidate immediately, then evaluate independent candidates in resource-bounded parallel batches with completion-driven refill.
---

# Challenge Fast Trial

Turn candidate files into canonical evidence through `ioai_competition`.
Do not edit `.deepscientist/competition/`, run the evaluator outside the
Coordinator, or calculate a replacement score. Require
`official_submission_enabled: false`.

Competition candidates must use the executable `attempt` contract. The
Coordinator snapshots the declared source files, runs the Python entrypoint in
the Trial workspace, captures CPU/GPU/wall-clock evidence, and only then calls
the sealed evaluator. A packet with
`candidate_execution_mode: "static-evaluator-fixture"` is compatibility or
evaluator-test evidence; never promote it as the actual competition system.

Read [trial-contract.md](references/trial-contract.md) for candidate and result
schemas. Reuse the sealed task, confirmed baseline, passed audit, and ready
preflight receipt already established for this task.

## First-result fast path

Do not wait for a full candidate pool. As soon as the simplest candidate passes
a cheap executable/schema check, the Lead reads the current revision. On an
unscored task, do not start a high-cost candidate alone while that assigned
simplest lower-cost candidate is still preparing.

```text
ioai_competition(
  action="frontier_snapshot",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  task_id="<task-id>",
  profile="<profile>"
)
```

Then call:

```text
ioai_competition(
  action="trial_run",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  task_id="<task-id>",
  profile="<profile>",
  candidate_path="<project-relative-candidate>",
  expected_frontier_revision=<current-revision>,
  idempotency_key="<request-bound-key>"
)
```

Use `contest` directly when a full evaluation is cheap enough to distinguish
candidates. Use `smoke` or `sprint` only when it avoids a meaningful failed or
expensive run. Quick results are screening evidence; their baseline comparison must be `not_comparable`.
A quick winner must be recreated for `contest`.

## Parallel candidate evaluation

As other independent candidates become ready, place them in one same-task,
same-profile batch and call:

```text
ioai_competition(
  action="trial_batch",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  task_id="<task-id>",
  profile="<profile>",
  batch_path="<project-relative-batch>",
  max_workers=<resource-bounded-count>,
  expected_frontier_revision=<current-revision>,
  idempotency_key="<request-bound-key>"
)
```

Candidate count may exceed `max_workers`; the Coordinator starts new work as a
slot finishes. Order the batch by the latest expected improvement per cost so
the most useful evidence starts first. Bound `max_workers` by actual CPU/GPU
limits, never Team size. Do not wait for a wave barrier before preparing the
next candidates.

Subagents prepare, cheap-check, and hash Candidate Attempts only. The Lead is
the sole `trial_run` and `trial_batch` caller, so independent adapter processes
cannot hold the Coordinator writer lock while another candidate waits. The
Python Coordinator remains the canonical evaluator writer.

Use the revision returned by a successful trial result for the next write. On
`frontier_writer_busy` or `revision_conflict`, the Lead reads
`frontier_snapshot`, verifies the affected candidate has no packet, and retries
the same Lead-owned request once with the current revision and idempotency key.
Read the snapshot again only after a conflict, recovery, integrity doubt, or
when a fresh decision needs candidates beyond the returned projection.

## Evidence-driven refill

After any completion, immediately choose the next queued candidate from the
latest scores and failures:

- improve the current best candidate;
- test a genuinely different method if the frontier is narrow;
- debug only a clear, repairable failure;
- test an ensemble only after complementary parent evidence exists.

Do not retry unchanged deterministic content. Repeated non-improvement in one
mechanism removes that mechanism from the queue. Keep fixed validation and
change one dimension at a time around the incumbent.

Use the returned case-level evidence to distinguish real improvement from a
fragile aggregate-score bump. Fusion requires evaluated parents with different
prediction or error patterns; model names alone are not evidence of diversity.

Accept results only when identity, packet hash, candidate hash, profile,
revision, counts, and resource usage are consistent. On `revision_conflict`,
read the current snapshot and revalidate the candidate. Preserve the same key
for an exact retry; use a new key only for a semantically different request.
Use revision zero only for an exact virgin frontier.
