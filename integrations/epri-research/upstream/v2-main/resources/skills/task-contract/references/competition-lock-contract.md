# Pre-run competition lock contract

Use this contract only when the official session forbids human baseline
selection after execution starts. It changes the human-control gate; it does
not itself enable official submission. A separate, earlier
`official_submission authorize` contract is required for that capability.

## Arm fields

`competition_lock` with `operation: "arm"` requires exactly:

- absolute `project_root` for a fresh competition project;
- stable `competition_id` and registered `system_id`;
- `authorization_prompt_sha256` for the exact human-supplied pre-run prompt
  present in the retained execution trace;
- integer `baseline_attempt_limit` within `[1, 50]`;
- stable `idempotency_key` bound to the complete authorization request.

It must run before `task_import`, evaluator audit, baseline, trial, frontier, or
report state exists. The only policy is
`auto_confirm_first_passing.v1`: an attempt is consumed only after static
candidate, seal, audit, case/fixture, and aggregation checks pass and evaluator
execution begins. Precondition rejections create no attempt. The first passing
run is confirmed inside that same command, while an evaluator-executed failed
attempt remains immutable evidence. No post-start human confirmation or
attempt-limit increase is allowed.

## Read and verify

`operation: "read"` accepts only `project_root` and creates no command receipt.
Require:

- schema `deepscientist.ioai.competition-lock.v1`;
- `status: "armed"` and a recognized `state_status`;
- expected competition and system identities;
- matching authorization prompt SHA-256 from the execution trace;
- SHA-256 `lock_hash` plus normalized `lock_ref` and `state_ref`;
- internally consistent attempt limit, count, and remaining count;
- `authorization_timing: "before_task_import"`;
- `post_start_human_baseline_confirmation: "forbidden"`;
- `official_submission_enabled: false`.

Hash mismatch, missing state, an unfinished recovered attempt, changed seal
identity, or exhausted attempts is a stop condition. Do not repair or replace
Coordinator-owned files by hand.
