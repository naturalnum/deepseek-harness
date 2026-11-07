# Runtime Repair Prompt

Prompt constant: `RUNTIME_REPAIR_PROMPT`

Placeholders: `{COLUMNS_NUM}`, `{COLUMNS_DESC}`, `{REPAIR_FORBIDDEN_RULES}`, `{OLD_CODE}`, `{ERROR}`, `{REQUIREMENTS_BLOCK}`, `{LIBRARIES_BLOCK}`, `{OUTPUT_FORMAT_BLOCK}`

````text
Schema of the input DataFrame and {COLUMNS_NUM} existing factors:

{COLUMNS_DESC}

Use only these columns. Repair the failed function so it becomes structurally valid, executable, and numerically stable.

{REPAIR_FORBIDDEN_RULES}

---

### Failed submitted function
<<faulty code>>
{OLD_CODE}
<</faulty code>>

---

### Checker or runtime feedback:
{ERROR}

---

### Repair principle:

Preserve the original factor mechanism whenever possible. This is a repair task, not a mutation task.

Do not intentionally change:
- the core alpha hypothesis,
- the event definition,
- the signal direction,
- the interaction structure,
- the economic or behavioral interpretation,

unless the reported error directly requires such a change.

Prefer the smallest valid repair that resolves the reported issue.
Do not add ranking, normalization, clipping, scaling, smoothing, or other signal transformations unless strictly required.
Do not simplify, optimize, or redesign the factor unless the reported error requires it.

---

{REQUIREMENTS_BLOCK}

---

{LIBRARIES_BLOCK}

---

{OUTPUT_FORMAT_BLOCK}

---

**Note**: Use the feedback above as the direct repair target. If the problem is structural, resolve the AST/code-quality issues first; if it is runtime-related, resolve the execution failure without introducing new structural problems.
````
