---
kind: upgrade-guide
description: "Cloud permission profiles require a third sandbox preset."
---

# Cloud permission profiles require three presets

English | [中文](guide.zh.md)

## Change

Cloud deployments that assemble `cordis:pe-cloud-permissions` previously supplied two presets. The native permission service now requires exactly `read-only`, `workspace-write`, and `danger-full-access`, each with a matching `sandbox` value and `approval: never`; an older two-preset profile is refused. Full access remains confined to the account sandbox and its existing writable mounts and quotas.

## Migration

1. In the account recipe or profile entry for `cordis:pe-cloud-permissions`, keep the existing `defaultPreset` and two preset entries. Add the following entry under `config.presets`:

   ```yaml
   danger-full-access:
     sandbox: danger-full-access
     approval: never
     name: Sandbox full access
   ```

2. Check that the existing `read-only` and `workspace-write` entries have matching `sandbox` values and `approval: never`, and that no additional preset is present. Keep the account's existing mount and quota policies.
3. Restart using the updated profile and confirm that the account becomes ready and the permission control lists all three modes. Verify file and command access within the account sandbox before enabling the profile for users.
