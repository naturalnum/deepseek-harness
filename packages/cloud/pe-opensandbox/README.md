---
description: "Explicitly closed cloud execution, native refusal providers and capability diagnostics for composition maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-opensandbox

English | [中文](README.zh.md)

## Summary

Composition maintainers can explicitly disable cloud execution while mounting the required native refusal providers. Every Shell and subprocess request fails before execution preparation, without creating a sandbox or contacting a backend. Enabled execution remains unavailable, and an empty requirement list alone cannot make an account ready.

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

Mount `/root` and `/account` in a `dsh` profile composition. Explicit `mode: closed` registers the actual root execution owner and installs one native ShellExecutor and SubprocessRuntime per account. No configuration enables execution. Omitted closed mode and nonempty required capabilities fail startup with `cloud/execution-unavailable`.

### Configuration and failure

Both entries require explicit closed mode and an empty capability declaration. The [schema](src/config.ts) owns the accepted values; declarations never verify execution capabilities.

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | omitted: startup fails | Only `closed` is supported; all execution remains disabled. |
| `requiredCapabilities` | required | Must be empty in closed mode; any required capability prevents mounting. |
| `maxBoundAccounts` | root requires it | Positive finite capacity for simultaneously open exact account-generation registrations. |

Runtime first installs its immutable binding in an independent account graph. During native prepare, the trusted factory calls the root coordinator’s `bindAccount` with that exact installed object and its graph-current check, then calls `installAccountExecutionPort` before the account entry. Missing, copied, foreign or shadowed bindings and ports fail. Duplicate providers and exhausted capacity fail. Closed registration does not satisfy other account readiness checks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [root owner](src/closed-owner.ts) retains exact registrations and permanent admission state. Its dependencies contain no execution backend or process launcher. Stopping a known registration closes its port and retains an observation of this owner’s zero-work generation; unknown or cloned bindings reject. Root teardown closes all ports before participant withdrawal. Account teardown closes only its own port. These observations cannot certify resources from an earlier owner or epoch.

The [native providers](src/closed-providers.ts) share that port and reject every method, including executable lookup and terminal preparation. Spawn refuses synchronously; asynchronous methods return rejected Promises, and pre-aborted callers retain their reason. The internal [scope issuer](src/scopes.ts) remains separate: scope revocation never proves that an allocation or process has stopped.

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

The package registers no model tool or Session event. A model cannot enable execution through configuration or a copied scope. If another composed native tool requests execution, it receives `Cloud execution is disabled by this deployment.`

#### Token effect

The package injects no prompt content. A refused invocation can add the native consumer’s error text to its conversation.

#### KV Cache effect

The package does not modify request content, ordering or cache prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Closed mode is a restricted deployment configuration, not verified remote execution.

- All execution modes and consumers remain disabled. Enabling a mode requires persistent allocation reconciliation, complete deployment configuration, target channel and isolation evidence, and managed-range stopping.
- A closed drain observation covers only its exact registered generation. It supplies no allocation, remote stop or recovery proof and cannot clear old unknown work. Runtime still owns account readiness and recovery.
- The native default Bash executor settles from subprocess `done`, which does not establish that all descendants have stopped. Shell preparation and scope completion need an explicit compatible adapter.
- OpenSandbox’s text command stream does not supply complete raw pipes/control or managed-range observation for native subprocess. This package supplies no enabled execution protocol, host fallback or automatic recovery.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The portable [opt-in scope probe](tests/opensandbox-scope-probe.mjs) requires explicit `--workspace-root`, `--sdk-root`, `--out` and `--execute-authorized-once` arguments. It uses fixed cached images and at most one bounded Sandbox with two inner scopes. Its evidence separates scoped stopping, namespace security facts and binary-file Range transport; it does not enable execution or validate complete subprocess semantics.

</details>
