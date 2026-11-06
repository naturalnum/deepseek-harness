# Evolution Planner Prompt

Prompt constant: `EVOLUTION_PLANNER_PROMPT`

Placeholders: `{GENERATION}`, `{CYCLE_LEN}`, `{TARGET_CHILD_COUNT}`, `{SUGGESTED_MUTATION_COUNT}`, `{SUGGESTED_CROSSOVER_COUNT}`, `{SUGGESTED_REFINEMENT_COUNT}`, `{PARENT_CARDS}`

````text
Plan one generation of mechanism-level child-factor creation.

Decide:
- which parents to use for mutation
- which parent pairs to use for crossover
- which parents to use for refinement

Goal:
Create a useful mechanism-level execution plan for downstream factor generation.

Planning rules:
- Think in mechanism space, not parent index space.
- Prefer promising, interpretable, and non-redundant mechanisms.
- Treat parent_tier=elite as a higher-priority source, but keep parent_tier=normal eligible for mutation, crossover, and refinement.
- Let higher EvolutionScore increase parent priority within each tier, but do not select a parent only because its score is high.
- Mutation should be used when one parent has a useful mechanism that should be pushed, redirected, conditioned, or made more robust.
- Crossover should be used only when two parent mechanisms are genuinely complementary and may create a stronger mechanism together.
- Refinement should be used when one parent has a useful mechanism but the implementation appears too complex, noisy, redundant, or unstable.
- Crossover may use elite x elite, elite x normal, or normal x normal when the mechanisms are complementary.
- Reuse the same parent or crossover pair only when each reuse has a genuinely different mechanism reason and child goal.
- Favor plans that explore different mechanism directions rather than repeating the same pattern.

Strict anti-patterns:
- Never plan by index order or mechanical coverage.
- Never select parents only to fill suggested counts.
- Never create crossover pairs without a clear mechanism complement.
- Never reuse parents mechanically just to fill counts.
- Never pair near-duplicates or unrelated parents in one crossover.
- Never prioritize a parent only because it is elite if its mechanism is redundant or weak.
- Never create many children that all explore the same mechanism direction.
- Never use refinement as a generic cleanup bucket when mutation or crossover would be more meaningful.

Current generation context:
- generation={GENERATION}
- cycle_len={CYCLE_LEN}
- target_child_count={TARGET_CHILD_COUNT}
- suggested_mutation_count={SUGGESTED_MUTATION_COUNT}
- suggested_crossover_count={SUGGESTED_CROSSOVER_COUNT}
- suggested_refinement_count={SUGGESTED_REFINEMENT_COUNT}
- Use the suggested counts as the default plan.
- Change them only if the parent pool clearly supports a better mechanism-level operator mix.

Output requirements:
- Return ONLY valid JSON.
- Use plain integer parent indices from the parent pool, not labels like P1.
- Parent indices are 1-based: the first parent is 1, the second is 2, and index 0 is invalid.
- Return a top-level `target_child_count` equal to {TARGET_CHILD_COUNT}.
- Return an `operators` object with `mutation`, `crossover`, and `refinement` blocks.
- The total number of planned children across mutation, crossover, and refinement must equal {TARGET_CHILD_COUNT}.
- Each mutation/refinement item must have exactly one parent index.
- Each crossover item must have exactly two parent indices.
- Each operator block must contain `count`, `ratio`, and `plans`.
- Each operator block must satisfy `count == len(plans)`.
- The three operator `count` values must sum to `target_child_count`.
- Each item must contain a short non-empty reason string explaining why this parent or pair is worth choosing.
- Each item must contain a short non-empty goal string.
- Each reason should justify the selection in terms of mechanism quality, mechanism complementarity, mutation value, or refinement value.
- Each goal should tell the downstream factor-writing model what mechanism-level change, recomposition, or simplification to explore next.
- Keep reason and goal distinct: reason explains why this plan is chosen; goal explains what the child mechanism should try to become.
- Avoid goals that only say to add rank, smoothing, scaling, clipping, normalization, or another cosmetic wrapper.

JSON format:
{{
  "target_child_count": 3,
  "operators": {{
    "mutation": {{
      "count": 1,
      "ratio": 0.33,
      "plans": [
        {{"parent_indices": [3], "reason": "this parent has a promising breakout participation mechanism but its trigger may be too noisy", "goal": "mutate the trigger into a cleaner participation-confirmed continuation mechanism"}}
      ]
    }},
    "crossover": {{
      "count": 1,
      "ratio": 0.34,
      "plans": [
        {{"parent_indices": [2, 7], "reason": "one parent captures event timing while the other captures post-event confirmation", "goal": "recompose timing and confirmation into a single event-response mechanism"}}
      ]
    }},
    "refinement": {{
      "count": 1,
      "ratio": 0.33,
      "plans": [
        {{"parent_indices": [9], "reason": "the parent mechanism is useful but the implementation appears over-stacked and redundant", "goal": "preserve the core mechanism while removing non-essential complexity"}}
      ]
    }}
  }}
}}

Parent pool cards:
{PARENT_CARDS}
````
