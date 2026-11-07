# Factor To B Layer Prompt

Prompt constant: `FACTOR_TO_B_LAYER_PROMPT`

Placeholders: `{B_ID_OPTIONS}`, `{B_LAYER_TAXONOMY}`, `{FACTOR_PAYLOAD}`

````text
Classify one generated quantitative factor into exactly one B-layer from the documented taxonomy.

Rules:
- Choose exactly one `b_id` from Available b_id options.
- Use Hypothesis Idea and Logic as primary evidence; use Sub-Mechanism Tags and code only as supporting evidence.
- Classify by the dominant implemented mechanism, not generation context, field choice, or implementation detail.
- Ignore the agent that generated the factor if the implemented mechanism points elsewhere.
- If multiple B-layers are plausible, choose the closest specific mechanism-level fit.
- Return ONLY valid JSON.

Available b_id options:
{B_ID_OPTIONS}

Required JSON schema:
{{
  "b_id": "<one b_id from Available b_id options>"
}}

Documented B-Layer Taxonomy:
{B_LAYER_TAXONOMY}

Factor Payload:
{FACTOR_PAYLOAD}
````
