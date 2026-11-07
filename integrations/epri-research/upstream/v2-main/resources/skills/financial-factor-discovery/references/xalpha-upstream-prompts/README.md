# Prompt Families

This directory organizes the public prompt templates used by XAlpha into the same functional families described in the paper.

## Components

- [Shared Prompt Blocks](shared/README.md): cross-cutting constitutions, system roles, output formats, library constraints, and repair guardrails reused across brains.
- [Macro Brain Prompts](macro_brain/README.md): prompts for research routing, active-agent construction, C-layer research paths, and hypothesis subset planning.
- [Micro Brain Prompts](micro_brain/README.md): prompts for hypothesis-to-code factor generation, alignment review, repair, and evolutionary search.
- [Cross Brain Prompts](cross_brain/README.md): prompts for factor-to-mechanism attribution and GOOD/BAD feedback abstraction.
- [Report-to-Memory Absorption Prompts](report_to_memory/README.md): prompts for cleaning, filtering, mining, and routing report-derived evidence into memory.

## How to Assemble Prompts

Start with a system prompt from [shared/](shared/README.md), then fill one task template. The common flows are:

- **Report-to-Memory**: clean report pages -> filter chunks -> mine B-layer paths -> route to C-layer agents.
- **Macro Brain**: summarize feedback, route research themes, author active-agent intro/guidance, and plan hypothesis subsets.
- **Micro Brain generation**: join active-agent intro, optional feedback, active-agent guidance, shared requirements, complexity constraints, generation task, libraries, and output format.
- **Micro Brain evolution/repair**: fill mutation, crossover, refinement, alignment, or repair templates with factor code and shared blocks.
- **Cross Brain**: classify factors into B/C layers and summarize GOOD/BAD feedback for later memory use.

Do not include local code paths or repository-specific metadata in assembled prompts.

## Templates

| Family | Prompt Constant | Template |
| --- | --- | --- |
| Cross Brain Prompts | `BAD_FEEDBACK_SUMMARY_PROMPT` | `cross_brain/bad_feedback_summary_prompt.md` |
| Cross Brain Prompts | `FACTOR_TO_B_LAYER_PROMPT` | `cross_brain/factor_to_b_layer_prompt.md` |
| Cross Brain Prompts | `FACTOR_TO_C_LAYER_PROMPT` | `cross_brain/factor_to_c_layer_prompt.md` |
| Cross Brain Prompts | `GOOD_FEEDBACK_SUMMARY_PROMPT` | `cross_brain/good_feedback_summary_prompt.md` |
| Cross Brain Prompts | `_FACTOR_RECORD_FORMAT` | `cross_brain/factor_record_format.md` |
| Cross Brain Prompts | `_SHARED_RULES` | `cross_brain/shared_rules.md` |
| Macro Brain Prompts | `ACTIVE_AGENT_GUIDANCE_PROMPT` | `macro_brain/active_agent_guidance_prompt.md` |
| Macro Brain Prompts | `ACTIVE_AGENT_INTRO_PROMPT` | `macro_brain/active_agent_intro_prompt.md` |
| Macro Brain Prompts | `C_LAYER_RESEARCH_PATH_PROMPT` | `macro_brain/c_layer_research_path_prompt.md` |
| Macro Brain Prompts | `GLOBAL_AGENT_FEEDBACK_SUMMARY_PROMPT` | `macro_brain/global_agent_feedback_summary_prompt.md` |
| Macro Brain Prompts | `GLOBAL_AGENT_ROUTING_PROMPT` | `macro_brain/global_agent_routing_prompt.md` |
| Macro Brain Prompts | `HYPOTHESIS_SUBSET_PLANNER_PROMPT` | `macro_brain/hypothesis_subset_planner_prompt.md` |
| Macro Brain Prompts | `_ACTIVE_AGENT_HYPOTHESIS_PROMPT_TEMPLATE` | `macro_brain/active_agent_hypothesis_prompt_template.md` |
| Micro Brain Prompts | `ALIGNMENT_REVIEW_PROMPT` | `micro_brain/alignment_review_prompt.md` |
| Micro Brain Prompts | `ALIGNMENT_REVISION_PROMPT` | `micro_brain/alignment_revision_prompt.md` |
| Micro Brain Prompts | `CROSSOVER_PROMPT` | `micro_brain/crossover_prompt.md` |
| Micro Brain Prompts | `EVOLUTION_PLANNER_PROMPT` | `micro_brain/evolution_planner_prompt.md` |
| Micro Brain Prompts | `MUTATION_PROMPT` | `micro_brain/mutation_prompt.md` |
| Micro Brain Prompts | `REFINEMENT_PROMPT` | `micro_brain/refinement_prompt.md` |
| Micro Brain Prompts | `RUNTIME_REPAIR_PROMPT` | `micro_brain/runtime_repair_prompt.md` |
| Report-to-Memory Absorption Prompts | `CHUNK_FILTER_SYSTEM_TEMPLATE` | `report_to_memory/chunk_filter_system_template.md` |
| Report-to-Memory Absorption Prompts | `REPORT_B_LAYER_MINING_TEMPLATE` | `report_to_memory/report_b_layer_mining_template.md` |
| Report-to-Memory Absorption Prompts | `RESEARCH_MD_CLEAN_INSTRUCTION` | `report_to_memory/research_md_clean_instruction.md` |
| Report-to-Memory Absorption Prompts | `ROUTE_CLUSTER_TO_C_LAYER_TEMPLATE` | `report_to_memory/route_cluster_to_c_layer_template.md` |
| Shared Prompt Blocks | `ALIGNMENT_REVIEW_AGENT` | `shared/alignment_review_agent.md` |
| Shared Prompt Blocks | `ALIGNMENT_REVISION_AGENT` | `shared/alignment_revision_agent.md` |
| Shared Prompt Blocks | `BAD_FACTOR_SUMMARY_AGENT` | `shared/bad_factor_summary_agent.md` |
| Shared Prompt Blocks | `BROAD_HYPOTHESIS_AGENT` | `shared/broad_hypothesis_agent.md` |
| Shared Prompt Blocks | `CODE_REPAIR_AGENT` | `shared/code_repair_agent.md` |
| Shared Prompt Blocks | `COLUMN_DESCRIPTION_AGENT` | `shared/column_description_agent.md` |
| Shared Prompt Blocks | `COMPLEXITY_CONSTRAINTS_PROMPT_TEMPLATE` | `shared/complexity_constraints_prompt_template.md` |
| Shared Prompt Blocks | `CROSSOVER_AGENT` | `shared/crossover_agent.md` |
| Shared Prompt Blocks | `CROSS_BRAIN_CONSTITUTION` | `shared/cross_brain_constitution.md` |
| Shared Prompt Blocks | `C_LAYER_RESEARCH_PATH_AGENT_SYSTEM_PROMPT` | `shared/c_layer_research_path_agent_system_prompt.md` |
| Shared Prompt Blocks | `EVOLUTION_PLANNER_AGENT` | `shared/evolution_planner_agent.md` |
| Shared Prompt Blocks | `EVOLUTION_PRINCIPLE_PROMPT` | `shared/evolution_principle_prompt.md` |
| Shared Prompt Blocks | `FACTOR_CLASSIFICATION_AGENT` | `shared/factor_classification_agent.md` |
| Shared Prompt Blocks | `GLOBAL_FEEDBACK_SUMMARY_AGENT` | `shared/global_feedback_summary_agent.md` |
| Shared Prompt Blocks | `GLOBAL_SELECTOR_AGENT` | `shared/global_selector_agent.md` |
| Shared Prompt Blocks | `GOOD_FACTOR_SUMMARY_AGENT` | `shared/good_factor_summary_agent.md` |
| Shared Prompt Blocks | `HYPOTHESIS_MEMORY_SELECTOR_AGENT` | `shared/hypothesis_memory_selector_agent.md` |
| Shared Prompt Blocks | `HYPOTHESIS_SUBSET_PLANNER_AGENT` | `shared/hypothesis_subset_planner_agent.md` |
| Shared Prompt Blocks | `INSTRUCTION_HIERARCHY` | `shared/instruction_hierarchy.md` |
| Shared Prompt Blocks | `MACRO_BRAIN_CONSTITUTION` | `shared/macro_brain_constitution.md` |
| Shared Prompt Blocks | `MICRO_BRAIN_CONSTITUTION` | `shared/micro_brain_constitution.md` |
| Shared Prompt Blocks | `MUTATION_AGENT` | `shared/mutation_agent.md` |
| Shared Prompt Blocks | `NORMAL_FACTOR_AGENT` | `shared/normal_factor_agent.md` |
| Shared Prompt Blocks | `NOVELTY_FACTOR_AGENT` | `shared/novelty_factor_agent.md` |
| Shared Prompt Blocks | `REFINEMENT_AGENT` | `shared/refinement_agent.md` |
| Shared Prompt Blocks | `REPAIR_ACTIVE_CONTROL_FLOW_PROMPT_TEMPLATE` | `shared/repair_active_control_flow_prompt_template.md` |
| Shared Prompt Blocks | `REPAIR_ACTIVE_DANGEROUS_CALLS_PROMPT_TEMPLATE` | `shared/repair_active_dangerous_calls_prompt_template.md` |
| Shared Prompt Blocks | `REPAIR_ACTIVE_FORBIDDEN_INTRO_PROMPT` | `shared/repair_active_forbidden_intro_prompt.md` |
| Shared Prompt Blocks | `REPAIR_ACTIVE_HELPERS_PROMPT_TEMPLATE` | `shared/repair_active_helpers_prompt_template.md` |
| Shared Prompt Blocks | `REPAIR_ACTIVE_TRANSFORMS_PROMPT_TEMPLATE` | `shared/repair_active_transforms_prompt_template.md` |
| Shared Prompt Blocks | `REPAIR_GUARDRAILS_FOOTER_PROMPT` | `shared/repair_guardrails_footer_prompt.md` |
| Shared Prompt Blocks | `REPAIR_GUARDRAILS_HEADER_PROMPT` | `shared/repair_guardrails_header_prompt.md` |
| Shared Prompt Blocks | `SHARED_CODE_EXPLANATION_STYLE_PROMPT` | `shared/shared_code_explanation_style_prompt.md` |
| Shared Prompt Blocks | `SHARED_FACTOR_DESIGN_GUIDANCE_PROMPT` | `shared/shared_factor_design_guidance_prompt.md` |
| Shared Prompt Blocks | `SHARED_FACTOR_OUTPUT_EXAMPLE_JSON_PROMPT` | `shared/shared_factor_output_example_json_prompt.md` |
| Shared Prompt Blocks | `SHARED_FUNCTION_OUTPUT_EXAMPLE_PROMPT` | `shared/shared_function_output_example_prompt.md` |
| Shared Prompt Blocks | `SHARED_LIBRARIES_FOOTER_PROMPT` | `shared/shared_libraries_footer_prompt.md` |
| Shared Prompt Blocks | `SHARED_LIBRARIES_HEADER_PROMPT` | `shared/shared_libraries_header_prompt.md` |
| Shared Prompt Blocks | `SHARED_LIBRARIES_LOC_ASSIGNMENT_PROMPT` | `shared/shared_libraries_loc_assignment_prompt.md` |
| Shared Prompt Blocks | `SHARED_OUTPUT_FORMAT_PROMPT_TEMPLATE` | `shared/shared_output_format_prompt_template.md` |
| Shared Prompt Blocks | `SHARED_OUTPUT_REPAIR_RULES_PROMPT` | `shared/shared_output_repair_rules_prompt.md` |
| Shared Prompt Blocks | `SHARED_REQUIREMENTS_PROMPT` | `shared/shared_requirements_prompt.md` |
| Shared Prompt Blocks | `SPECIFIC_HYPOTHESIS_AGENT` | `shared/specific_hypothesis_agent.md` |
| Shared Prompt Blocks | `UTILITY_CONSTITUTION` | `shared/utility_constitution.md` |
| Shared Prompt Blocks | `XALPHA_CONSTITUTION` | `shared/xalpha_constitution.md` |
