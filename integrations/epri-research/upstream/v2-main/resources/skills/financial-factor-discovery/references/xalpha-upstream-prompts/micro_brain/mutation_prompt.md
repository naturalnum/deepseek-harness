# Mutation Prompt

Prompt constant: `MUTATION_PROMPT`

Placeholders: `{INTRO}`, `{COMPLEXITY_CONSTRAINTS}`, `{EVOLUTION_PRINCIPLE_BLOCK}`, `{PARENT_FACTOR_DEFINITION_BLOCK}`, `{ORIGINAL_FACTOR_CODE}`, `{REQUIREMENTS_BLOCK}`, `{LIBRARIES_BLOCK}`, `{OUTPUT_FORMAT_BLOCK}`

````text
{INTRO}

{COMPLEXITY_CONSTRAINTS}

{EVOLUTION_PRINCIPLE_BLOCK}

### Mutation task:

Create a mechanism-level mutation of the parent factor.
Reason from the parent hypothesis first, then express the changed mechanism as code.

---

### Parent Factor Definition For This Mutation
{PARENT_FACTOR_DEFINITION_BLOCK}

---

### Original Factor:

<<original factor>>
{ORIGINAL_FACTOR_CODE}
<</original factor>>

---

### Design objectives:

- Preserve the core mechanism and signal intent of the original factor.
- Apply a meaningful mechanism-level mutation that may improve predictive power, robustness, or regime stability.
- Modify at least one mechanism axis in a material way: event definition, response regime, behavioral assumption, horizon proxy, triggering condition, or interaction structure.
- The mutated factor should be clearly distinct from the original while maintaining a direct conceptual connection.

### Possible mutation directions:

- Sharpen the event definition.
- Change the response regime.
- Alter the behavioral assumption.
- Reframe the horizon being captured.
- Strengthen or weaken the triggering condition.
- Introduce one complementary mechanism.
- Replace a noisy proxy with a more stable proxy.
- Make the signal more conditional on market state or stock-level regime.

Avoid mutations that only add:
- rank
- smoothing
- scaling
- clipping
- normalization
- cosmetic non-linear transformations
- redundant rolling windows

A valid mutation should answer:
- What mechanism is preserved?
- What mechanism axis is changed?
- Why should this change improve alpha quality?

---

{REQUIREMENTS_BLOCK}

---

{LIBRARIES_BLOCK}

---

{OUTPUT_FORMAT_BLOCK}
````
