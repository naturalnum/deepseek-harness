# Local evaluation decision contract

Use canonical frontier ordering and immutable packets. This contract does not
authorize an official submission or define a remote submission action.

## Hard evidence gates

Require every candidate considered for a local decision to satisfy:

- active `seal_id` and `task_id` match;
- profile matches across snapshot, frontier, validation, candidate, and packet;
- passed evaluator audit identity and receipt hash match;
- validation and evaluator versions match the current contract;
- packet hash and result ref match immutable storage;
- result is valid, score is finite, direction is legal, and all declared cases
  are present;
- post-run context gate passed and the candidate spec hash is present;
- source, attributable change, prompt/code/tool/model traces, deviations, token
  usage, compute usage, and failure state are explicit;
- no unresolved rule, leakage, isolation, integrity, or evidence blocker.

An invalid or partial candidate remains useful diagnostic evidence but cannot
be accepted as the local incumbent even if a partial score appears high.
Likewise, `smoke` and `sprint` are screening evidence only. Their only promotion
route is a full `contest` rerun. Never compute a delta or better/worse relation
between different profiles, including between `audit` and `contest`.

## Decision evidence

Use the canonical snapshot for incumbent and runner-up identities. Audit these
dimensions without constructing a competing score table:

| Dimension           | Required evidence                                                 |
| ------------------- | ----------------------------------------------------------------- |
| Primary result      | Local sealed metric, direction, baseline delta, runner-up delta   |
| Stability           | Case-level pattern, repeats/seeds when declared, sensitivity      |
| Validity            | Schema success, complete cases, current evaluator and seal        |
| Generalization risk | Leakage audit, overfit risk, public-proxy dependence              |
| Provenance          | Candidate, code, prompt, tools, model calls, hashes               |
| Cost                | Measured tokens, compute seconds, CPU/GPU use, abandoned cost     |
| Diversity           | Whether evidence adds a distinct mechanism or only duplicates one |

Large unexplained gains, exact-boundary wins, gains isolated to one case,
changed validation, and missing provenance require a diagnostic or audit trial.
They are not automatic promotion or submission evidence.

## Allowed outcomes

Return one outcome:

```text
decision: report | trial | idea | optimize | blocked
frontier_revision: <non-negative integer>
profile: smoke | sprint | contest | audit
snapshot_hash: <sha256>
incumbent_trial_id: <canonical trial id or null>
runner_up_trial_id: <canonical trial id or null>
accepted_packet_refs: <list>
rejected_packet_refs: <list>
reason: <evidence-grounded explanation>
required_next_evidence: <list>
official_submission_enabled: false
```

`report` means only that current local evidence is coherent enough to freeze.
It is not an official-submission approval. `trial` requests a named diagnostic
or independent check. `idea` requests a new mechanism-level hypothesis through
`ds-idea`; `optimize` requests another bounded attempt inside an accepted line.
`blocked` identifies an integrity, legality, contract, evidence, or budget gate.

No outcome may create a remote receipt, claim a hidden score, spend submission
quota, or state that a submission was sent.
