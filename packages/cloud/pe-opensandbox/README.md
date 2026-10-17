---
description: "OpenSandbox capability declarations, unavailable-execution diagnostics, and trusted session scope checks for cloud composition maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-opensandbox

English | [中文](README.zh.md)

## Summary

This package rejects cloud execution when required infrastructure or target verification is missing. It lets composition maintainers inspect capability gaps and validate bounded, revocable session scopes without allocating a sandbox. No execution mode is available, and an empty requirement list cannot make an account ready.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `/root` and `/account` Loader entries belong in a `dsh` profile composition. Both currently fail with `cloud/execution-unavailable` before publishing a coordinator, drain participant or native provider. There is no configuration that enables execution. Importing the package, parsing its configuration and creating internal scopes do not allocate compute or contact a backend.

### Configuration and failure

Both entries require the same explicit capability declaration. The [schema](src/config.ts) owns the accepted mode names; declaring a mode does not verify it.

| Field | Default | Meaning |
| --- | --- | --- |
| `requiredCapabilities` | required | Modes required by the deployment recipe; an empty array does not bypass missing infrastructure. |

Persistent allocation reconciliation, trusted account ports, target channel verification, resource isolation and managed-range stopping remain prerequisites. The [Loader fixture](tests/fixtures/entries.cordis.yml) and [composition tests](tests/composition.spec.ts) demonstrate the refusal path rather than a working deployment.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host library exposes the capability assessment, its typed error and the coordinator Service Definition. The [coordinator definition](src/coordinator.ts) consumes the runtime package's AccountBinding and drain receipt types and uses Cordis's unique service registration. It supplies no backend or receipt implementation.

The internal [scope issuer](src/scopes.ts) retains that same binding and the project type supplied by its owning adapter. It checks exact native Agent identity, bounds live scopes and invokes the current account-generation, project, consumer and mode authorization check at issuance and use. Copied or foreign scopes are rejected. Revocation closes user admission without claiming any process or allocation has stopped.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Application composition](../../../docs/architecture.md)
- [Native subprocess semantics](../../subprocess/subprocess/README.md)
- [Lifecycle review rules](../../../docs/defensive-patterns/general.md)

-----

<a id="model-experience"></a>
## Model Experience

### Execution admission

#### What the model sees

The package registers no model tool, changes no model input and emits no Session event. A model cannot set `requiredCapabilities`, construct a scope or invoke an unverified mode.

#### Token effect

The package adds no model-visible content and therefore adds no input tokens.

#### KV Cache effect

The package does not modify request content, ordering or cache prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Execution remains unavailable until its actual owners and target guarantees are integrated.

- The root coordinator implementation and mandatory execution participant registration require persistent reconciliation and verified target evidence. Native ShellExecutor and SubprocessRuntime providers remain absent, so these entries cannot satisfy account readiness.
- The scope issuer is internal. It does not replace the account factory's restricted execution port, project authorization or target capability validation, and it defines no substitute AccountBinding or drain protocol.
- The native default Bash executor settles from subprocess `done`, which does not establish that all descendants have stopped. Shell preparation and scope completion need an explicit compatible adapter.
- OpenSandbox's text command stream does not supply the complete raw-pipe/control behavior or managed-range observation required by the native subprocess interface. No helper, final execution protocol, stopping proof, host fallback or automatic recovery is supplied here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
