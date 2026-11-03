---
kind: upgrade-guide
description: "The Cloud runtime Loader entry requires complete root configuration and no longer exports a default service class."
---

# Configure the Cloud runtime root

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-pe-cloud-runtime` and its `/root` entry expose the function plugin's named `name`, `inject`, `Config`, and `apply` exports. The Loader requires complete PostgreSQL, credential-reference, instance, path, native-recipe, and capacity configuration. The former three-field capacity configuration does not launch root control.

The required `accountPolicy` selects finite exact provider/model pairs, an explicit native preset list with bounded canonical configuration digests and a selectable deployment default, and the guarded AgentLoop entry. Active root control does not publish an account or enable business traffic. The named `PeAccountRuntime` class retains capacity/participant component composition.

## Migration

1. Load the `/root` module namespace through Cordis. For component consumers, replace a default import with `import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'`; use `PeAccountRuntime.Config` for the three component capacities.
2. Provide every field in [RuntimeRootConfigSchema](../../../../packages/cloud/pe-cloud-runtime/src/root-config.ts). Install the formal `credentials` provider before the root and set `database.passwordRef` to its reference name. Keep the password out of account configuration and launch environments.
3. Replace `accountPolicy.presetId`, `presetEntryId` and `presetConfigSha256` with `defaultPresetId` and a nonempty `presets` list. Each row supplies `{id, entryId, configSha256, selectable}`; keep historical `cloud-text` approved with `selectable: false`, and make `standard` the deployment default. Compute each digest from the trusted resolved native declaration with `accountPresetConfigDigest`, preserving native expression source. Use the actual native entry ids and approved declarations described in the [package reference](../../../../packages/cloud/pe-cloud-runtime/README.md#account-policy). Declare the runtime's required peers from its [package manifest](../../../../packages/cloud/pe-cloud-runtime/package.json) so native provider identities remain shared.
4. Name the native preset registry entry `agent-preset-registry`, retaining its original implementation through the guarded Cloud builtin. Approve `selectedDefault` only for selectable ids. Preserve the account profile before explicitly migrating a historical default override; do not clear it silently. Confirm all four approved modes appear, a blank Session can switch, the chosen default survives reload, and an old Session restores its projected preset.
5. Verify actual Loader startup registers the process in PostgreSQL and root disposal closes its record. Keep account admission closed until the files, execution, save, exposure, and writer-quota prerequisites pass; successful root startup alone cannot satisfy them.
6. Custom `AccountNativeGuards` implementations must supply `assertRetainedExecutionOwner` for existing Native job cleanup. The shared account policy supplies it; do not replace ordinary active-scope checks with this callback. See [account policy](../../../../packages/cloud/pe-cloud-runtime/README.md#account-policy) for its retained-owner requirements.
7. To enable Native PTC and persistent terminals, use the matching stream protocol/source pins, qualified guest and server images, explicit `commands.pipes` budgets, and original account-scoped Native `ptc-runtime-node` and terminal registry services. Select the guest Node executable `/opt/dsh-native/node` and bootstrap `/opt/dsh-native/process.js` explicitly in the Native runtime launch config. The server must explicitly enable its exact reviewed Native bwrap profile; default Docker namespace/proc restrictions do not qualify this path. Retain existing limits and data, normally join the old owners, and verify the unified version in the real Web client before claiming mode acceptance.
