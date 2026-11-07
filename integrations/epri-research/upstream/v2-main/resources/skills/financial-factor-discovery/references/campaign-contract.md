# Campaign Contract

## Canonical objects

- `factor-research/portfolio.json`: current candidates, lineage, metrics, checks, decisions, batches, and next actions.
- `factor-research/campaign.json`: campaign protocol, current phase, cycle and generation, budget, Team assignments, and revision.
- `factor-research/factors/<factor-id>/runs/<run-id>.json`: optional compact time-series and run evidence. Do not create it when no series exists.
- `memory/`: verified reusable methods, knowledge, and failure lessons only.

## State transitions

`scope -> memory -> macro -> ideation -> alignment -> simulation -> screening -> evolution -> validation -> decision -> complete`

Every transition requires the current revision and is idempotent. A failed or repeated transition must not duplicate candidates, jobs, Team assignments, Git commits, or reports.

## Protocol profiles

Treat the XAlpha paper settings as a named reproducibility profile, not universal defaults. A profile freezes seed count, population size, generation count, novelty schedule, scoring, correlation thresholds, split policy, costs, and evaluator. The held-out test partition is report-only and unavailable to generation or selection.

## Factor storage

Keep the complete factor record in the Portfolio: expression or code reference, hypothesis, settings, lineage, metrics, checks, evidence, artifacts, decision, and update time. One optional series file may hold chart points too large for the Portfolio.
