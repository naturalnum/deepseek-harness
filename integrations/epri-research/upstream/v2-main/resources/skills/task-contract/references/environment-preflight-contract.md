# Environment preflight contract

Run one Coordinator-owned environment preflight after official data is present
and before any candidate-preparation Subagent is dispatched. The preflight is evidence, not
an installer: dependency repair remains a serial Lead action.

## Input

Create one project-relative JSON file such as `competition/preflight.json`:

```json
{
  "preflight_version": 1,
  "data_root": "data",
  "required_imports": [
    { "module": "torch", "distribution": "torch", "required": true },
    {
      "module": "transformers",
      "distribution": "transformers",
      "symbols": ["ASTFeatureExtractor", "ASTForAudioClassification"],
      "required": true
    }
  ],
  "required_globs": [
    { "pattern": "*.csv", "minimum_count": 1, "required": true },
    { "pattern": "model/*.json", "minimum_count": 1, "required": true }
  ],
  "probe_timeout_seconds": 20
}
```

`data_root` must be an existing non-root project subdirectory. `data_root: "."` is invalid because it would inventory the entire workspace; absolute paths and parent traversal are also invalid.

Derive imports from official starter code, the permitted checkpoint class, and
the candidate runtime. List public lazy exports such as model and preprocessor
classes in `symbols`; a successful package-root import alone is not evidence
that those exports load. Do not add unrelated packages. Glob patterns are
scoped inside `data_root`.

Call:

```text
ioai_competition(
  action="environment_preflight",
  project_root="<absolute-project-root>",
  preflight_path="competition/preflight.json"
)
```

## Result gate

Require all of the following:

- `status: "ready"`, no blockers, and disabled official submission;
- an absolute `python.executable` and an identical one-element
  `python.command_prefix`;
- every required import has `import_ok: true`; package version metadata is
  recorded when a distribution was declared;
- `data.csv_tables` records the actual CSV paths, columns, row counts, and
  non-empty counts; agents must use this inventory instead of guessing names
  such as `test.csv`;
- required globs pass, and the receipt ID, environment hash, receipt ref, and
  receipt hash are present.

The receipt identity is content-addressed by the Python runtime, import results,
and data inventory. An unchanged repeat is replayed; a dependency or CSV change
produces a new receipt. If blocked, do not dispatch Subagents. The Lead may make
one attributable environment repair, rerun this action, and continue only from
the new ready receipt.

Pass the exact command prefix, CSV inventory, preflight ID, environment hash,
receipt ref, and receipt hash to every candidate lane. Subagents must not repeat
environment discovery, invoke a bare interpreter alias, guess data filenames,
or install/upgrade packages independently.
