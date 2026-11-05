# Crossover Prompt

Prompt constant: `CROSSOVER_PROMPT`

Placeholders: `{INTRO}`, `{COMPLEXITY_CONSTRAINTS}`, `{EVOLUTION_PRINCIPLE_BLOCK}`, `{PARENT_FACTOR_DEFINITION_BLOCK}`, `{PARENT_FACTOR_1_CODE}`, `{PARENT_FACTOR_2_CODE}`, `{REQUIREMENTS_BLOCK}`, `{LIBRARIES_BLOCK}`, `{OUTPUT_FORMAT_BLOCK}`

````text
{INTRO}

{COMPLEXITY_CONSTRAINTS}

{EVOLUTION_PRINCIPLE_BLOCK}

### Crossover task:

Create one mechanism-level crossover from the two parent factors.
Reason from both parent hypotheses first, then express the recomposed mechanism as code.
Do not blend parent outputs or add cosmetic wrappers as a substitute for mechanism recomposition.

---

### Parent Factor Definitions For This Crossover
{PARENT_FACTOR_DEFINITION_BLOCK}

---

### Parent Factor 1:

<<parent factor 1>>
{PARENT_FACTOR_1_CODE}
<</parent factor 1>>

---

### Parent Factor 2:

<<parent factor 2>>
{PARENT_FACTOR_2_CODE}
<</parent factor 2>>

---

### Design objectives:

- Create a new alpha factor by recomposing the underlying mechanisms represented by both parent factors.
- The goal is not to blend parent outputs, but to create a new mechanism that plausibly explains why both parent mechanisms may generate alpha.
- Preserve one indispensable mechanism from each parent.
- Seek meaningful interactions between the economic, behavioral, or market microstructure mechanisms captured by the parents.
- A strong crossover should create a new causal narrative, not merely a new mathematical combination.
- Avoid simple additive, averaging, or weighted combinations of the two parent signals.
- Avoid pseudo-crossover patterns such as taking Parent 1 and only adding a light rank, EMA, smoothing, scaling, or normalization layer, or doing the same with Parent 2.
- Do not collapse into a one-sided rewrite of one parent with a cosmetic wrapper.

A valid crossover should answer:
- What core mechanism is inherited from Parent 1?
- What core mechanism is inherited from Parent 2?
- What new mechanism emerges from their interaction?

---

{REQUIREMENTS_BLOCK}

---

{LIBRARIES_BLOCK}

---

{OUTPUT_FORMAT_BLOCK}
````
