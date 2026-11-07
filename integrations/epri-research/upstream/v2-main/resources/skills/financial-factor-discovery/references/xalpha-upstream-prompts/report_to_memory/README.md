# Report-to-Memory Absorption Prompts

Report-to-Memory absorption turns unstructured financial research text into structured mechanism memory. This stage prepares report-derived evidence before it is used by the Macro Brain and downstream factor-generation prompts.

## Components

- **Research text cleaning** removes formatting noise while preserving economically meaningful content.
- **Chunk filtering** decides whether a report fragment contains usable alpha-mining evidence.
- **B-layer mining** extracts concrete mechanism-level insights from relevant report chunks.
- **C-layer routing** assigns mined mechanism clusters to broader research archetypes.

## Usage

Run these prompts before factor generation to convert report text into structured mechanism memory:

1. `research_md_clean_instruction.md`: use as the cleaning instruction for raw report pages and output cleaned Markdown only.
2. `chunk_filter_system_template.md`: fill Layer-A taxonomy fields and evaluate one cleaned report chunk as KEEP or DROP.
3. `report_b_layer_mining_template.md`: for chunks that pass filtering, fill the Layer-A data scope, B-layer catalog, and chunk text to mine daily-OHLCV research paths.
4. `route_cluster_to_c_layer_template.md`: fill the allowed C-layer catalog, available c_id options, and one research-path atom to assign it to a C-layer agent.

The accepted and routed research paths become memory records used later by Macro Brain planning and active-agent construction.

## Templates

| Prompt Constant | Template |
| --- | --- |
| `CHUNK_FILTER_SYSTEM_TEMPLATE` | `chunk_filter_system_template.md` |
| `REPORT_B_LAYER_MINING_TEMPLATE` | `report_b_layer_mining_template.md` |
| `RESEARCH_MD_CLEAN_INSTRUCTION` | `research_md_clean_instruction.md` |
| `ROUTE_CLUSTER_TO_C_LAYER_TEMPLATE` | `route_cluster_to_c_layer_template.md` |
