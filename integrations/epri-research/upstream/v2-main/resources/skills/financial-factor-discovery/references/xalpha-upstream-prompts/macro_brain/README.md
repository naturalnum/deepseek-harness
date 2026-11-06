# Macro Brain Prompts

The Macro Brain handles research-level planning. It connects memory, market mechanisms, and current feedback to decide which research directions should be explored next and how active agents should be framed.

## Components

- **Global routing** selects or prioritizes research archetypes based on accumulated memory and recent cycle feedback.
- **Feedback summarization** condenses cycle-level results into reusable guidance for subsequent routing decisions.
- **Active-agent authoring** materializes specialized agents by writing their role introduction and factor-design guidance from a selected mechanism.
- **Active-agent hypothesis prompting** turns a selected mechanism into concrete, testable factor hypotheses.
- **C-layer research path planning** describes how broad research archetypes should guide downstream hypothesis generation.
- **Hypothesis subset planning** chooses which memory-backed hypotheses should be injected into a prompt-time generation context.

## Usage

Use the matching system role from `../shared/` for each Macro Brain task. Each template is a standalone user prompt.

Recommended pairing:

- `global_agent_routing_prompt.md` + `../shared/global_selector_agent.md`: fill cycle state, candidate agent records, feedback summaries, routing mode, and replacement constraints.
- `global_agent_feedback_summary_prompt.md` + `../shared/global_feedback_summary_agent.md`: fill recent cycle factor/feedback payloads to produce compact memory fields.
- `active_agent_intro_prompt.md` and `active_agent_guidance_prompt.md`: fill `{AGENT_NAME}` and `{MECHANISM}` to materialize a specialized active agent.
- `active_agent_hypothesis_prompt_template.md` + `../shared/broad_hypothesis_agent.md` or `../shared/specific_hypothesis_agent.md`: fill agent name, mechanism, research paths, requested hypothesis count, and mode rules. This is a derived template used to form broad/specific hypothesis prompts.
- `c_layer_research_path_prompt.md` + `../shared/c_layer_research_path_agent_system_prompt.md`: fill cycle theme information, B-layer plans, and candidate C-layer agents.
- `hypothesis_subset_planner_prompt.md` + `../shared/hypothesis_subset_planner_agent.md`: fill the active-agent theme, available hypothesis pool, and requested subset count.

The outputs from active-agent intro/guidance and hypothesis planning are later consumed by Micro Brain generation prompts.

## Templates

| Prompt Constant | Template | Type |
| --- | --- | --- |
| `ACTIVE_AGENT_GUIDANCE_PROMPT` | `active_agent_guidance_prompt.md` | Standalone authoring block |
| `ACTIVE_AGENT_INTRO_PROMPT` | `active_agent_intro_prompt.md` | Standalone authoring block |
| `C_LAYER_RESEARCH_PATH_PROMPT` | `c_layer_research_path_prompt.md` | Standalone user prompt |
| `GLOBAL_AGENT_FEEDBACK_SUMMARY_PROMPT` | `global_agent_feedback_summary_prompt.md` | Standalone user prompt |
| `GLOBAL_AGENT_ROUTING_PROMPT` | `global_agent_routing_prompt.md` | Standalone user prompt |
| `HYPOTHESIS_SUBSET_PLANNER_PROMPT` | `hypothesis_subset_planner_prompt.md` | Standalone user prompt |
| `_ACTIVE_AGENT_HYPOTHESIS_PROMPT_TEMPLATE` | `active_agent_hypothesis_prompt_template.md` | Derived template |
