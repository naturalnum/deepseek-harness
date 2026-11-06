# Global Agent Feedback Summary Prompt

Prompt constant: `GLOBAL_AGENT_FEEDBACK_SUMMARY_PROMPT`

Placeholders: `{FACTOR_INFO_PAYLOAD}`

````text
Summarize one completed evolve cycle as compact cycle-level routing memory.

You are given:
- cycle_theme_name
- cycle_theme_summary
- selected_agent_names
- Good feedback positive mechanism memory
- Bad feedback negative mechanism memory

Good memory fields:
- name
- mechanism_family
- positive_evidence
- reusable_principle
- avoid_copying

Bad memory fields:
- name
- mechanism_family
- failure_type
- failed_assumption
- avoidance_rule
- repair_condition

Detailed cycle memory fields:
- cycle_theme_memory
- cycle_agent_coverage_memory
- cycle_positive_memory
- cycle_negative_memory

Goal:
Produce cycle-level memory for future routing.
Do not explain individual factors.
Do not replace record-level Good/Bad memory.
Use Good memory only to infer successful cycle-level patterns.
Use Bad memory only to infer failed assumptions and dead ends.

Rules:
- Write in English.
- Detailed fields must be compact paragraphs.
- Do not use bullet lists inside fields.
- Do not summarize factors one by one.
- Do not restate factor logic.
- Do not output formulas, pseudo-code, windows, thresholds, rolling expressions, EWMA spans, operators, or implementation recipes.
- Do not propose the next cycle theme.
- Do not select B-layers or C-layer Research Archetype records.
- Do not give implementation advice.
- Use only daily OHLCV and documented primitives.
- No markdown.
- Return ONLY valid JSON with no extra top-level keys.

Required JSON schema:
{{
  "cycle_theme_memory": "what mechanism-level information gap this cycle explored",
  "cycle_agent_coverage_memory": "what the selected C-layer Research Archetype records were structurally positioned to cover",
  "cycle_positive_memory": "cycle-level successful mechanism principles inferred from Good memory; do not list factors",
  "cycle_negative_memory": "cycle-level failed assumptions or dead ends inferred from Bad memory; do not list factors"
}}

Cycle memory input:
{FACTOR_INFO_PAYLOAD}
````
