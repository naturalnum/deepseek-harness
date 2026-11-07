# Hypothesis Subset Planner Prompt

Prompt constant: `HYPOTHESIS_SUBSET_PLANNER_PROMPT`

Placeholders: `{THEME_SUMMARY_BLOCK}`, `{RETRY_ERROR_BLOCK}`, `{MAX_SUBSET_SIZE}`, `{PROMPT_COUNT}`, `{HYPOTHESIS_POOL_BLOCK}`

````text
Plan mechanism-level hypothesis subsets for downstream factor generation.

{THEME_SUMMARY_BLOCK}{RETRY_ERROR_BLOCK}Group the candidate hypotheses into prompt subsets that explore meaningfully different alpha mechanism directions.

Planning rules:
- Think in mechanism space, not index space or coverage space.
- Each subset should represent one coherent direction, such as event-response, setup-trigger-confirmation, regime-dependent behavior, liquidity response, volatility state, momentum, reversal, or participation.
- Combine hypotheses only when together they create a stronger or clearer mechanism direction.
- Keep a hypothesis alone when it already defines a distinctive standalone mechanism.
- The `reason` must explain the mechanism link or standalone mechanism value.
- Prefer subsets that can inspire one concise factor idea without stacking unrelated effects.

Strict anti-patterns:
- Do not group by index order, coverage pattern, or subset size.
- Do not enumerate singles, pairs, triples, or larger tuples mechanically.
- Do not pair broad and specific hypotheses unless they create one coherent mechanism.
- Do not mix unrelated ideas just to increase subset count.

Subset size:
- Prefer 1-3 hypotheses per subset.
- Use 4-{MAX_SUBSET_SIZE} only when the mechanism direction is genuinely coherent and each hypothesis contributes a distinct role.
- Smaller is better when the mechanism is already clear.
- Larger is acceptable only when it improves mechanism clarity rather than adding noise.

Requirements:
- Return exactly {PROMPT_COUNT} subsets.
- Each subset must be non-empty.
- Each subset must contain at most {MAX_SUBSET_SIZE} hypothesis indices.
- Use only the hypothesis indices listed below.
- Different subsets should explore meaningfully different mechanism directions.
- Do not order subsets by subset size, hypothesis index order, or any other mechanical pattern.
- Order subsets by expected downstream usefulness, with the strongest or most promising mechanism direction first.
- Each subset must include a short non-empty `reason`.
- Do not use vague reasons such as `diverse`, `broad coverage`, `balanced mix`, or `complementary` without explaining the actual mechanism link.
- Return ONLY valid JSON.

JSON format:
The subset list should be priority-ordered by expected downstream usefulness, not size-ordered.

{{
  "subsets": [
    {{"hypothesis_indices": [1, 4], "reason": "These hypotheses form a setup-confirmation direction where pre-event strength is validated by stressed participation before possible post-event drift."}},
    {{"hypothesis_indices": [2], "reason": "This hypothesis already defines a distinctive reversal mechanism and is best explored without dilution."}},
    {{"hypothesis_indices": [3, 5, 7], "reason": "Together they describe unstable price-volume behavior that may support an exhaustion or delayed-reaction factor mechanism."}}
  ]
}}

Hypothesis pool:
{HYPOTHESIS_POOL_BLOCK}
````
