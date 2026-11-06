# Formal Proving And Evidence References

Use these references to choose a proving/review strategy. They inform the SOP;
they do not replace a local verifier receipt or project evidence.

## LeanDojo

- [LeanDojo-v2](https://github.com/lean-dojo/LeanDojo-v2) is the maintained
  repository for Git-pinned Lean tracing, theorem-state extraction, premise
  retrieval, and tactic/proof search.
- [LeanDojo user guide](https://leandojo.readthedocs.io/en/latest/user-guide.html)
  documents traced declarations, premises, tactic states, and dependency
  metadata.

DeepScientist should borrow the provenance discipline, not add a second memory
store: pin the Lean repository commit, record retrieved declarations and their
namespaces, save the proof attempt and replay command, and link the resulting
files through the existing Science Evidence and Project Git contracts.

## miniF2F

- [OpenAI miniF2F](https://github.com/openai/miniF2F) is a benchmark and
  evaluation fixture, not a proof database. Pin the benchmark revision and
  distinguish validation from held-out test statements.
- [OpenAI formal mathematics report](https://openai.com/index/formal-math/)
  illustrates iterative addition of Lean-verified proofs to a proving corpus.

Use benchmark statements for calibration and regression tests. A benchmark
pass is supporting evidence for the bounded benchmark scope; it is not evidence
that an arbitrary natural-language conjecture is true.

## AlphaProof-style separation

- [DeepMind IMO 2024 announcement](https://deepmind.google/blog/ai-solves-imo-problems-at-silver-medal-level/)
  describes the separation between formalization, search, and Lean-checked
  outcomes.
- [Nature: Olympiad-level formal mathematical reasoning with reinforcement learning](https://www.nature.com/articles/s41586-025-09833-y)
  describes proof/disproof search with Lean-grounded feedback and test-time
  search.

The local analogue is the two-lane workflow in `SKILL.md`: discovery may
generate candidates and bounded tests, while only a frozen, replayable formal
receipt can promote a universal proof or formal negation. Resource exhaustion,
timeouts, and “no witness found” remain `inconclusive`.

## Evidence extraction checklist

For each proof or disproof attempt, preserve:

```text
statementHash
theoremName and theoremDeclarationHash
claim (`statement` or `negation`)
targetCommit
proofPath or witnessPath
toolchain.lock hash
retrieved premises and source revision
exact command, cwd, timeout, and network policy
stdout/stderr or result hash
reproducibility level
supporting/refuting polarity
```

Do not copy a model's conclusion into the ledger without a durable source and a
replayable command. `statementHash` identifies the normalized portfolio claim;
it is not extracted by Lean. The verifier separately hashes the named theorem
declaration in the committed source. Keep the original informal statement
beside both values and require the independent review to confirm their semantic
correspondence, recording any equivalence uncertainty.

For a formal disproof, do not infer negation from a failed proof attempt. Verify
an explicit theorem proving the normalized negation with `claim=negation`, bind
the receipt to the same `statementHash` and committed proof blob, and attach it
to refuting evidence. For a computational counterexample, save both the minimal
witness and a deterministic checker that evaluates the exact assumptions and
conclusion; rerun the checker independently before marking the record decisive.
