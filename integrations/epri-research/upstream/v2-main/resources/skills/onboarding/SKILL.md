---
name: deepscientist-onboarding
description: First-time DeepScientist project onboarding. Use only when a Science project has no onboarding profile, no .deepscientist/project.json profile summary, or the user explicitly asks to update research preferences.
---

# DeepScientist Onboarding

Use this skill only for first setup or explicit profile updates. Do not run it
in every Science conversation.

## Trigger

Run onboarding when one of these is true:

- the project has no `.deepscientist/onboarding-profile.md`;
- `.deepscientist/project.json` exists but has no usable research profile;
- the user says their field, tools, output style, or project assumptions changed.

If a profile exists, read it and continue without re-asking unless it is stale
for the current task.

## Intake

Ask at most 3 concise questions with `user_input` when the answers are not
already available:

1. research domain and typical objects: papers, code, omics data, structures,
   molecules, simulations, social-science datasets, manuscripts, or reports;
2. expected deliverables: figures, tables, notebooks, PDFs, LaTeX manuscripts,
   native viewers, run bundles, or reproducibility packages;
3. local constraints: project root, private data, preferred language, package
   manager, compute limits, and external services the user authorizes.

## Output

Create or update `.deepscientist/onboarding-profile.md` with:

- project summary;
- preferred language;
- default deliverables;
- common data types and file locations;
- allowed tools/services and restricted paths;
- preferred router skills;
- evidence/provenance expectations.

Then register the profile as `user_input` evidence and snapshot it:

- evidence title: `DeepScientist onboarding profile`;
- sourceType: `user_input`;
- confidence: `high` if confirmed by the user, otherwise `moderate`;
- includePath role: `reference`.

## Boundaries

- Do not execute analysis, compile LaTeX, or run remote jobs during onboarding.
- Do not ask for secrets. Ask the user to configure credentials in Settings or
  existing project mechanisms.
- Do not override existing project rules unless the user explicitly confirms
  the update.
