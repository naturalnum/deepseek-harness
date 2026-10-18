---
kind: upgrade-guide
description: "The Cloud runtime Loader entry requires complete root configuration and no longer exports a default service class."
---

# Configure the Cloud runtime root

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-pe-cloud-runtime` and its `/root` entry expose the function plugin's named `name`, `inject`, `Config`, and `apply` exports. The Loader requires complete PostgreSQL, credential-reference, instance, path, native-recipe, and capacity configuration. The former three-field capacity configuration does not launch root control.

The required `accountPolicy` selects finite exact provider/model pairs, one fixed native Preset declaration and its bounded canonical configuration digest, and the guarded AgentLoop entry. Active root control does not publish an account or enable business traffic. The named `PeAccountRuntime` class retains capacity/participant component composition.

## Migration

1. Load the `/root` module namespace through Cordis. For component consumers, replace a default import with `import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'`; use `PeAccountRuntime.Config` for the three component capacities.
2. Provide every field in [RuntimeRootConfigSchema](../../../../packages/cloud/pe-cloud-runtime/src/root-config.ts). Install the formal `credentials` provider before the root and set `database.passwordRef` to its reference name. Keep the password out of account configuration and launch environments.
3. Supply every `accountPolicy` field using the actual native entry ids and approved declaration described in the [package reference](../../../../packages/cloud/pe-cloud-runtime/README.md#account-policy). Declare the runtime's required peers from its [package manifest](../../../../packages/cloud/pe-cloud-runtime/package.json) so native provider identities remain shared.
4. Verify actual Loader startup registers the process in PostgreSQL and root disposal closes its record. Keep account admission closed until the files, execution, save, exposure, and writer-quota prerequisites pass; successful root startup alone cannot satisfy them.
