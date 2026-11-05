---
name: deepscientist-empirical
description: Router for empirical social science, econometrics, causal inference, surveys, qualitative coding, geospatial policy analysis, replication packages, and statistical reports in Science Mode.
---

# DeepScientist Empirical Router

Use this skill for applied economics, social science, policy analysis,
econometrics, causal inference, survey research, qualitative coding,
geospatial social analysis, and replication packages.

## Merge Map

- Entry router: `aer-auto-empirical-research-skills`.
- Full empirical pipelines: `aer-full-empirical-analysis-skill`,
  `aer-full-empirical-analysis-skill-r`,
  `aer-full-empirical-analysis-skill-stata`, `aer-statspai-skill`.
- Causal/econometrics: `aer-causal-inference-mixtape`,
  `aer-causal-inference-r`, `aer-did-analysis`, `aer-iv-estimation`,
  `aer-rdd-analysis`, `aer-panel-data`, `aer-ols-regression`,
  `aer-40-py-econometrics-pyfixest`, `kdense-statsmodels`,
  `kdense-shap`, `kdense-statistical-analysis`.
- Data/reproducibility: `aer-data-clean*`, `aer-data-validate`,
  `aer-codebook-pass`, `aer-audit-replication`, `aer-stata-*`.
- Writing/review: `aer-aer-paper-body`, `aer-aer-literature`,
  `aer-paper-polish`, `aer-referee-report`, `aer-respond-to-referee`.
- Qualitative/survey/geospatial: `aer-thematic-analysis`,
  `aer-slr-prisma`, `kdense-geopandas`.

## SOP

1. Register design evidence before result claims: sample, variables/codebook,
   identification strategy, model formula, assumptions, and limitations.
2. Run real code in Python, R, Stata, Julia, or project scripts.
3. Register estimation command, log, package versions, model table,
   diagnostics, robustness checks, and produced figures/tables.
4. Use artifact types such as `regression_table`, `model_diagnostic`,
   `causal_dag`, `survey_codebook`, `geospatial_map`,
   `qualitative_coding`, or `replication_package`.
5. Snapshot data dictionaries, scripts, logs, derived tables, figures, and
   replication manifests.

## Boundaries

Do not present causal claims without identification evidence and explicit
limitations. Sensitive human-subject or private data requires user-approved
paths and careful redaction.
