# Files, Revisions, and Annotations

Read this file only when saving reproducibility files, updating an earlier
artifact, or linking a conclusion to exact source lines.

## Save files

DeepScientist keeps one artifact file history for each project under
`.deepscientist/artifact-repo`.

Call `science_artifact(action="snapshot")` when:

- a figure, table, notebook, PDF, LaTeX manuscript, dataset slice, Viewer
  configuration, or run bundle was created or changed;
- a user annotation caused source code or text to change;
- files needed to inspect or repeat the result are not already declared on the
  artifact; or
- the user asks to preserve temporary output.

Include only useful project-relative paths. Give each path a clear role such as
`primary`, `source`, `input`, `code`, `log`, `output`, `environment`, or
`reference`. Large files may be represented by a pointer, hash, and size.

Never include `.env`, credentials, SSH keys, tokens, caches, or unrelated build
output. Use `project_workspace(action="checkpoint")` separately when the source
project reaches a meaningful verified stage.

## Continue an earlier artifact

1. List project artifacts with `payload.scope="project"`.
2. Identify the original `runId`, artifact id, and version.
3. Get that exact artifact and keep its returned revision.
4. Use `patch` for labels, report text, pages, display settings, or source-link
   corrections.
5. Use `version` when the scientific content or generated file changes.

Do not recreate an artifact simply because it came from an earlier
conversation.

## Link exact code or text

Use a Git line anchor when a conclusion depends on exact source lines. Supply:

- `kind: "git_lines"`;
- `commit` such as `HEAD`;
- project-relative `filePath`;
- `lineStart`, optional `lineEnd`, and optional `side`.

The tool resolves the commit, blob, line range, and context hash. Use `get` with
the same anchor to read those saved lines. Search saved evidence with `list`,
`target.kind="evidence"`, `payload.scope="project"`, and optional
`payload.query`.

## User annotations

Annotations should identify the target file or artifact, selected region or
line range, and the user's note. If an annotation changes scientific content,
save a new version and snapshot the changed source. Do not close a page the
user opened unless the user asks.
