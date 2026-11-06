# Trial execution contract

Use only project-relative candidate and batch paths with an absolute project
root. The Python Coordinator validates the active seal, passed evaluator audit,
confirmed baseline, budget, resources, parent IDs, duplicate configurations,
candidate attribution, duplicate evaluator content, workspace isolation, and
immutable candidate/result packets.

## Candidate checks

A version 2 Team candidate requires:

- `seal_id` equal to the active seal and one sealed `task_id`;
- top-level `profile` equal to the command profile;
- exact `candidate` schema/version fields, a stable `candidate_id` equal to
  `trial_ref`, and exact Team `team_id`, `slot_id`, `team_run_id`, `role_id`,
  and `strategy_lane` attribution;
- optional aggregation compatible with the validation contract;
- `trial_ref`, supported operator, hypothesis, strategy summary, and canonical
  parent trial IDs;
- `source.kind` and unique `source.identity` plus the attributable change;
- explicit `known_deviations`;
- code, prompt, tool, and model-call traces;
- positive timeout, non-negative token/CPU/GPU accounting, at least one CPU
  slot, and `tokens_used <= token_budget`;
- exactly the sealed validation cases, without precomputed candidate payloads;
- an executable `attempt` object with schema
  `deepscientist.ioai.competition.python-attempt.v1`, a project-relative Python
  `entrypoint`, non-empty project-relative `include_paths` covering that
  entrypoint, and bounded string `arguments`.

The entrypoint is invoked with `--input <attempt-input.json> --output
<attempt-output.json>`. It must write schema
`deepscientist.ioai.competition.attempt-output.v1` and one
`{"case_id": ..., "candidate": ...}` row for every selected case. The
Coordinator snapshots and hashes every included source before execution. The
result packet must report `candidate_execution_mode: "executable"`, a hashed
`candidate_attempt` receipt, and measured `candidate_attempt_seconds`.

Static per-case `candidate` payloads remain readable only for migrated tests and
evaluator self-checks. They are marked `static-evaluator-fixture` and are not
final system evidence.

`token_budget` is the approved cap. `tokens_used` is measured actual usage from
candidate-production receipts; it must not be copied from the cap or estimated.
Use zero only when the candidate consumed no model tokens.

Team attribution has a fixed lane/operator mapping: `exploit -> improve`,
`explore -> draft`, `debug -> debug`, `audit -> audit`, and
`fusion -> ensemble`. Novelty remains part of explore. Legacy
`trial_version: 1` inputs remain executable without Team attribution; new Team
workflows must emit version 2.

The Coordinator calculates `candidate_content_hash` from the normalized seal,
task, profile contract, aggregation, and profile-selected cases. It rejects the same content under another ID,
the same ID with different content, and reuse of one
`(team_id, slot_id, team_run_id, turn_id)` assignment. Legacy v1 attribution
without `turn_id` remains readable but cannot represent multiple candidates from
one slot in the same Team run. These checks run before workspace
or frontier mutation; changing source identity or traces cannot bypass them.

## Read current revision

Call:

```text
ioai_competition(
  action="frontier_snapshot",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  task_id="<task-id>",
  profile="<profile>"
)
```

A ready response supplies the exact `frontier_revision`. Before the first
trial, only an exact `not_found` result permits revision `0`. Reads take no
idempotency key.

## Write operation fields

`trial_run` requires exactly:

- `project_root`, `seal_id`, `task_id`, `action: "trial_run"`;
- optional `profile`, defaulting to `contest`, exactly matching the candidate;
- project-relative `candidate_path`;
- non-negative `expected_frontier_revision`;
- a stable, operation-specific `idempotency_key`.

`trial_batch` requires exactly:

- `project_root`, `seal_id`, `task_id`, `action: "trial_batch"`;
- optional `profile`, defaulting to `contest`, matching every batch candidate;
- project-relative `batch_path` whose version 1 `trials` list contains paths
  relative to the batch directory;
- positive bounded `max_workers`;
- non-negative `expected_frontier_revision`;
- a stable, operation-specific `idempotency_key`.

One batch must contain unique configurations for exactly one task. A candidate
change, batch membership/order change, worker-bound change, seal change, or
revision change requires a new idempotency key.
Changing the profile is also a different request and requires a new key.

## Result checks

Require a ready result with:

- matching `seal_id` and `task_id`, expected operation and serial/parallel mode;
- matching profile, frozen profile contract, and final-evidence eligibility;
- `trial_count = valid_count + invalid_count` and a result row per candidate;
- unique canonical trial IDs and project-relative result refs;
- unique candidate IDs, content hashes, exact Team attribution (or explicit
  `null` for legacy v1), whole-spec hashes, and project-relative immutable
  `candidate_spec_ref` values;
- SHA-256 packet hashes, finite scores for valid rows, legal direction, and a
  classified failure for invalid rows;
- executable Candidate Attempt mode, source-manifest hash, receipt, output
  evidence, and measured wall-clock usage for competition evidence;
- canonical checkpoint ref, monotonic frontier revision, incumbent projection,
  and explicit recovered/abandoned ID lists;
- command receipt integrity and `official_submission_enabled: false`.

Read each immutable result packet and match its packet hash. Verify that its
`candidate_spec_ref` ends in the same trial directory and that
`candidate_spec_hash` plus `candidate_spec_sha256` match the stored
`candidate.json`. Then read a fresh frontier snapshot and require its revision
to equal the trial result revision.

## Conflict and failure semantics

On `revision_conflict`, the old request is stale. Read the current snapshot and
re-evaluate parent existence, configuration duplication, budget, and relevance.
If the candidate still applies, send a new request and idempotency key bound to
the new revision.

Invalid results, deterministic failures, timeouts, abandoned work, exhausted
resources, and evaluator errors remain evidence. Do not erase them, overwrite
their packets, or relabel them as successful. Never treat a local sealed score
as an official hidden-test result, and never issue an official submission.

Profiles are separate evidence domains. `smoke` selects the first sealed case,
`sprint` selects the first half rounded up, and `contest`/`audit` select all
cases after the full candidate case set is validated. Quick results cannot be
compared with the contest baseline or used as final evidence. `audit` and
`contest` are also distinct frontiers even though both are final-evidence
eligible.
