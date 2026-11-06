# Active Agent Hypothesis Prompt Template

Prompt constant: `_ACTIVE_AGENT_HYPOTHESIS_PROMPT_TEMPLATE`

Usage note: derived template used to form broad and specific active-agent hypothesis prompts; fill `{MODE_RULES}` before use.

Placeholders: `{HYPOTHESIS_COUNT_REQUIREMENT}`, `{MODE_RULES}`, `{AGENT_NAME}`, `{CORE_MECHANISM}`, `{RESEARCH_PATHS}`

````text
Generate `factor_hypotheses` for the provided agent specification.

Return ONLY valid JSON:
{{
  "factor_hypotheses": [
    {{
      "hypothesis_idea": "...",
      "sub_mechanism_tags": ["...", "..."]
    }}
  ]
}}

Rules:
- Write exactly {HYPOTHESIS_COUNT_REQUIREMENT} concise hypothesis idea records as a JSON object list.
- Each hypothesis idea record must contain exactly two fields:
  - "hypothesis_idea"
  - "sub_mechanism_tags"
- Each hypothesis_idea should express one clear alpha mechanism: market state, observable behavior, and expected forward implication.
- Use only daily OHLCV-observable information.
- Do not rely on external data such as news, fundamentals, sectors, benchmarks, macro variables, analyst data, or event labels.
- Each hypothesis must include 1-4 concise sub_mechanism_tags.
- Do not omit sub_mechanism_tags for any record; an item without this non-empty list is invalid.
- Use sub_mechanism_tags to keep hypotheses mutually different; avoid near-duplicate phrasings.
- Prefer one clear mechanism with at most one supporting condition.
- Avoid turning every hypothesis into a complete factor formula.
{MODE_RULES}

- No extra fields.
- No extra explanation.
- No markdown code fences.

Input:
<agent_spec>
Agent Name:
{AGENT_NAME}

Core Mechanism:
{CORE_MECHANISM}

Research Paths:
{RESEARCH_PATHS}
</agent_spec>
````
