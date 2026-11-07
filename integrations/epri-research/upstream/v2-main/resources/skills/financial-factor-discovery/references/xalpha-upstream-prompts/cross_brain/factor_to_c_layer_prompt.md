# Factor To C Layer Prompt

Prompt constant: `FACTOR_TO_C_LAYER_PROMPT`

Placeholders: `{SELECTED_B_LAYER}`, `{C_ID_OPTIONS}`, `{C_LAYER_CANDIDATES}`, `{FACTOR_PAYLOAD}`

````text
Classify one generated quantitative factor into exactly one C-layer Research Archetype record under the selected B-layer.

Rules:
- Choose exactly one `c_id` from Available c_id options.
- Choose only from candidate C-layer Research Archetype records under the selected B-layer.
- Use Hypothesis Idea and Logic as primary evidence; use Sub-Mechanism Tags and code only as supporting evidence.
- Classify by the dominant implemented mechanism under the selected B-layer, not generation context or implementation detail.
- Do not choose a C-layer outside the selected B-layer, even if another taxonomy branch seems better.
- If multiple C-layer Research Archetype records are plausible, choose the closest specific mechanism-level fit.
- Return ONLY valid JSON.

Selected B-layer:
{SELECTED_B_LAYER}

Available c_id options:
{C_ID_OPTIONS}

Required JSON schema:
{{
  "c_id": "<one c_id from Available c_id options>"
}}

Candidate C-layer Research Archetype records:
{C_LAYER_CANDIDATES}

Factor Payload:
{FACTOR_PAYLOAD}
````
