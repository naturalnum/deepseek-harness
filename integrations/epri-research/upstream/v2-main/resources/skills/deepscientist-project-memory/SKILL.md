---
name: deepscientist-project-memory
description: Curate durable, evidence-backed knowledge in the current DeepScientist Git project. Use when prior project knowledge can change the current decision, when a reusable method/fact/lesson was learned, or when project memory must be reconciled. Do not use for routine chat history, temporary state, or cross-project recall.
---

# Git Project Memory

Treat memory as a quiet project capability, not a separate research stage. Git files are the source of truth; do not create or call a separate memory service.

## Fast path

1. Recall only when prior project work can change the present decision. Read the smallest relevant set of tracked files, diffs, or commits; never scan the whole memory tree by default.
2. Do the requested work. Do not add memory chores, repeated status reads, or memory narration to the critical path.
3. Before every meaningful verified checkpoint, assess the new verified diff for durable project knowledge. If at least one reusable method, confirmed fact, or failure lesson would prevent repeated work or materially improve a later decision, write or update one to three entries and include those exact paths in the same checkpoint. Zero entries is valid only after an actual assessment finds no qualifying knowledge.

## Rules

- Scope is the currently bound Git project, not the application, account, or conversation. A conversation may produce candidates; they become reusable across conversations only after entering a tracked project checkpoint.
- Explicit user instructions and current verified evidence override stored memory.
- Keep one reusable idea per file under `memory/methods`, `memory/knowledge`, or `memory/lessons`. Prefer updating an existing entry over adding a synonym.
- Store compact conclusions and source pointers, not raw conversations, hidden reasoning, routine command logs, report copies, secrets, credentials, account data, or identifiable patient data.
- In Team Mode, Workers may read their worktree snapshot and identify candidate memory with source pointers in their delivery. After integrating Worker commits, the Lead must load this Skill once, review only the integrated diffs and existing relevant entries, and complete memory reconciliation before the final checkpoint or publication. Only the Lead or integration branch decides what becomes shared project memory.
- Load `deepscientist-protocol-workflow` only when the user asks for a reusable executable SOP or protocol. Project memory alone is not a reason to create one.

## Progressive references

- Read [scope-and-permissions.md](references/scope-and-permissions.md) when project binding, branch visibility, Team ownership, privacy, or cross-project use is uncertain.
- Read [entry-schema.md](references/entry-schema.md) immediately before creating, updating, superseding, or refuting an entry.
- Read only the active domain section of [mode-policies.md](references/mode-policies.md) when a specialist mode needs deposition guidance.

Do not narrate routine memory checks. When a substantive Team run reaches final publication with zero qualifying entries, state the short reason in the completion summary so an empty memory view is distinguishable from a skipped reconciliation.
