# AIMD Authoring Reference

DeepScientist uses the framework-neutral `@airalogy/aimd-core` parser. Keep source compatible with canonical Airalogy Markdown.

## Variables

Use stable ids and typed values. Put UI wording in metadata.

```aimd
{{var|sample_id: str, title="Sample ID", owner="human", description="Tube barcode recorded by the operator", examples=["S-001"]}}
{{var|temperature_c: float, title="Temperature", owner="human", unit="°C", ge=-80, le=40}}
{{var|passed_qc: bool, title="QC passed", owner="agent", description="Derived from the declared QC checks"}}
{{var|run_timestamp: str, title="Run timestamp", owner="system", readonly=True}}
{{var|treatment: Literal["control", "treated"], title="Treatment arm", owner="human"}}
```

Prefer `str`, `int`, `float`, `bool`, `date`, a named scientific type, or `Literal[...]`. A default is appropriate only when it is scientifically safe and does not pretend to be an observation.

Ownership is a UI and provenance contract:

- `owner="human"` is editable during a run and should be used sparingly.
- `owner="agent"` is displayed as Agent-generated and must retain the evidence or operation that produced it.
- `owner="system"` is read-only runtime metadata or a deterministic derived value.
- A client assigner that declares a field in `assigned_fields` also makes that field Agent-owned. If the assigner cannot produce a valid value, leave the field pending rather than falling back to manual entry without an explicit protocol change.

## Steps

```aimd
{{step|prepare_sample, level=1, title="Prepare the sample", check=True, duration="5m"}}
```

- `level` is 1 to 3.
- `check=True` means the operator explicitly completes the step.
- `duration` supports readable durations such as `30s`, `5m`, or `2h`.
- Use `result=True` only for a step whose main purpose is to produce or assess the declared output.
- Write `title` as a verb-led action the operator can recognize. Use `subtitle` only when an observable completion criterion is not already clear from the nearby fields, decision, output, or blocking check; never use it as a second description of the action.

Prefer:

```aimd
{{step|verify_sample_map, level=1, title="Confirm samples match their data files", check=True, duration="5m"}}
```

Avoid titles such as `Input registration`, `Processing`, or `Finalize`, which describe a system stage without telling the reader what to accomplish.

## Checkpoints

```aimd
{{check|sample_temperature_ok, checked_message="Sample remained within the permitted temperature range"}}
```

Add a checkpoint when failure changes the run state or interpretation. Do not add decorative checks for routine narration, and do not repeat a step's completion toggle as a second checkpoint.

## Choice Questions

````aimd
```quiz
id: storage_condition
type: choice
mode: single
stem: "How is the sample stored?"
options:
  - key: refrigerated
    text: "Refrigerated"
  - key: frozen
    text: "Frozen"
  - key: ambient
    text: "Room temperature"
```
````

Use a quiz for a decision with explicit options, not as a substitute for an ordinary typed field.

## Tables, Figures, and Media

- Use `var_table` for repeated structured rows with stable column ids.
- Use `fig` for static images and `media` for video, audio, or referenced files.
- Keep large artifacts in the project workspace and reference their relative path.

## Minimal Complete Protocol

```aimd
# RNA yield measurement

Measure RNA yield with a calibrated instrument and retain the value used for downstream normalization.

Use after extraction when downstream normalization needs a reviewed concentration. Do not use this workflow to assess RNA integrity.

Before starting, have the {{var|sample_id: str, title="Sample ID", owner="human"}}, calibrated {{var|instrument_id: str, title="Instrument", owner="human"}}, and blank measurement available.

{{step|prepare_instrument, level=1, title="Prepare and blank the instrument", check=True, duration="3m"}}

{{check|blank_passed, checked_message="Blank measurement passed the instrument threshold"}}

{{step|measure_sample, level=1, title="Measure the sample", check=True, duration="4m", result=True}}

The reviewed RNA yield is {{var|yield_ng_ul: float, title="RNA yield", owner="human", unit="ng/µL", ge=0}}.

{{step|seal_result, level=1, title="Seal the reviewed result and linked report", check=True, result=True}}

Store the decision in {{var|run_decision: Literal["pass", "repeat", "stop"], title="Run decision", owner="human"}} and generate {{var|record_path: str, title="Run record", owner="system", readonly=True}}.
```
