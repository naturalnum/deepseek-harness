# Factor Team Roles

The Lead materializes only roles needed for the current phase. Do not equate the full archetype catalog with persistent Agent processes.

| Role | Typical delivery | Default isolation |
| --- | --- | --- |
| Report Memory Curator | eligible mechanism and archetype records | artifact-only |
| Macro Strategist | cycle route and hypothesis set | artifact-only |
| Hypothesis Engineer | bounded seed or evolution proposals | artifact-only |
| Point-in-Time Auditor | timestamp and leakage counterexamples | shared-readonly |
| Alignment Reviewer | hypothesis/text/code/plausibility verdict | shared-readonly |
| Code and Runtime Auditor | patch plus verification receipt | isolated-worktree when editing |
| Evaluation Reviewer | falsification, stability, cost, redundancy | shared-readonly |
| Cross Memory Curator | deduplicated GOOD/BAD records | artifact-only |
| Ad-hoc Specialist | one explicit gap with completion criteria | role-specific |

At most the configured concurrency runs at once. Additional roles wait in the Team queue. Ten available Workers increase breadth only when assignments are independent; they must not create ten canonical searches or edit the same factor concurrently.
