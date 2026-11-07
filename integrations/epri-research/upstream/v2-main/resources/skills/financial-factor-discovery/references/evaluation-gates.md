# Evaluation Gates

## Before execution

- Required point-in-time fields are available and permitted.
- Label, sample, frequency, universe, delay, costs, and evaluator are frozen.
- Hypothesis, explanation, implementation, and expected sign/horizon agree.
- Code passes AST and forbidden-call checks.

## During execution

- Output is aligned to the expected date and asset index.
- Invalid values stay within the protocol threshold.
- Low-information dates, constants, and insufficient coverage are detected.
- Prefix-invariance and future-noise tests reject lookahead behavior.
- Repairs are minimal and re-run the failed gates.

## Promotion

Require hypothesis consistency, static integrity, walk-forward stability, cost after turnover, redundancy control, marginal portfolio value, and frozen out-of-sample evidence. Search scores and in-sample rewards may rank candidates but cannot promote them.

The held-out test set is used once for terminal reporting. It must not influence routing, prompts, mutation, repair, screening, or promotion.
