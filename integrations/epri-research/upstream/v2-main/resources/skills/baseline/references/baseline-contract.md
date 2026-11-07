# Baseline candidate and MCP contract

Keep the candidate JSON inside the absolute project root. Bind it to the active
seal and cover exactly the validation cases declared by that seal.

## Candidate shape

```json
{
  "candidate_version": 1,
  "seal_id": "tc-0123456789ab",
  "baseline_id": "starter-kit-baseline",
  "source": {
    "kind": "ioai-starter-kit",
    "identity": "starter-kit-baseline.v1",
    "command": null
  },
  "known_deviations": ["This is a local sealed-evaluator comparator, not an official hidden-test score."],
  "questions": [
    {
      "task_id": "official-q1",
      "aggregation": "identity.v1",
      "cases": [
        {
          "case_id": "heldout-q1",
          "fixture": "heldout-q1.json",
          "candidate": {
            "answer": "candidate payload consumed by the sealed evaluator"
          }
        }
      ]
    }
  ]
}
```

A one-case question requires `identity.v1`. Multiple cases may use `arithmetic_mean.v1` only when arithmetic aggregation matches the sealed validation contract. Do not invent missing cases, change fixtures, or transform a metric to make its direction look better.

The `candidate` object is evaluator-specific. Produce it through the declared
starter command or another traceable local source. Record material command,
environment, model, and data differences in `source` or `known_deviations`.

## Operation fields

`run` requires exactly:

- `project_root`, `seal_id`, `operation: "run"`;
- project-relative `candidate_path`;
- stable `idempotency_key`.

`read` requires exactly:

- `project_root`, `seal_id`, `operation: "read"`;
- canonical `run_id`;
- no idempotency key.

`confirm` requires exactly:

- `project_root`, `seal_id`, `operation: "confirm"`;
- canonical `run_id`;
- stable `idempotency_key` tied to the immutable packet.

The Adapter rejects extra fields and identity mismatches.

## Result checks

For a passed run or read, verify:

- `run_id` matches `br-<8 hex>`;
- `seal_id`, `seal_hash`, and `evaluator_audit_id` match the active contract;
- `packet_hash` is a SHA-256 hash and refs are normalized project-relative
  paths;
- `metrics_summary` contains finite numbers;
- `primary_metric.metric_id` is present, its value is finite, and direction is
  exactly `maximize` or `minimize`;
- `confirmed` and the three confirmation fields are internally consistent;
- `confirmation_mode` is `manual_post_run` or `competition_lock` only when the
  gate is open;
- a locked result includes `competition_lock_hash`, lock status, and remaining
  pre-authorized attempts, while a manual result includes no lock hash;
- `official_submission_enabled` is false.

A failed run remains evidence but cannot be confirmed. A successful `confirm`
must return all of `confirmation_hash`, `confirmation_ref`, and
`metric_contract_ref`.
