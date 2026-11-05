# Factor Lineage and Memory

## Lineage

Each factor record has:

- `parentFactorIds`
- `operation`: `seed`, `mutation`, `crossover`, `refinement`, `repair`, or `novelty`
- `cycleId` and `generation`
- `mechanismIds` and `archetypeIds`
- a concise `mutationSummary`
- `memoryRefs`

Seeds have no parents. Mutation, refinement, repair, and novelty have at most one parent. Crossover has at least two distinct parents. Parents must already exist and generations must advance. Historical lineage is immutable.

## Memory levels

1. Generation buffer: raw GOOD/BAD feedback, local and disposable.
2. Cycle summary: routing, decisions, failures, and surviving mechanisms in campaign state.
3. Project Memory: verified, compact, deduplicated knowledge promoted at a Git checkpoint.

Do not store private reasoning, full transcripts, repeated metrics, or unverified claims in Memory.
