---
kind: upgrade-guide
description: "Command-only Workspaces may retain empty skill directories without associations, which older readers reject."
---
# Skill-project capacity readers must support empty unrecorded directories

English | [中文](guide.zh.md)

## Change

With `pe-cloud-files/root.skillProjection`, `maxProjects` continues to limit persistent skill-copy associations. When that bound is full, command-only Workspaces can execute with empty `.pe/skills` directories without adding records under private `skill-working-copies/`. Every operation rechecks emptiness; skill materialization still requires an association. No data is deleted and no configured bound is raised. Older readers classify an unrecorded directory as an unknown write failure and can refuse all further account writes in that process.

## Migration

1. Upgrade `pe-cloud-files` and `pe-opensandbox` together. Keep existing `skillProjection` limits and verified storage settings. Preserve records and working copies.
2. Verify an account with full associations can execute in another Workspace and cannot publish an extra skill association. Verify nonempty unrecorded directories are refused without locking unrelated account writes; unknown mutation outcomes must remain retained.
3. Retain a compatible reader for rollback after the first unrecorded directory is created. Do not downgrade to a reader lacking empty-directory support, delete association records or edit storage state to bypass the limit. If such a downgrade is required, stop and obtain a separately reviewed offline migration that verifies and removes only empty unassociated directories; this release provides no automatic downgrade conversion.
