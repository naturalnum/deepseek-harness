# Scope and permissions

## Durable scope

Project memory belongs only to the currently bound Git project.

| Layer                                | May contain                             | Durable authority                            |
| ------------------------------------ | --------------------------------------- | -------------------------------------------- |
| Current conversation                 | Working context and candidate memories  | None                                         |
| Bound project worktree               | Draft memory changes                    | Visible locally, not yet reusable by default |
| Tracked project checkpoint           | Reviewed memory on the current revision | Canonical project memory                     |
| Other project or application account | Nothing implicit                        | No access or automatic transfer              |

A globally enabled Knowledge Deposition mode means the capability is available in every project. It does not create global shared memory. A new managed project starts with its own independent memory tree.

## Access boundary

- Read only relevant, tracked entries reachable from the current project revision.
- Write only inside the bound project worktree and only within the user's requested task.
- Without a bound project root, do not read or write durable memory.
- Repository access is the permission boundary. Anyone or any Agent with access to the project or worktree can read its tracked memory. There is no per-entry ACL.
- Mode and domain labels filter relevance; they are not security controls.
- Never copy memory to another project unless the user explicitly requests an import and the source material is permitted to move.

## Branches and Team Mode

- A Worker sees the snapshot available in its worktree and may propose an entry with its evidence.
- A Worker must not treat an unmerged branch entry as shared truth.
- The Lead reviews duplicates, conflicts, source support, and privacy before merging the entry into the integration branch.
- Once merged and checkpointed, the entry is available to later conversations bound to that project revision.

## Sensitive material

Do not store secrets, tokens, credentials, private account data, raw private conversations, protected health information, patient identifiers, or source material whose license or policy forbids project storage. Store a permitted pointer or an aggregate conclusion instead.

Explicit user instructions, newer verified evidence, and repository policy always outrank memory.
