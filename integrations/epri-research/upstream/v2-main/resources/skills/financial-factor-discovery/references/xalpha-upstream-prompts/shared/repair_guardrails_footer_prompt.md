# Repair Guardrails Footer Prompt

Prompt constant: `REPAIR_GUARDRAILS_FOOTER_PROMPT`

Placeholders: None

````text
- Do not use columns that are not listed in the schema.
- Keep the repair minimal and targeted when possible.
- Preserve the original economic intent when it still matches the repaired code.
- If you change the implemented logic, update `hypothesis_idea`, `sub_mechanism_tags`, `logic`, docstring, and comments so they describe the final code exactly.
````
