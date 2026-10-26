---
description: "Save active profile configuration and apply it through Loader."
kind: "package-reference"
---

# @deepseek-ai/dsh-config-editor

English | [中文](README.zh.md)

## Summary

Save plugin configuration in the active profile’s patch and apply it immediately. Writes validate the complete candidate before touching disk and serialize with profile changes and HMR. Invalid values and higher-layer overrides leave the file unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this service in a profile application with Loader and `profileContext`. It has no configuration fields.

```yaml
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
```

Use [settings](../../settings/settings/README.md) for forms restricted to live fields. Callers that edit complete configuration can use `ctx.configEditor.edit()`; ordinary fields retain Loader’s normal lifecycle.

An embedding Host can install one `ConfigSaveSubmissionHook` with `registerSaveHook()`. Instrumented writers call `submitSave(writer, submit)` before their private queue; the hook decides admission synchronously and observes the actual operation Promise, including required application and its failures. The native writer id carries no configuration values or secrets. Without a hook, submission calls the operation directly and returns its original Promise. The caller must stop and settle protected writers before disposing the hook; caller unload also removes it.

`edit()` submits before HMR and the file lock. Settings and default-model writers submit at their own outer boundary, so their full completion is observed. Nested submissions through the same editor share one admitted operation until its Promise settles; callers must await nested work. Independent submissions and continuations after settlement require fresh admission. This prevents a nested `edit()` from waiting on its own slot in an embedding Host's save queue. Plugin selection writes its own files, and credential providers have their own hook; neither is covered by this editor hook.

An embedding Host can also install one `ConfigImpactGuard` with `registerImpactGuard()`. The editor obtains an opaque native profile plan, awaits the policy check, and rechecks the plan before persistence and actual Loader mutation. Approval cannot grant a remount or unknown impact. The guarded subset supports only a config edit in a settled, flat root Include over an immutable native entry-list root file, using deterministic built-in schemas and the sole native config resolver. Unsupported schemas and extra config callbacks reject before candidate parsing. Pending old patches, expressions, nested trees and structural changes also reject. Field permissions remain the Host's responsibility.

The Loader reservation spans persistence and application, rejecting competing tree mutations. Native versions, entry/fiber/module identities, raw options, schema and effective values bind the plan. A guarded failure after the replacement can leave committed state; it rejects without attempting an unguarded rollback that could remount. The caller must retain that failure and reconcile the account's state before further changes. This is a live-only subset, not a general impact planner. Stop and settle protected edits before withdrawing the guard.

An optional `ConfigEditControl` retains the original caller check across queueing, awaited policy and atomic replacement. The target requires supported live validation; unchanged rows retain native `none` plans and do not execute their schema callbacks. `editFailureOutcome(error)` recognizes only this editor’s exact guarded rejection object: `not-published` before replacement, `unknown` once replacement begins. The original error identity is preserved.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Without an impact guard, the [editor](src/index.ts) reconciles external changes before deriving a candidate, locks the profile manifest alongside other profile operations, and atomically replaces its config override. It preserves YAML comments and `!!js` expressions outside replaced values. A failed reconciliation restores the prior document and reloads the prior patches. Installing an impact guard selects the checked live-only path described above; it never first applies pending old patches.

Configuration reads share one composition for entries without profile config overrides. Overridden entries are composed separately with only their own override removed; profile inserts and other entries' overrides remain effective. Returned configs are detached, and compositions are not cached between reads.

Ordinary guarded edits retain their live-only policy. A trusted Host control may explicitly select the bounded native leaf planner for one config-only optional entry; the original writer and profile lock still own persistence. Literal disabled entries can retain an ordinary approved config without activation. Effective and inherited values include the original root file, so a base-only entry remains editable without inserting another entry or rewriting that file.

`ConfigEditControl.check(plan)` can restrict the trusted bounded leaf path against the original prepared native plan before replacement. It cannot authorize an unknown plan or expand the native stop closure. Ordinary Settings callers keep their existing live-only path.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Profile loading](../app-boot/README.md) — patch composition.
- [HMR](../hmr/README.md) — reload coordination.
- [Settings](../../settings/settings/README.md) — schema-derived forms.

<a id="model-experience"></a>
## Model Experience

Indirectly, through configuration values consumed by model-facing plugins.

#### KV Cache effect

Consumers that change request prefixes determine cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Edits target the active profile patch. Home patches and command-line overlays are read for precedence but are not write targets.
- A complete config override preserves ordinary fields but pins their current raw values at the profile layer.
- Only uniquely addressed entries owned by the profile’s root Include are editable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
