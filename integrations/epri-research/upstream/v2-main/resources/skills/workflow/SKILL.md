---
name: deepscientist-workflow
description: Route Science Mode and DeepScientist Discovery Mode research-process work through independently managed DeepScientist workflow skills. Use when a research project needs stage selection, persistent goal iteration, project intake, scouting, idea generation, baseline verification, experiment planning/runs, follow-up analysis, paper writing, review, rebuttal, finalization, or publication-quality figure/manuscript production. Coordinates ds-* workflow skills while keeping evidence, artifacts, and provenance under DeepScientist science_artifact.
---

# DeepScientist Workflow

Use this skill as the research-process router for Science Mode and persistent
DeepScientist Discovery Mode. It manages the DeepScientist-derived workflow layer separately
from the core `deepscientist-science` evidence/artifact contract.

## Contract

- Use `deepscientist-science` for universal evidence, claim, artifact, viewer,
  and final report discipline.
- Use this skill to choose the right research stage skill.
- Use the selected `ds-*` skill for the actual stage SOP.
- Record this router and the selected `ds-*` skill as `skill_use` entries when
  they affect a visible result.
- Do not browse DeepScientist vendor folders directly. Use first-class
  materialized `ds-*` skills.

## Challenge Compatibility Profile

When the active mode or task contract identifies a sealed IOAI task, use
[references/ioai-competition-stage-profile.md](references/ioai-competition-stage-profile.md)
as the workflow profile. Keep the native stage chain and Science artifact
ledger; treat `ioai_competition` as the execution Adapter rather than a second
workflow or research frontier.

The default competition route is:

`ds-intake-audit -> ds-baseline -> ds-idea -> ds-optimize -> ds-experiment -> ds-decision`

Repeat `ds-optimize -> ds-experiment -> ds-decision` while measured evidence
justifies another attempt, then use `ds-finalize`. Skip paper-oriented stages
unless the user explicitly expands scope.

## Routing Groups

- Research workflow main chain:
  `ds-intake-audit`, `ds-scout`, `ds-baseline`, `ds-idea`,
  `ds-experiment`, `ds-analysis-campaign`, `ds-decision`, `ds-finalize`.
- Writing and paper production:
  `ds-paper-outline`, `ds-write`, `ds-review`, `ds-rebuttal`,
  `ds-nature-data`, `ds-nature-polishing`, `ds-nature-paper2ppt`.
- Figure and display production:
  `ds-paper-plot`, `ds-figure-polish`, `ds-nature-figure`.
- Support:
  `ds-science`, `ds-optimize`, `ds-alphaxiv-paper-lookup`.

## Workflow SOP

1. Classify the current project state: unclear, baseline-needed,
   idea-needed, ready-to-run, needs-follow-up, writing, review/rebuttal,
   figure-production, or closing.
2. Read `references/deepscientist-workflow-map.md` if the stage is not
   obvious, or if multiple `ds-*` skills could apply.
3. Select the narrowest next stage. Prefer one stage at a time.
4. Record `skill_use` for `deepscientist-workflow` and the selected `ds-*`
   skill before relying on the stage in user-facing results.
5. Follow the selected `ds-*` skill body and its own references.
6. Convert concrete stage outputs into DeepScientist evidence, artifacts,
   claims, provenance, pages, and graph warnings.
7. Route the next stage explicitly; do not leave the project in a vague
   "continue research" state.

## Minimal Git and Filesystem SOP

Use two layers:

- Project git/worktrees manage editable research code, manuscripts, configs,
  and branch experiments.
- `science_artifact(action="snapshot")` manages the append-only artifact git
  ledger under `.deepscientist/artifact-repo`.

Minimum viable implementation:

1. Use the root `README.md`, project Git, Science artifacts, and checkpoints as
   durable project state. Do not maintain a parallel project plan unless it is
   an explicit deliverable.
2. Keep possible future directions as virtual nodes in `research_roadmap`.
   Follow the science-artifact roadmap contract when several routes require a
   user choice; virtual nodes are not branches.
3. Create a branch or worktree only after its route was selected and its work
   benefits from isolation. Link the real implementation back to the stable
   route node id through Science artifact/checkpoint metadata.
4. After each meaningful stage output, call `science_artifact(action="snapshot")`
   with the produced files. Include `.deepscientist/workflow/` only when that
   directory already exists and contains relevant non-duplicated stage state.
5. Promote, abandon, or continue a branch only through a `ds-decision` or
   `ds-finalize` route, and record that decision as evidence/provenance.

Read `references/deepscientist-workflow-map.md` for the stage map and
`references/git-worktree-minimum.md` for branch/worktree rules.

## Boundaries

- This skill does not run code, search databases, render molecules, or compile
  LaTeX by itself. It chooses the research-process skill.
- K-Dense and AERS remain domain/method skill packs. Use them alongside this
  workflow layer when the stage needs database, package, empirical, or
  methodology guidance.
- `ds-paper-plot` includes upstream scripts and is quarantined by default; use
  it as a style/template router unless execution is explicitly authorized.
