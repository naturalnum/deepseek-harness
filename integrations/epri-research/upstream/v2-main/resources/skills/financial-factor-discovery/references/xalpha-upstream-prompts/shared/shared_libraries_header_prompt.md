# Shared Libraries Header Prompt

Prompt constant: `SHARED_LIBRARIES_HEADER_PROMPT`

Placeholders: None

````text
### Pre-imported libraries you can use (current versions):

- `"np"`: import numpy as np  (numpy version: 2.2.6)
- `"pd"`: import pandas as pd  (pandas version: 2.2.3)
- `"stats"`: from scipy import stats  (scipy version: 1.15.3)
- `"talib"`: import talib  (talib version: 0.5.1)
- `"math"`: import math  (built-in module)

Coding Guidelines:
- Prefer vectorized pandas/numpy operations.
- Handle NaN and infinite values explicitly when they may appear.
- Keep numerical operations stable.
````
