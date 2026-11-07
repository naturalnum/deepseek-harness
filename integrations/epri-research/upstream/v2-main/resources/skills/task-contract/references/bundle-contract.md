# Task bundle contract

Use a JSON object with `bundle_version: 1`. Resolve `bundle_path` and all
artifact paths inside the absolute project root. Every artifact path is
relative to the directory containing the bundle, not the project root or
current shell directory, and may not escape the bundle directory.

The worker invokes every `python-callable.v1` evaluator exactly as
`evaluate(candidate, fixture)`: decoded candidate JSON is the first positional
argument and decoded fixture JSON is the second. The configured public callable
may use another name, but it must preserve that parameter order. A deterministic
self-test must exercise the same order before the bundle is accepted.

## Minimal complete shape

```json
{
  "bundle_version": 1,
  "source": {
    "kind": "ioai-official-starter-kit",
    "rule_version": "ioai-2026.1"
  },
  "unknowns": [],
  "questions": [
    {
      "task_contract": {
        "task_id": "official-q1",
        "question": "Use the exact official question text or a traceable reference.",
        "rule_version": "ioai-2026.1",
        "allowed_models": ["gpt-5.6-sol"],
        "allowed_backends": ["openai"],
        "allowed_tools": ["mcp", "python"],
        "output_schema": {
          "type": "object",
          "required": ["answer"]
        },
        "deadlines": ["2026-08-01T12:00:00Z"],
        "budget": {
          "question_count": 3,
          "submissions_per_question": 50,
          "competition_windows": 2,
          "window_seconds": 21600,
          "report_reserve_seconds": 1800,
          "submission_reserve": 5
        },
        "compliance_rules": {
          "network_access": "disabled-during-hidden-rerun",
          "official_submission_enabled": false
        },
        "contract_version": 1
      },
      "validation_contract": {
        "validation_version": "official-q1-validation.v1",
        "evaluator_version": "official-q1-evaluator.v1",
        "metric_direction": "maximize",
        "cases": ["heldout-q1"],
        "case_grouping": "case",
        "repeat_seeds": [],
        "resource_limits": {
          "wall_clock_seconds": 60
        },
        "known_limitations": ["Public fixtures are a proxy for official hidden cases."],
        "contract_version": 1
      },
      "unknowns": [],
      "artifacts": {
        "prompts": ["prompt.md"],
        "evaluator": ["evaluator.py"],
        "fixtures": ["heldout-q1.json"],
        "data": ["input/train.pkl", "input/test.csv"],
        "config": ["config.json"]
      },
      "evaluator_adapter": {
        "kind": "python-callable.v1",
        "artifact": "evaluator.py",
        "callable": "score",
        "timeout_seconds": 10,
        "self_tests": [
          {
            "name": "known-score",
            "fixture": "heldout-q1.json",
            "candidate": { "score": 0.25 },
            "expected_score": 0.25
          }
        ]
      }
    }
  ]
}
```

Replace every example value with evidence from the current official task. Do
not carry the example budget, model, deadline, direction, or evaluator into a
real seal without verifying it.

The engine snapshots and hashes declared artifacts. If prompt artifacts exist
and `allowed_prompt_hashes` is omitted, the sealed task contract receives the
canonical hashes. A changed bundle or artifact must produce a new seal.

Every path under `artifacts.fixtures` must contain standards-compliant UTF-8
JSON because the evaluator worker JSON-decodes fixtures. Put raw `.pkl`, CSV,
Parquet, and similar official source files under `artifacts.data`; these files
are copied and hashed without being parsed. Convert evaluator inputs into a
deterministic JSON projection before import, using stable ordering and rejecting
NaN/Infinity, and declare the conversion code and conversion configuration
under `artifacts.config`.

## Import result checks

Require a ready workflow response with:

- `seal_id` matching `tc-<12 hex>` and a SHA-256 `seal_hash`;
- a normalized project-relative `manifest_ref`;
- the expected `question_count`;
- `contract_ready: true` and no unresolved contract blockers;
- an idempotency receipt for state-changing actions;
- `official_submission_enabled: false`.

The import intentionally reports evaluator execution as not yet verified.
Complete `evaluator_audit` before baseline work.
