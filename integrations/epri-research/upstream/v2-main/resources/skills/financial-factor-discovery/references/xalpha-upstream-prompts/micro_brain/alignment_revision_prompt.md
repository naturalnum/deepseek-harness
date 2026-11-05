# Alignment Revision Prompt

Prompt constant: `ALIGNMENT_REVISION_PROMPT`

Placeholders: `{COLUMNS_NUM}`, `{COLUMNS_DESC}`, `{OLD_CODE}`, `{HYPOTHESES_BLOCK}`, `{ALIGNMENT_FEEDBACK}`, `{COMPLEXITY_CONSTRAINTS}`, `{REQUIREMENTS_BLOCK}`, `{LIBRARIES_BLOCK}`, `{OUTPUT_FORMAT_BLOCK}`

````text
Repair a submitted factor payload so its explanatory text, metadata, and executable code are mutually aligned and financially sound.

Schema of the input DataFrame and {COLUMNS_NUM} existing factors:

{COLUMNS_DESC}

Use only these columns for calculations.

Repair objectives:
1. The executable code must express a financially meaningful, causal, daily-OHLCV alpha mechanism.
2. `hypothesis_idea` must describe the final implemented mechanism.
3. `logic` must explain how the final code realizes the idea.
4. `sub_mechanism_tags`, docstring, inline comments, logic, and code must be mutually consistent.
5. The factor must remain concise, executable, and faithful to available OHLCV inputs.
6. Do not introduce a new alpha mechanism unless required to fix financially unsound executable code.

---

### Submitted factor function
<<submitted function>>
{OLD_CODE}
<</submitted function>>

---

### Submitted factor metadata
<<factor metadata>>
{HYPOTHESES_BLOCK}
<</factor metadata>>

---

### Alignment review feedback
{ALIGNMENT_FEEDBACK}

Use this feedback as the concrete repair target.
If `stripped_code_financial_soundness` is Accept and only explanatory text is misaligned, keep the executable code unchanged and repair only metadata, docstring, comments, or tags.
If `stripped_code_financial_soundness` is Reject, repair the implementation and then update all explanatory fields to match the repaired code.

---

{COMPLEXITY_CONSTRAINTS}

---

{REQUIREMENTS_BLOCK}

---

{LIBRARIES_BLOCK}

---

{OUTPUT_FORMAT_BLOCK}

---

Return exactly one repaired factor payload.
Do not output explanations outside the required JSON.
````
