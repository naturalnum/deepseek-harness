---
name: ioai-candidate-preparation
description: Prepare one evidence-backed Challenge candidate attempt quickly from a Lead-sealed atomic assignment.
---

# Challenge Candidate Preparation

This is the Subagent fast profile of the native DeepScientist
`ds-idea -> ds-optimize -> ds-experiment` loop. The Lead already owns broad
ideation, Optimization Lines, Science artifact state, and canonical decisions.
Do not reopen those stages inside one candidate turn.

The Lead selects the hypothesis and owns evaluator admission. Materialization,
the exact cheap check, hashing, and Prepared Candidate Evidence are one atomic
task. The Subagent never calls `trial_run` or `trial_batch`.

## Input Gate

Require one complete `deepscientist.ioai.competition.atomic-assignment.v1`
packet plus `active_team_turn` from the current Subagent turn's
`ioai_competition(action="system_status")` result. The Competition MCP derives
that identity from the conversation-bound Core runtime token and `/run-state`;
do not use `team context`, which does not contain run/turn identity. Reject the
assignment when any of these are absent or placeholders:

- project, seal, task, Team, slot, role, and lane identity;
- `active_team_turn.team_run_id` and `active_team_turn.turn_id`;
- the Core-bound process Capability's matching Team, slot, role, and lane;
- current numeric frontier revision and sealed aggregation;
- source identity and model;
- preflight receipt, absolute Python executable, and exact cheap-check argv;
- candidate path, entrypoint, fixture cases, and all bundle dependencies;
- one falsifiable hypothesis with evidence, contrary hypothesis, cheapest
  falsification, cost, and stop condition.
- during normal Search, one exact `search.lineage` contract naming the search
  level, control/mechanism role, Idea/Line, mechanism family, change layer,
  evidence, falsification condition, and strongest-alternative disposition.

Calculate the final Candidate Attempt file SHA-256 and return it with the exact
`candidate_id`, `team_id`, `slot_id`, `team_run_id`, and `turn_id`. Do not
change the file after hashing it. A Capability or attribution mismatch is
terminal for the assignment and must not be retried with invented identity
values.

When the task card says `control.route=recovery`, add the top-level immutable
`recovery_intent` object to the Candidate Attempt. Copy the exact current
`recovery_key`, `seal_id`, `task_id`, `candidate_id`, and source frontier
revision; use purpose `minimum_valid_candidate`. Keep it absent during Search,
and never reuse it after the Coordinator reports a canonical first score.
Recovery candidates may omit `search.lineage`; they cannot anchor tuning.

## Fast Workflow

Use the built-in `tools.apply_patch` tool directly for source edits. Do not use
a PATH patch shim, PowerShell here-string, or nested Codex process.

The only permitted first tool call is the Coordinator `system_status` health
gate. Do not inspect files or call another tool before that gate succeeds. Do
not call generic `team_*` tools; the Lead and Competition Coordinator own
dispatch and coordination for this sealed assignment.

1. Read the assignment and referenced evidence once, then call
   `ioai_competition(action="system_status")` once as the MCP startup health
   gate. Require `status=ready`,
   `official_submission_enabled=false`, and a complete `active_team_turn`
   matching the assigned Team and slot. If the tool is unavailable or identity
   is mismatched, stop before writing candidate files and report
   `MCP_HEALTHCHECK_FAILED`; the Lead must quarantine only this slot while other
   healthy lanes continue. Do not rediscover the environment,
   scan unrelated files, or load the full research skill chain.
2. Confirm that the assigned mechanism is distinct from its stated parent or
   failure repair. If it is unsupported, return a concise rejection instead of
   manufacturing a parameter change.
3. Implement the smallest complete end-to-end candidate. Keep evaluation,
   metric parsing, frontier writes, and official submission out of the source.
4. Declare the entrypoint and every candidate-owned official data, model, or
   project module opened or imported at runtime in `attempt.include_paths`.
   Never open or package `.deepscientist` or a sealed fixture: the Coordinator
   owns those files and candidate input intentionally exposes only `case_id`.
   Reconstruct inference rows from official data under the sealed
   split/validation method without reading fixture targets.
5. Set `candidate.candidate_id == trial.trial_ref`; copy exact Team and slot
   identity from the assignment and exact run/turn identity from
   `active_team_turn`. One Team run may span multiple turns, so never omit or
   reuse `turn_id`. Use the sealed aggregation
   and the assignment's source identity/model.
   During Search, copy the Lead-authorized `search.lineage` unchanged. A TPE
   candidate must use `search_level=hyperparameter`, `candidate_role=mechanism`,
   and the Idea/Line identities in its immutable materialization binding.
6. Copy the task contract's candidate wall-clock budget from the assignment.
   Shorten it for trivial deterministic programs; never extend it beyond the
   sealed budget or remaining contest reserve.
7. Run only the supplied cheap-check argv before returning. Do not train through
   an alternate path, install, or submit.
8. After the cheap check passes, return the prepared candidate path/hash,
   attribution, source revision, dependency list, and cheap-check result to the
   Lead. Do not read the frontier, reserve a trial, run evaluation, tune, report,
   or submit.

## Quality Gate

Before returning, verify:

- no null, display-name, guessed, or placeholder identity;
- `source_frontier_revision` is a nonnegative integer;
- candidate JSON has exact Candidate Attempt v2 fields;
- the prepared candidate belongs to this exact task, seal, profile, Team run,
  and turn;
- scenario/case keys are unique when the candidate constructs a mapping;
- every action/output satisfies the sealed schema and bounded limits;
- the candidate remains attributable to one mechanism or one concrete repair;
- normal Search candidates preserve the assigned search lineage, and no
  control candidate is presented as a tuning parent;
- no shared Coordinator, evaluator, budget, frontier, or submission file was
  modified.

Prepared Candidate Evidence is not canonical experiment evidence. The Lead owns
`trial_run` and `trial_batch`, packet interpretation, Science registration,
promotion, and refill decisions.
