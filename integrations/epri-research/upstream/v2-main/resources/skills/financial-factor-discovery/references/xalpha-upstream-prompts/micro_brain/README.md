# Micro Brain Prompts

The Micro Brain converts research hypotheses into executable alpha-factor code. It is responsible for code generation, alignment checking, runtime repair, and evolutionary exploration of candidate factors.

## Components

- **Evolution planning** decides how a factor candidate should be improved or diversified.
- **Mutation, crossover, and refinement** generate new factor variants while preserving financial interpretability and executable structure.
- **Alignment review** checks whether generated code matches the stated hypothesis and financial mechanism.
- **Alignment revision** rewrites mismatched factors so the implementation better reflects the intended idea.
- **Runtime repair** fixes execution failures without changing the core factor intent.

## Generation Assembly

For a new factor, assemble the user prompt in this order:

1. Active-agent intro with `{columns_num}`, `{columns_desc}`, and `{num_per_request}` filled.
2. Optional fresh-seed feedback brief, when GOOD/BAD feedback is available.
3. Active-agent factor-design guidance, optionally with selected hypothesis bullets inserted.
4. `../shared/shared_requirements_prompt.md`.
5. `../shared/complexity_constraints_prompt_template.md`.
6. A generation-task block requesting exactly one final factor.
7. Shared library and coding-guideline blocks from `../shared/`.
8. `../shared/shared_output_format_prompt_template.md`.

Use `---` separators between major user-message blocks. Use `../shared/normal_factor_agent.md` for ordinary seed generation and `../shared/novelty_factor_agent.md` when the prompt uses novelty or fresh-seed feedback.

## Other Micro Brain Prompts

- `evolution_planner_prompt.md` + `../shared/evolution_planner_agent.md`: fill the parent pool, target child count, and suggested mutation/crossover/refinement counts.
- `mutation_prompt.md` + `../shared/mutation_agent.md`: fill `{INTRO}`, `{PARENT_FACTOR_DEFINITION_BLOCK}`, `{ORIGINAL_FACTOR_CODE}`, and shared requirement/library/output-format blocks.
- `crossover_prompt.md` + `../shared/crossover_agent.md`: fill `{INTRO}`, `{PARENT_FACTOR_DEFINITION_BLOCK}`, both parent factor code blocks, and shared blocks.
- `refinement_prompt.md` + `../shared/refinement_agent.md`: fill `{INTRO}`, `{PARENT_FACTOR_DEFINITION_BLOCK}`, `{ORIGINAL_FACTOR_CODE}`, and shared blocks.
- `alignment_review_prompt.md` + `../shared/alignment_review_agent.md`: fill original code, stripped code, docstring, and comments.
- `alignment_revision_prompt.md` + `../shared/alignment_revision_agent.md`: fill column schema, old code, hypothesis/factor definition, alignment feedback, and shared blocks.
- `runtime_repair_prompt.md` + `../shared/code_repair_agent.md`: fill column schema, old code, error or AST feedback, repair rules, and shared blocks.

## Templates

| Prompt Constant | Template |
| --- | --- |
| `ALIGNMENT_REVIEW_PROMPT` | `alignment_review_prompt.md` |
| `ALIGNMENT_REVISION_PROMPT` | `alignment_revision_prompt.md` |
| `CROSSOVER_PROMPT` | `crossover_prompt.md` |
| `EVOLUTION_PLANNER_PROMPT` | `evolution_planner_prompt.md` |
| `MUTATION_PROMPT` | `mutation_prompt.md` |
| `REFINEMENT_PROMPT` | `refinement_prompt.md` |
| `RUNTIME_REPAIR_PROMPT` | `runtime_repair_prompt.md` |
