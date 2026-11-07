# Shared Prompt Blocks

Shared prompt blocks define the common instruction layer used across XAlpha. They are not a separate brain; instead, they provide reusable system roles, constitutions, coding rules, output contracts, and repair guardrails that keep the Macro Brain, Micro Brain, and Cross Brain behavior consistent.

## Components

- **System roles and constitutions** define the high-level responsibilities of XAlpha agents, including Macro Brain, Micro Brain, Cross Brain, and utility agents.
- **Factor-design rules** specify common requirements for executable alpha factors, including interpretability, numerical stability, and output formatting.
- **Library and implementation constraints** describe the pre-imported libraries, allowed coding patterns, and assignment rules used by code-generation prompts.
- **Repair guardrails** constrain runtime repair prompts so fixes remain local, executable, and aligned with the original factor intent.
- **Shared examples** provide canonical response structures for factor functions and structured JSON outputs.

## Usage

- Constitution and agent-role files are used as system prompts for Macro Brain, Micro Brain, Cross Brain, and utility tasks.
- `shared_requirements_prompt.md`, `complexity_constraints_prompt_template.md`, library blocks, and output-format blocks are inserted into Micro Brain generation, evolution, repair, and revision prompts.
- AST repair blocks are inserted only when a runtime or static-analysis repair task needs specific forbidden-operation feedback.
- Factor output examples and function output examples define the expected response shape for generated factor code or structured JSON.
- Shared style and factor-design guidance blocks are reusable components for keeping generated code concise, interpretable, and executable.

System-role files are paired with user templates by task. For example, `normal_factor_agent.md` and `novelty_factor_agent.md` are used for factor generation, `mutation_agent.md`/`crossover_agent.md`/`refinement_agent.md` are used for evolution prompts, and `factor_classification_agent.md` is used for B/C-layer attribution.

## Templates

| Prompt Constant | Template |
| --- | --- |
| `ALIGNMENT_REVIEW_AGENT` | `alignment_review_agent.md` |
| `ALIGNMENT_REVISION_AGENT` | `alignment_revision_agent.md` |
| `BAD_FACTOR_SUMMARY_AGENT` | `bad_factor_summary_agent.md` |
| `BROAD_HYPOTHESIS_AGENT` | `broad_hypothesis_agent.md` |
| `CODE_REPAIR_AGENT` | `code_repair_agent.md` |
| `COLUMN_DESCRIPTION_AGENT` | `column_description_agent.md` |
| `COMPLEXITY_CONSTRAINTS_PROMPT_TEMPLATE` | `complexity_constraints_prompt_template.md` |
| `CROSSOVER_AGENT` | `crossover_agent.md` |
| `CROSS_BRAIN_CONSTITUTION` | `cross_brain_constitution.md` |
| `C_LAYER_RESEARCH_PATH_AGENT_SYSTEM_PROMPT` | `c_layer_research_path_agent_system_prompt.md` |
| `EVOLUTION_PLANNER_AGENT` | `evolution_planner_agent.md` |
| `EVOLUTION_PRINCIPLE_PROMPT` | `evolution_principle_prompt.md` |
| `FACTOR_CLASSIFICATION_AGENT` | `factor_classification_agent.md` |
| `GLOBAL_FEEDBACK_SUMMARY_AGENT` | `global_feedback_summary_agent.md` |
| `GLOBAL_SELECTOR_AGENT` | `global_selector_agent.md` |
| `GOOD_FACTOR_SUMMARY_AGENT` | `good_factor_summary_agent.md` |
| `HYPOTHESIS_MEMORY_SELECTOR_AGENT` | `hypothesis_memory_selector_agent.md` |
| `HYPOTHESIS_SUBSET_PLANNER_AGENT` | `hypothesis_subset_planner_agent.md` |
| `INSTRUCTION_HIERARCHY` | `instruction_hierarchy.md` |
| `MACRO_BRAIN_CONSTITUTION` | `macro_brain_constitution.md` |
| `MICRO_BRAIN_CONSTITUTION` | `micro_brain_constitution.md` |
| `MUTATION_AGENT` | `mutation_agent.md` |
| `NORMAL_FACTOR_AGENT` | `normal_factor_agent.md` |
| `NOVELTY_FACTOR_AGENT` | `novelty_factor_agent.md` |
| `REFINEMENT_AGENT` | `refinement_agent.md` |
| `REPAIR_ACTIVE_CONTROL_FLOW_PROMPT_TEMPLATE` | `repair_active_control_flow_prompt_template.md` |
| `REPAIR_ACTIVE_DANGEROUS_CALLS_PROMPT_TEMPLATE` | `repair_active_dangerous_calls_prompt_template.md` |
| `REPAIR_ACTIVE_FORBIDDEN_INTRO_PROMPT` | `repair_active_forbidden_intro_prompt.md` |
| `REPAIR_ACTIVE_HELPERS_PROMPT_TEMPLATE` | `repair_active_helpers_prompt_template.md` |
| `REPAIR_ACTIVE_TRANSFORMS_PROMPT_TEMPLATE` | `repair_active_transforms_prompt_template.md` |
| `REPAIR_GUARDRAILS_FOOTER_PROMPT` | `repair_guardrails_footer_prompt.md` |
| `REPAIR_GUARDRAILS_HEADER_PROMPT` | `repair_guardrails_header_prompt.md` |
| `SHARED_CODE_EXPLANATION_STYLE_PROMPT` | `shared_code_explanation_style_prompt.md` |
| `SHARED_FACTOR_DESIGN_GUIDANCE_PROMPT` | `shared_factor_design_guidance_prompt.md` |
| `SHARED_FACTOR_OUTPUT_EXAMPLE_JSON_PROMPT` | `shared_factor_output_example_json_prompt.md` |
| `SHARED_FUNCTION_OUTPUT_EXAMPLE_PROMPT` | `shared_function_output_example_prompt.md` |
| `SHARED_LIBRARIES_FOOTER_PROMPT` | `shared_libraries_footer_prompt.md` |
| `SHARED_LIBRARIES_HEADER_PROMPT` | `shared_libraries_header_prompt.md` |
| `SHARED_LIBRARIES_LOC_ASSIGNMENT_PROMPT` | `shared_libraries_loc_assignment_prompt.md` |
| `SHARED_OUTPUT_FORMAT_PROMPT_TEMPLATE` | `shared_output_format_prompt_template.md` |
| `SHARED_OUTPUT_REPAIR_RULES_PROMPT` | `shared_output_repair_rules_prompt.md` |
| `SHARED_REQUIREMENTS_PROMPT` | `shared_requirements_prompt.md` |
| `SPECIFIC_HYPOTHESIS_AGENT` | `specific_hypothesis_agent.md` |
| `UTILITY_CONSTITUTION` | `utility_constitution.md` |
| `XALPHA_CONSTITUTION` | `xalpha_constitution.md` |
