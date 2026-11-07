# Entry schema

Use Markdown with YAML frontmatter. Version 2 adds lifecycle and source pointers while remaining compatible with older files.

```markdown
---
schema: deepscientist.project_memory.entry.v2
title: Preserve missing measurements
domain: general
status: active
scope: Use when normalizing sparse measurement tables.
source_refs:
  - kind: file
    ref: analysis/missingness-audit.json
  - kind: git
    ref: 2f7c901
stale_when: The upstream provider changes its missing-value contract.
tags: [data-quality, normalization]
---

# Preserve missing measurements

Do not convert missing measurements to zero. Keep the missingness mask through normalization.
```

Required for new entries:

- `schema`: `deepscientist.project_memory.entry.v2`
- `title`, `domain`, `status`, and a narrow `scope`
- at least one `source_refs` item that a reviewer can inspect
- one concise, reusable idea in the body

Lifecycle values are `active`, `superseded`, `refuted`, and `stale`. Reuse only `active` entries by default. Correct the existing file or mark its lifecycle state instead of silently keeping contradictory active entries.

Source kinds are `artifact`, `evidence`, `git`, `file`, `conversation`, and `human`. A conversation pointer is acceptable for an explicit human correction, but raw conversation content must not be copied into memory.

Use `stale_when` for facts that depend on a provider, dataset version, environment, market regime, guideline, or other changing condition. Use `supersedes` and `contradicts` only when the relationship helps a later reviewer resolve the record.
