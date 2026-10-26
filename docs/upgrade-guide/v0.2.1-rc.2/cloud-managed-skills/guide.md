---
kind: upgrade-guide
description: "Cloud skill assembly requires explicit management capabilities and an eight-method Remote inventory."
---

# Cloud managed skill assembly

English | [中文](guide.zh.md)

## Change

Cloud deployments that assemble `CloudSkillService` must supply its mandatory `managed` capability. The service registers the legacy sample pair plus six management methods as one native capability. Missing management configuration is refused before registration. Existing `current`/`publish` request fields and schema1 sample data remain supported; ordinary native skill composition is unchanged. The single catalog can become schema2 after an actual mutation; an older reader that does not support schema2 must refuse it rather than overwrite it.

## Migration

1. Set `approvedConfiguration.skills.mode` to `managed`, preserve the finite legacy `limits`, and provide all four finite `management` fields in `ManagedSkillApiLimits`.
2. Add the eight `cloudSkills` endpoints declared by `CloudSkillService`, each with `handlerId: native:cloudSkills` and `guard: authenticated-account`. Do not add streams.
3. Configure every `files/root.skillBundles` field explicitly, together with the original skill source/projection limits. Runtime reads these actual limits through `LinuxFilesPool.requireSkillBundleLimits()` and supplies the original `assertWorkspace` and complete resource materializer. Forward only the active source callback’s `snapshot.version`; source, parent, materialization and validation-operation results overlap in resident capacity. Configure the protected execution `skillCopies.maxCopiesPerOperation` and use `borrowAllBundleWorkingCopies` for every command, including legacy copies. Keep the existing files/account binding, save owner and Agent/project guards.
4. Regenerate Host/Remote artifacts and compile the owning Client plus an independent published declaration consumer. Verify actual eight-method native inventory and restore before opening business admission.
5. Read installed state before editing. A conflict requires a new read; unknown persistence or failed application requires reconciliation and must not be replayed automatically. Preserve schema2 data and immutable sources when rolling back to an incompatible binary.
