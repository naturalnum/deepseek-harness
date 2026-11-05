# XAlpha-guided factor campaign

This file keeps the historical reference name so old links continue to open. New tasks do not use the former schema-guided `factor_search` engine.

## One project route

1. Bound the question: universe, as-of time, horizon, available data, expected output, and budget.
2. The Lead chooses the shortest useful route and selects an XAlpha role template or creates a bounded generic role.
3. Each independent implementation or evaluation runs in its assigned Git worktree. The assignment names the exact base commit and the expected artifact.
4. Workers complete the `team_submit` handoff and place concise outputs, evidence, limitations, and the next recommendation in its `evidence` field. The reviewer notification is committed with the submission. Git submit additionally carries only the next unused content revision and immutable head. Use `team_send_message` only for optional follow-up context or attachments. Evidence, falsification, and verification are included when relevant, not as compulsory ceremony.
5. The Lead reviews and integrates exact commits. It may retry, delegate another role, or stop when additional work would not change the answer.
6. The Lead calls `factor_submit(action="submit")` once with the strongest candidate, roles, real metrics, charts/tables, limitations, and next actions.

## Role selection

- Report-to-Memory: extract reusable mechanisms from supplied reports or notes.
- Macro Brain: map mechanisms and choose a small hypothesis set.
- Micro Brain: implement, repair, mutate, or compare one candidate.
- Cross Brain: synthesize candidates or reconcile conflicting branches.
- Validator: run the most decision-relevant leakage, cost, stability, or robustness check.
- Generic roles: data auditor, researcher, implementer, visualization worker, reviewer, or another short role created for the task.

The role changes the assignment prompt, never the authority boundary. Workers cannot submit, checkpoint, publish, dispatch another Agent, or modify the Lead worktree.

## Recovery

- A failed Worker is reassigned only when the objective or route changes; do not loop on the same unavailable capability.
- A provider timeout or missing dataset becomes a visible limitation. Submit `partial` when useful work remains and `blocked` only when no reviewable output exists.
- Existing `factor_search` jobs and Portfolio files can be read for historical recovery, but a new task must not start or depend on them.

## User-facing result

The Factor workspace should show, in this order: current decision, candidate expression/hypothesis, active/completed roles, measured or pending metrics, chart/table/code artifacts, limitations, and next actions. Unknown metrics are omitted rather than written as zero.
