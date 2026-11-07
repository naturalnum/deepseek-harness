# Shared Function Output Example Prompt

Prompt constant: `SHARED_FUNCTION_OUTPUT_EXAMPLE_PROMPT`

Placeholders: None

````text
<<function>>
def <factor_name>(df):
    """Idea: <implemented factor idea>.
    Logic: <how the implementation realizes the idea>.
    Sub-mechanism tags: tag1; tag2; tag3.
    Formula: <short high-level factor expression>.
    """

    df_copy = df.copy()

    # Optional comments describing major computation steps
    <intermediate local computations>

    factor = <final factor series>
    factor.name = '<factor_name>'
    df_copy['<factor_name>'] = factor
    return df_copy['<factor_name>']
<</function>>
````
