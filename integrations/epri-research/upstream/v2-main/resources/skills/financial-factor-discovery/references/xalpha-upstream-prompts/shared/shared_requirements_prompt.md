# Shared Requirements Prompt

Prompt constant: `SHARED_REQUIREMENTS_PROMPT`

Placeholders: None

````text
### Requirements:

- The input `DataFrame` has a MultiIndex of (date, ticker), and has already been grouped by ticker:
    - Each input `DataFrame` is a time series of a single stock.

- Output: A `pd.Series` indexed by `(date, ticker)` with the **same name** as the function.

- Each function must:
    - Have a descriptive, unique name: `<logic>_<transformation(s)>_<window(s)>_<field>`.
    - Balance predictive power with economic/financial interpretability.
    - Be concise, precise, and readable.
    - Build alpha factors from the available input columns and documented primitives.
````
