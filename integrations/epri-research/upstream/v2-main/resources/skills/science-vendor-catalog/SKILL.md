---
name: deepscientist-science-vendor-catalog
description: Migration-only source index for vendored science skill packs. Use only when debugging provenance, checking upstream text, or materializing new router/leaf skills; normal Science Mode should use DeepScientist router skills instead.
---

# DeepScientist Science Vendor Catalog

This skill is not part of the normal default Science Mode route. It is a
migration/source index. Normal work should use the DeepScientist router skills
(`deepscientist-writing`, `deepscientist-databases`, `deepscientist-biomodels`,
`deepscientist-singlecell`, `deepscientist-compute`, and `deepscientist-empirical`)
plus `science_artifact`.

## Sources

Read `references/vendor-skill-sources.md` first when deciding whether an
external skill should be consulted.

Vendored repositories:

- DeepScientist v1.6.0:
  `resources/skills/vendor/deepscientist-1.6.0`
- K-Dense Scientific Agent Skills:
  `resources/skills/vendor/scientific-agent-skills`
- Auto-Empirical Research Skills:
  `resources/skills/vendor/auto-empirical-research-skills`
- PKU-YuanGroup OpenAI4S (curated snapshot):
  `resources/skills/vendor/openai4s`

JimLiu/science-skills is planned as an additional upstream source for
onboarding, writing, biomodel, single-cell, compute, and bio-tools/database
routes. Until it is vendored/materialized in this repository, treat its names
as design references rather than callable local skills.

## Routing Rule

Use progressive disclosure:

1. Identify the scientific domain or tool need.
2. Prefer the DeepScientist router skill first.
3. Read only the relevant vendored `SKILL.md` and directly referenced
   `references/` files.
4. Treat vendored skills as workflow knowledge, not as evidence.
5. Run real work through the normal runtime: shell, Python, R, LaTeX, notebook,
   SSH, or user-approved connectors.
6. Record selected external skills with
   `science_artifact(action="create", target={kind:"skill_use"})`.
7. Record files, code, logs, database records, figures, tables, claims, and
   provenance through `science_artifact`.
8. Publish the final Science panel with `science_artifact(action="publish")`.

## Priority

- DeepScientist `deepscientist-science` and `deepscientist-science-artifact` are the
  controlling contract.
- DeepScientist-derived `ds-*` skills are routed through `deepscientist-workflow`
  and `deepscientist-writing`.
- K-Dense `kdense-*` skills are routed through the database, biomodel,
  single-cell, compute, and writing routers.
- Auto-Empirical `aer-*` skills are routed through `deepscientist-empirical` and,
  for papers/slides/reviews, `deepscientist-writing`.
- OpenAI4S `openai4s-*` skills are optional leaf protocols. Dataset audit,
  experiment planning, and model evaluation support general Science work;
  AlphaFold2, Boltz, and scGPT route through `deepscientist-bio`. OpenAI4S
  figure guidance is consolidated into `deepscientist-scientific-visuals`
  rather than materialized as a second visual runtime.

## Protein / Molecule Routing

For structure visualization or structure-backed artifacts, prefer these local
skill routes:

- `database-lookup`: RCSB PDB, AlphaFold, UniProt, ChEMBL, PubChem, and related
  endpoint provenance.
- `biopython`: PDB/mmCIF parsing, chains/residues/atoms, DSSP, distance checks,
  missing residues, and structural sanity checks.
- `rdkit`, `datamol`, `deepchem`, `medchem`: ligand/conformer/small-molecule
  parsing, descriptors, fingerprints, standardization, and depictions.
- `diffdock`, `esm`: docking and protein-language-model workflows when the
  vendored reference matches the user's task and the required runtime is
  actually available.
- `molecular-dynamics`: OpenMM/MDAnalysis trajectory or snapshot analysis.

After reading the relevant vendored skill files, still submit outputs through
`science_artifact`: `database_record` evidence, coordinate-file artifact,
parser/validation evidence, and a `protein_structure` or `molecule` artifact
with `viewer` metadata.

## Clinical Boundary

Clinical diagnosis, treatment, patient-care recommendations, clinical reports,
and clinical decision-support tasks should route to Medical Evidence Mode when
possible. In ordinary Science Mode, clinical K-Dense skills may be read only as
technical references and must not produce medical advice without the medical
evidence contract.

## Safety

External skills may mention API keys, cloud services, laboratory platforms,
remote execution, or paid services. Do not call them unless the user has
authorized the host/service and the required credentials are available.

Never present a vendored skill's documentation as proof. A result is supported
only when it is connected to concrete evidence objects, files, command logs,
database records, papers, or user inputs in the Science artifact graph.
