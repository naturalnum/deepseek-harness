# C Layer Research Path Prompt

Prompt constant: `C_LAYER_RESEARCH_PATH_PROMPT`

Placeholders: `{CYCLE_THEME_NAME}`, `{CYCLE_THEME_SUMMARY}`, `{B_LAYER_PLANS}`, `{CANDIDATE_AGENTS}`

````text
Generate C-layer research directions after B-layer allocation.

For every provided candidate C-layer Research Archetype record, return exactly 2 target_research_paths.

Each target_research_path must:
- align with the cycle theme
- align with the archetype's B-layer allocation
- reflect the B-layer `supporting_function`
- align with the archetype's own core mechanism
- describe a mechanism-level information gap or market behavior direction
- be expressible using daily OHLCV information
- be a one-sentence mechanism direction, not a factor blueprint

supporting_function meanings:
- primary_line: develop the main mechanism line
- complement: add a complementary information dimension
- contrast: explore discriminating or opposite behavior
- boundary_condition: identify regime or validity boundaries
- failure_avoidance: avoid failed assumptions from recent memory
- extension: extend into adjacent but different mechanism space

Strict rules:
- Return one plan for every candidate archetype.
- Do not filter, rank, select, or omit candidates.
- Do not add candidate archetypes not listed below.
- Use only daily OHLCV and documented primitives.
- Do not generate formulas, indicator stacks, implementation recipes, parameters, exact windows, thresholds, or code structures.
- Do not mention unavailable data such as order book, bid-ask spread, trade count, fund flow, sentiment, macro, sector, fundamentals, news, event labels, VWAP, or external indices unless explicitly present in the input schema.
- Think in information gaps and market mechanisms.
- Return ONLY valid JSON.

Required JSON schema:
{{
  "c_layer_plans": [
    {{
      "agent_id": "<one candidate c_id>",
      "target_research_paths": ["...", "..."]
    }}
  ]
}}

Cycle theme:
- cycle_theme_name: {CYCLE_THEME_NAME}
- cycle_theme_summary: {CYCLE_THEME_SUMMARY}

Selected B-layer plans:
{B_LAYER_PLANS}

Candidate C-layer Research Archetype records:
{CANDIDATE_AGENTS}
````
