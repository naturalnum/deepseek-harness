---
kind: upgrade-guide
description: Cloud plugin controls use catalog-defined operations and JSON Config fields, and native callers use a shared selection guard.
---

# Cloud plugin catalog controls

English | [中文](guide.zh.md)

## Change

Cloud plugin requests identify an approved catalog item instead of one fixed reminder. Each controlled catalog item requires `control.selectionTarget`, `operations`, `maxImpact` and approved ordinary `fields` paths. Configuration operations carry `path` and literal JSON `value`; threshold presets are removed. Native callers use `PluginSelectionGuard` and `registerSelectionGuard`; its check receives a discriminated entry or bundle target. Native no-HMR results keep their original meaning. Complete preinstalled bundle selection requires explicit graph-rebuild control and replacement verification; local structural changes still reject before persistence.

## Migration

1. Add `control` to each controlled item in `approvedConfiguration.plugins`. Use an exact preinstalled module/package/version, an entry or bundle selection target, permitted operations, an impact ceiling and ordinary Config paths; `toggleable` must match the `enabled` permission. Do not move volatile Settings fields to this path.
2. Regenerate the original Host/Remote Typert artifacts. Read `configuration.fields` and send `{kind: 'configure', path, value}` with the original opaque edit version. Handle native refusal and retained unknown outcomes without replay. Read each field’s `writable` flag before offering a complete-field edit. Protected or unproven fields have an opaque schema and no value; native secret-presence markers reveal only whether declared secrets are set. Approve a narrower ordinary child path for mixed containers; secret and volatile writes remain outside this operation.
3. Replace `registerEnableGuard` with `registerSelectionGuard` and check its entry/bundle target. Confirm unsupported structural bundle changes leave both native profile files unchanged, and that successful application includes native runtime settlement and the original account re-audit.

4. Declare complete bundles in `approvedConfiguration.bundles` with exact package/version and member identities, only `selected`, `maxImpact: graph` and empty fields. Discriminate current state by `selectionTarget.kind` and read native `bundle` or `plugin` accordingly. Submit complete bundle changes with `stop-and-apply`, then reconnect and read current state. Acceptance and native no-HMR persistence do not certify application; Root must complete the real production replacement/PG acceptance before exposing the complete flow.
