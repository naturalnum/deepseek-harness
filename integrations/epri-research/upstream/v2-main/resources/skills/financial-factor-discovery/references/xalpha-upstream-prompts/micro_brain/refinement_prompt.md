# Refinement Prompt

Prompt constant: `REFINEMENT_PROMPT`

Placeholders: `{INTRO}`, `{COMPLEXITY_CONSTRAINTS}`, `{EVOLUTION_PRINCIPLE_BLOCK}`, `{PARENT_FACTOR_DEFINITION_BLOCK}`, `{ORIGINAL_FACTOR_CODE}`, `{REQUIREMENTS_BLOCK}`, `{LIBRARIES_BLOCK}`, `{OUTPUT_FORMAT_BLOCK}`

````text
{INTRO}

{COMPLEXITY_CONSTRAINTS}

{EVOLUTION_PRINCIPLE_BLOCK}

### Refinement task:

Create a mechanism-preserving refinement of the parent factor.
Reason from the parent hypothesis first, then express the cleaner mechanism as code.
Do not use extra ranking, smoothing, clipping, scaling, or normalization as generic cleanup.

---

### Parent Factor Definition For This Refinement
{PARENT_FACTOR_DEFINITION_BLOCK}

---

### Parent Factor To Refine:

<<parent factor>>
{ORIGINAL_FACTOR_CODE}
<</parent factor>>

---

### Refinement objectives:

- Preserve the core mechanism and signal intent of the parent factor.
- Simplify only the components that are not essential to the parent mechanism.
- Do not simplify mechanically.
- Simplification should improve clarity of mechanism, robustness, and interpretability, not merely reduce code length.
- If multiple components express the same mechanism, keep the simplest representation.
- If a component does not materially contribute to the mechanism narrative, remove it.
- Remove only components that do not appear essential to the parent mechanism.
- The number of removed components should depend on the actual redundancy of the parent factor.
- Prefer stable, interpretable, and parsimonious constructions when predictive quality can be preserved or improved.
- Keep a direct conceptual connection to the parent; this is not a free-form mutation task.
- If the parent is already simple, only make minimal targeted improvements or keep the structure essentially unchanged.

A valid refinement should answer:
- What mechanism is preserved?
- Which components are removed or simplified?
- Why are those components non-essential or redundant?

---

{REQUIREMENTS_BLOCK}

---

{LIBRARIES_BLOCK}

---

{OUTPUT_FORMAT_BLOCK}
````
