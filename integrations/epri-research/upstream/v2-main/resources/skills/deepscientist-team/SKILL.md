---
name: deepscientist-team
description: Coordinate a Core Team with bounded WorkItems, role presets, evidence review, and explicit Git integration.
---

# DeepScientist Team

Core Team WorkItems are the only coordination authority. Do not create a parallel assignment, status, or delivery protocol in prompts, files, chat messages, or MCP tools.

MCP and Team CLI reach the same Core runtime. Do not switch transports to retry a business or runtime-state error. Retry only failures explicitly marked retryable, and reuse the same idempotency key.

## Lead

1. Call `team_members` for the current roster, then `team_inspect` for WorkItems and exact revisions.
2. Keep trivial or tightly coupled work local. Use `team_delegate` only for independent, bounded work with a clear assignee, objective, acceptance criteria, failure criteria, and delivery requirement.
3. Reuse one capability preflight. Do not make every Worker rediscover the same tool, data, credential, network, or compute limitation.
4. A successful `team_delegate` atomically queues the assignee notification; for Git work it includes the server-prepared workspace. End the turn after delegation and do not poll unchanged state.
5. Review the submitted evidence or exact Git delivery with `team_review`. Request changes precisely when acceptance criteria are not met.
6. Accepting a delivery does not merge Git. Inspect the accepted WorkItem for exact revisions, then call `team_integrate`. Never run raw `git merge`, `git cherry-pick`, `git rebase`, `git reset`, `git update-ref`, or force-move the integration target; `team_integrate` is the only supported target-changing path and derives its evidence server-side.
7. Use `team_cancel` for obsolete work; cancellation and its assignee notification are one durable command. Cancelled submissions cannot be accepted. The Lead alone performs canonical evaluation, submission, publication, and final synthesis.

## Worker

1. Treat the assigned WorkItem as the complete scope. Do not run Lead intake, delegate another Agent, or mutate canonical project state.
2. Call `team_progress` when starting, blocking, or resuming. A blocker must include the failed condition and useful evidence as the command's `context`.
3. For Git work, edit and commit only in the `prepared_workspace` sent by the Lead. Never edit the Lead workspace, choose another branch, run `git update-ref`, or force-move the integration target.
4. Call `team_submit` once with concise `evidence`, verification, limitations, and the cheapest decisive failure test. The state transition, evidence, and reviewer notification are committed together. Git submission additionally carries the next unused `content_revision` and exact immutable head commit; inspect existing deliveries after changes are requested. Use `team_send_message` only for optional follow-up context or attachments.
5. Stop after submission. Do not merge, review your own work, publish, or maintain a parallel status record.

Read [references/mode-gates.md](references/mode-gates.md) before a target, factor, medical, or Challenge submission. Domain tools remain subject to their own authorization and evidence rules.
