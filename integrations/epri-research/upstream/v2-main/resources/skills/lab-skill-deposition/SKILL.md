---
name: deepscientist-lab-skill-deposition
description: DeepScientist knowledge deposition mode for turning approved conversations, artifacts, project files, and lab notes into reusable local research skills and SOPs.
---

# DeepScientist Lab Skill Deposition

Use this skill when the user enables knowledge deposition or asks to create a reusable laboratory skill. This mode turns observed work patterns into an installable, editable local skill, but only after the user confirms enablement.

## Boundary

- This is not default Science analysis mode.
- Do not publish, install, or enable a deposited skill until the user explicitly confirms.
- Do not use global memory, unrelated conversations, browser history, or other project histories unless the user selects them.
- If requested sources are unavailable, say so in the deposition report instead of pretending they were read.

## Required Source Workflow

- Use the `lab_skill` MCP as the single control surface.
- Start with `lab_skill(action="open_session")`.
- Read the returned source location guide directly when available.
- Register only sources you actually read: current conversation excerpts, generated artifacts, project files, code, logs, notebooks, and user instructions.
- Keep source ids stable: `U` for user instruction, `H` for conversation, `A` for artifact, `F` for file, and `C` for code/log/notebook.

## Draft Discipline

- Every SOP rule, reusable prompt instruction, protocol step, and validation claim should point to source ids when possible.
- A complete deposition report should normally include at least one non-user-instruction source.
- Keep sensitive excerpts short and privacy-aware.
- If sources conflict, preserve the conflict and block enablement until resolved.

## Report Before Enablement

Before installing or publishing a skill, submit a deposition report that includes:

- intended skill name and scope;
- selected sources and missing sources;
- reusable SOP draft;
- evidence ledger;
- risks, conflicts, and required user decisions.
