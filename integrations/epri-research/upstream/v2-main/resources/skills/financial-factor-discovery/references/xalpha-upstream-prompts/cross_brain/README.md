# Cross Brain Prompts

The Cross Brain closes the feedback loop between generated factors and mechanism memory. It maps empirical factor outcomes back to the research taxonomy and turns GOOD/BAD examples into reusable lessons for later cycles.

## Components

- **Factor-to-B-layer attribution** maps a factor to a concrete mechanism-level category.
- **Factor-to-C-layer attribution** maps a factor to a broader research archetype.
- **Shared attribution rules** keep taxonomy assignments concise, evidence-based, and non-overlapping.
- **Factor record formatting** normalizes factor descriptions before attribution or feedback summarization.
- **GOOD feedback summarization** abstracts why successful factors worked and how their mechanisms can inspire future candidates.
- **BAD feedback summarization** abstracts why failed factors underperformed and what future prompts should avoid or repair.

## Usage

Use the matching Cross Brain system role from `../shared/`. Most templates are standalone user prompts:

- `factor_to_b_layer_prompt.md` + `../shared/factor_classification_agent.md`: fill `{B_ID_OPTIONS}`, `{B_LAYER_TAXONOMY}`, and `{FACTOR_PAYLOAD}` to choose one B-layer family.
- `factor_to_c_layer_prompt.md` + `../shared/factor_classification_agent.md`: fill `{SELECTED_B_LAYER}`, `{C_ID_OPTIONS}`, `{C_LAYER_CANDIDATES}`, and `{FACTOR_PAYLOAD}` to choose one C-layer agent.
- `good_feedback_summary_prompt.md` + `../shared/good_factor_summary_agent.md`: fill `{FEEDBACK_RECORDS}` with normalized GOOD records to extract reusable mechanism principles.
- `bad_feedback_summary_prompt.md` + `../shared/bad_factor_summary_agent.md`: fill `{FEEDBACK_RECORDS}` with normalized BAD records to extract failure patterns and avoidance rules.
- `factor_record_format.md` and `shared_rules.md` are internal reusable blocks embedded inside GOOD/BAD feedback summary prompts.

The resulting attribution and feedback summaries can be fed back into Macro Brain routing or Micro Brain fresh-seed generation.

## Templates

| Prompt Constant | Template | Type |
| --- | --- | --- |
| `BAD_FEEDBACK_SUMMARY_PROMPT` | `bad_feedback_summary_prompt.md` | Standalone user prompt |
| `FACTOR_TO_B_LAYER_PROMPT` | `factor_to_b_layer_prompt.md` | Standalone user prompt |
| `FACTOR_TO_C_LAYER_PROMPT` | `factor_to_c_layer_prompt.md` | Standalone user prompt |
| `GOOD_FEEDBACK_SUMMARY_PROMPT` | `good_feedback_summary_prompt.md` | Standalone user prompt |
| `_FACTOR_RECORD_FORMAT` | `factor_record_format.md` | Internal reusable block |
| `_SHARED_RULES` | `shared_rules.md` | Internal reusable block |
