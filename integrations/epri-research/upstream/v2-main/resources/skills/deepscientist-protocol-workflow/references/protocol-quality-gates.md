# Protocol Quality Gates

Apply these gates before calling a protocol ready.

## Structure

- The file lives under `protocol/` and uses the `.aimd` extension.
- The first level-one heading is a literal, human-readable protocol name.
- Every field, step, check, quiz, figure, and media item has a stable unique id.
- The official AIMD parser reports no syntax error.

## Scientific Usability

- Purpose, scope, prerequisites, inputs, outputs, and stop conditions are explicit.
- A newcomer can identify when to use the workflow, where to start, what counts as complete, and what result remains without opening technical details.
- Each step begins with an observable action and has enough context for the intended operator.
- When a step subtitle is present, it states an observable completion criterion that is not already clear elsewhere and does not repeat the title.
- The main page reads as a compact report, without generic headings or filler phrases such as “detailed record”, “check each item”, “具体记录”, or “分别检查”.
- Units, ranges, enums, examples, and requiredness are declared where they prevent ambiguity.
- Blocking checks exist at safety, quality, and interpretation boundaries without duplicating ordinary step completion.
- A failed check never produces a false “completed” record.

## Human and Agent Ownership

- Direct observations and approvals identify a human owner.
- Agent-filled values identify their source or are marked as suggestions.
- Computed values name their dependencies and remain reproducible.
- No field asks an Agent to invent an unavailable observation.

## Records and Privacy

- Real run data is stored in `protocol-runs`, not the protocol source.
- Records contain the protocol path, Git revision, timestamps, field values, and step/check state.
- Secrets, hidden reasoning, unrelated conversations, and unnecessary personal identifiers are excluded.
- Completed records are immutable and exportable as structured JSON.

## Dry Run

Run the protocol once with representative non-sensitive values. Confirm that the UI renders every field, required completion is detectable, failed checks remain visible, the final result names the real decision or output, and the exported Record can be interpreted without reading the chat history.
