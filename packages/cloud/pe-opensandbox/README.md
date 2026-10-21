---
description: "Explicitly closed cloud execution, native refusal providers and capability diagnostics for composition maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-opensandbox

English | [中文](README.zh.md)

## Summary

Composition maintainers can select native refusal providers or the developing Root-owned session execution path. Closed mode rejects every Shell and subprocess request before preparation, without creating a sandbox or contacting a backend. Managed mode requires its original protected deployment and target qualification; an empty requirement list alone cannot make an account ready.

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

Mount `/root` and `/account` in a `dsh` profile composition. Explicit `mode: closed` registers the actual root execution owner and installs one native ShellExecutor and SubprocessRuntime per account. Configuration alone cannot enable execution. Omitted mode and required capabilities unsupported by the selected owner fail startup.

The `/types` entry exposes `ServicePreviewIdentity` with the original branded allocation/Session identifiers and `DevelopmentServiceId`, plus bounded application-read and registered-service definitions. Identity grants no authority; access requires the execution owner's current capability. Access adapters attach their audited HTTP exposure and browser response policy. The native development-service tool projects only its final bounded task handle, action and process-submitted observation into presentation metadata; infrastructure identifiers and preview URLs stay outside its model result and metadata.

### Configuration and failure

The deployed closed recipe requires explicit closed mode and an empty capability declaration. The [schema](src/config.ts) owns the accepted values; declarations never verify execution capabilities.

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | omitted: startup fails | `closed`, or development-only `session-collect` with the original protected Root deployment capability. |
| `requiredCapabilities` | required | Must be empty in closed mode; any required capability prevents mounting. |
| `maxBoundAccounts` | root requires it | Positive finite capacity for simultaneously open exact account-generation registrations. |
| `managed` | managed root requires it | Explicit managed limits; the strict parser validates them before owner construction. This JSON supplies no deployment authority. |
| `rootDeployment` | ordinary managed Root requires it | `{ path, sha256 }` references protected Root input. Absence requires an original internal deployment capability; supplying both sources rejects. Closed mode and Root mounting in an account graph reject this reference. |

The developing `session-collect` path requires an original `ManagedExecutionDeployment` capability. Normal Loader input supplies an explicit protected `rootDeployment` reference, from which Root constructs that capability; JSON itself supplies no authority. Passing the original object as the third argument to Root `apply` is reserved for trusted internal composition. Root awaits actual migration and recovery checks; the account entry requires an original matching port before installing Shell, subprocess and fixed remote ShellEnv providers. Actual deployment and native/Web qualification remain pending. The production recipe stays closed.

The private [Root SDK factory](src/bootstrap/factory.ts) loads the nine pinned Python assets shipped under `runtime/agent` and `runtime/bootstrap`, resolving them only beside built `lib` modules. Missing, linked or mismatched files reject before HTTP work; source-tree lookup and download fallbacks are unavailable. The factory retains the original bootstrap, authenticated registry and SDK backend ownership. It supplies no files-export authority or account admission, and does not enable the closed production recipe.

The original `/root` entry privately [assembles a deployment](src/bootstrap/assembly.ts) from an explicit `rootDeployment: { path, sha256 }` reference. The Linux CLI remains UID/GID2000 and reads a Root-owned `0:2000/0440` configuration on a readonly mount, retaining its original descriptor and exact bytes through cleanup. This selection lease records deployment policy; it does not prove server liveness. Assembly adopts the original inherited FD4 keeper and binds the original retained exports, including their epoch-release check. Unknown observer closure remains unknown until actual process exit; construction itself creates no sandbox.

Runtime first installs its immutable binding in an independent account graph. During native prepare, the trusted factory calls the root coordinator’s `bindAccount` with that exact installed object and its graph-current check, then calls `installAccountExecutionPort` before the account entry. Missing, copied, foreign or shadowed bindings and ports fail. Duplicate providers and exhausted capacity fail. Closed registration does not satisfy other account readiness checks.

Trusted bootstrap assembly may call `assertClosedAccountExecution(ctx)` to require that the original live port still owns the original active native Shell and subprocess providers. Missing, uninstalled, shadowed, replaced or stopped providers reject; this read does not execute a command, stop the port or issue drain evidence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [root owner](src/closed-owner.ts) retains exact registrations and permanent admission state. Its dependencies contain no execution backend or process launcher. Stopping a known registration closes its port and retains an observation of this owner’s zero-work generation; unknown or cloned bindings reject. Root teardown closes all ports before participant withdrawal. Account teardown closes only its own port. These observations cannot certify resources from an earlier owner or epoch.

The [native providers](src/closed-providers.ts) share that port and reject every method, including executable lookup and terminal preparation. Spawn refuses synchronously; asynchronous methods return rejected Promises, and pre-aborted callers retain their reason. The internal [scope issuer](src/scopes.ts) remains separate: scope revocation never proves that an allocation or process has stopped.

The private [allocation owner](src/allocation-owner.ts) coalesces the complete durable-intent, create and authenticated-prepare sequence per account, native Session and epoch. It retains late or uncertain work independently of cancelled waiters. Only actual backend stop and the original terminal metadata write release its mount reservation. Loader entries do not expose this component as an enabled backend.

The private [command operation](src/command-operation.ts) supplies a synchronous preparing subprocess handle and a separate Shell publication step before command commit. Direct exit plus collected-stream EOF settles subprocess `done`; complete range and local I/O settlement settle its independent range latch. [Shell projection](src/shell-execution.ts) waits for that whole range. Output remains bounded and readable until the original native result owner releases it; revocation denies public access while Root retains unknown cleanup. The account-local [tool-call propagation](src/native-calls.ts) binds these operations to the original registry token, Agent, Session and project across awaits.

The private [development-service consumer](src/dev-service-consumer.ts) requires an explicit complete `commands.services` policy and the original native tools provider. Root attaches the original managed owner's callbacks after strict configuration resolution; omission keeps this consumer closed. It uses that owner's existing work rows and subprocess provider for a project-relative Python HTTP script on port 8000. Start reports process submission separately from HTTP readiness; status, bounded logs and stop refer to the same retained operation. The pinned installation/service payload declares one foreground and one registered-service range, with fixed Root-signed roles, run limits of 150s/120s and an absolute 300s residence. Four lifetime records and these component-tested limits do not qualify the full Session lifetime or actual service isolation.

The original service row binds its allocation once and retains bounded application reads independently of a tool invocation. Optional `commands.services.application` supplies explicit global, account and service request counts plus all HTTP transport limits; it grants no network authority. The private [HTTP adapter](src/application-http.ts) permits only GET through Root's selected server, with fixed target identity, bounded buffers and an actual local I/O terminal. Root reserves global/account request counts and charges the same resident-byte pool used by command output before transmission. The public `withAccountApplicationService` helper requires the original installed account port and providers. The fixed control hop opts out of access renewal; it never accepts that header from a caller. Service stop, scope release and retirement cancel reads and join their actual terminals; unknown cleanup retains the original row and capacity. Missing Root callbacks keep reads closed. The adapter and row checks do not qualify the deployed proxy, browser authorization or workload network isolation.

Service-enabled execution account rows require `inject: ['tools']`; service-absent and closed rows retain their original dependency declarations. `accountServiceAvailability(ctx)` checks the original installed consumer and application factory without creating work. Replacement of the tool definition or either the installation or actual consumer Tools provider refuses inspection.

The existing HTTP timer consumes the original operation and service-role remaining time, the original ingress deadline and a conservative resident deadline captured before fresh bootstrap. Retention and submitted observations never restart these budgets. Physical sandbox expiry is separate: early expiry follows the original request-failure and physical-stop confirmation paths, and time alone never releases capacity.

The private [managed coordinator](src/managed-coordinator.ts) connects these owners with the original lazy native authority and files grants. Active process slots and retained output have separate release points. Root startup checks durable nonterminal allocations before readiness; shutdown joins startup, allocations, transport and metadata responsibilities. The [SDK adapter](src/sdk-lifecycle.ts) fences privileged bootstrap requests before its single qualified physical DELETE. The [trusted runtime registry](src/trusted-runtime.ts) retains ordinary authenticated requests until their actual local join; physical deletion alone does not release command capacity. Its finite [data carrier](src/agent-data/index.ts) preserves raw byte coordinates and original operation references. Their Loader installation still requires the original protected deployment; component installation alone does not qualify native/Web service execution.

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

Closed mode registers no model tool or Session event. A model cannot enable execution through configuration or a copied scope. If another composed native tool requests execution, it receives `Cloud execution is disabled by this deployment.` The private developing consumer adds `dev_service` only when Root explicitly installs it with the original execution owner; its start result does not promise HTTP readiness.

#### Token effect

The package injects no prompt content. A refused invocation can add the native consumer’s error text to its conversation.

#### KV Cache effect

The package does not modify request content, ordering or cache prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Closed mode is a restricted deployment configuration, not verified remote execution.

- The default closed recipe enables no execution. Managed operation still requires persistent allocation reconciliation, complete deployment configuration, target channel and isolation evidence, and managed-range stopping.
- A closed drain observation covers only its exact registered generation. It supplies no allocation, remote stop or recovery proof and cannot clear old unknown work. Runtime still owns account readiness and recovery.
- The native default Bash executor settles from subprocess `done`, which does not establish that all descendants have stopped. Shell preparation and scope completion need an explicit compatible adapter.
- OpenSandbox’s text command stream does not supply complete raw pipes/control or managed-range observation for native subprocess. The limited managed collect channel supplies neither interactive pipes/terminals nor a host fallback or automatic recovery.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The portable [opt-in scope probe](tests/opensandbox-scope-probe.mjs) requires explicit `--workspace-root`, `--sdk-root`, `--out` and `--execute-authorized-once` arguments. It uses fixed cached images and at most one bounded Sandbox with two inner scopes. Its evidence separates scoped stopping, namespace security facts and binary-file Range transport; it does not enable execution or validate complete subprocess semantics.

</details>
