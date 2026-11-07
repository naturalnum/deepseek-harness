# Research Roadmap

Discovery Mode saves its roadmap through `research_roadmap`. Read this file only
when the user must choose a route or when a real Git branch or saved stage needs
to be connected to the roadmap. A simple single-route task does not need it.

## What gets saved

- Store one roadmap per goal in the fixed artifact id `research_roadmap`.
- Store the bounded projection in artifact metadata field `researchRoute`.
- Store the requirements for finishing the overall goal in `completionContract`.
  Each criterion has a stable id, requirement, status (`pending`, `satisfied`,
  `unsatisfied`, or `blocked`), and evidence ids. Satisfied or unsatisfied
  criteria require directly linked evidence; finishing one stage does not mean
  that the overall goal is finished.
- Treat Git branches returned by `project_workspace(action="frontier")`, checkpoints, artifacts,
  evidence, and metrics as implemented facts. Treat `researchRoute` as the
  Agent's prediction of useful next directions and a choice surface for the
  user; a predicted node is not evidence that work or a branch exists.
- Keep a node id stable across refreshes and state changes. Use a semantic id
  such as `route_external_validation`; never use array positions, timestamps, or
  a new random id for an existing direction.
- Keep the visible map anchored at the current focus node and bounded to at most
  three levels. Show 2-4 immediate choices only when their tradeoffs require a
  user decision; retain older completed nodes only when they clarify the current
  path.

`decision.selectableNodeIds` is the durable candidate set for the current
question; do not infer it from every proposed node. Before `user_input`, set the
decision to `pending` with those node ids and `updatedAt`. Do not invent a
`decision.requestId`: omit it while preparing the pending roadmap, then store
the actual id returned by `user_input` when recording the answer.

`title` should fit one compact line. `summary` should fit 2-3 short lines.
Allowed ETA units are `minute`, `hour`, `day`, and `week`; omit ETA when it is
not defensible. A proposed node must not contain `git.branchRef`.

## Node states

Use these persisted states: `proposed`, `selected`, `running`, `completed`,
`verified`, `blocked`, or `pruned`. Derive availability from prerequisite states
instead of persisting a second availability flag.

A proposed node is virtual. It may include a concise title, 2-3 line summary,
optional ETA, prerequisite node ids, and expected evidence. It must not claim a
branch, commit, metric, or completed artifact that does not exist.

Preserve the same node id as it moves through the lifecycle. Mark it `selected`
after the user chooses it, and link Git metadata only after a real branch or
commit was created by execution.

## When to ask the user

1. If no route is currently executable, report the exact blocker. Use
   `user_input` only when the user can resolve it.
2. If exactly one safe and materially useful route is executable, continue it
   without asking a ceremonial question.
3. If 2-4 feasible routes differ materially in objective, cost, risk, evidence,
   or expected result, persist those virtual nodes and a pending decision, then
   call `user_input` with the roadmap presentation.
4. Ask exactly one required `single_choice` question. Its option ids must match
   `decision.selectableNodeIds`; require explicit confirmation and disable auto
   recommendation. Keep labels concise and show ETA only when defensible.
5. After calling `user_input`, wait. Do not call another tool, continue analysis,
   update a report, emit more assistant text, or start another iteration until
   the result returns.
6. If the request expires or is cancelled, keep nodes virtual and stop. Never
   infer a selection from a recommended option.
7. If the roadmap revision changed while waiting, refresh it. Reuse the answer
   only when the selected node id still exists and remains feasible; otherwise
   explain the change and ask once with the refreshed choices.

## After the user chooses

1. On an answered request, store its real `requestId`, selected node id, and
   user-decision evidence; patch the same virtual node to `selected` with
   `baseRevision`.
2. Continue on the current branch when the selected step is small and does not
   need isolation.
3. Call `project_workspace(action="prepare_branch")` only when the selected step benefits from isolated code,
   data, manuscript, or experiment changes. The node must already be `selected`.
4. Do not prepare branches for unselected siblings. Do not activate an existing
   branch unless it represents an already approved node and the working tree is
   clean.
5. After `project_workspace(action="prepare_branch")`, execution, or
   `project_workspace(action="checkpoint")` actually returns a branch or commit,
   bind that returned Git fact to the selected node. Never predict a
   `branchRef`, `baseCommit`, or `checkpointCommit`.
6. Patch the selected node to `running` only when execution actually starts.
7. Patch it to `completed` only with attributable outputs and verification; use
   `verified` only with decision-bearing evidence or compatible measured metrics.
8. Mark a disproven or intentionally abandoned route `pruned`; use `blocked`
   when a named dependency prevents progress but the route may resume.

## When to refresh

Call `project_workspace(action="frontier")` at kickoff/resume, after a
meaningful checkpoint or branch change, when the stored route is stale, or
before branch comparison or activation. Do not call it at the start of every
loop iteration.

After a checkpoint, reconcile the matching node through its stable id. Do not
append a duplicate node merely because a new turn, artifact version, or commit
was created. Do not create a parallel plan file that mirrors `researchRoute`.
