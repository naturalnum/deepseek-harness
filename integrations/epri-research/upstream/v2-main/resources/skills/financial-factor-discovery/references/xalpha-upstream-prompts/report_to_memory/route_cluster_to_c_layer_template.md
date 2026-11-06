# Route Cluster To C Layer Template

Prompt constant: `ROUTE_CLUSTER_TO_C_LAYER_TEMPLATE`

Placeholders: `{c_layer_catalog}`, `{c_id_options}`, `{cluster_evidence}`

````text
Route ONE research-path atom to exactly one Layer-C agent from the allowed catalog.

Allowed Layer C catalog:
{c_layer_catalog}

Available c_id options:
{c_id_options}

Research-path atom:
{cluster_evidence}

Rules:
- Choose exactly one c_id from the provided Layer-C catalog.
- You must choose one of the provided c_id values.

Return ONLY valid JSON:
{{
  "c_id": "<one c_id from Available c_id options>"
}}
````
