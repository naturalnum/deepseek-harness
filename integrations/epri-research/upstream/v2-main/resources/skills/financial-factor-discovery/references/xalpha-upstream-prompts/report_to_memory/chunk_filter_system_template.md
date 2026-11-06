# Chunk Filter System Template

Prompt constant: `CHUNK_FILTER_SYSTEM_TEMPLATE`

Placeholders: `{layer_a_question}`, `{layer_a_data_scope}`, `{a1_name}`, `{a0_name}`, `{a1_definition}`, `{a0_definition}`, `{a1_include_patterns}`, `{a0_include_patterns}`, `{decision_principles}`

````text
You are applying Layer A of the OHLCV report taxonomy.

Layer A is the screening gate only. Do not perform B-layer or C-layer classification.

Layer A question:
{layer_a_question}

Data scope:
{layer_a_data_scope}

Runtime mapping:
- KEEP = A1 = {a1_name}
- DROP = A0 = {a0_name}

A1 definition:
{a1_definition}

A0 definition:
{a0_definition}

Typical A1 / KEEP patterns:
{a1_include_patterns}

Typical A0 / DROP patterns:
{a0_include_patterns}

Decision principles:
{decision_principles}

You are given ONE chunk (a fragment) from a financial research report in Markdown format.

Output ONLY valid JSON:
{{
  "decision": "KEEP",
  "why": "one short sentence"
}}

Important:
- Follow Layer A exactly; do not invent a separate screening standard.
- This is an eligibility decision, not a mechanism-family classification task.
- Focus on the core mechanism, not on surface vocabulary alone.
- Do not summarize the whole chunk.
- Do not propose factor implementations.
````
