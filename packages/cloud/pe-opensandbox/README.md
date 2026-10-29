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

The private [Root SDK factory](src/bootstrap/factory.ts) loads the nine pinned Python assets shipped under `runtime/agent` and `runtime/bootstrap`, resolving them only beside built `lib` modules. The package publication list retains both Python directories alongside its JavaScript and declarations. Missing, linked or mismatched files reject before HTTP work; source-tree lookup and download fallbacks are unavailable. The factory retains the original bootstrap, authenticated registry and SDK backend ownership. It supplies no files-export authority or account admission, and does not enable the closed production recipe.

The pinned command profile limits each child file to 64 MiB and its virtual address space to 512 MiB. These are per-process limits, separate from the deployment's container memory and account storage quotas; exceeding either quota can still stop an installation or computation. Commands default to `OPENBLAS_NUM_THREADS=1`; a command may override it. Actual Linux sandbox qualification is required before enabling a changed profile.

The original `/root` entry privately [assembles a deployment](src/bootstrap/assembly.ts) from an explicit `rootDeployment: { path, sha256 }` reference. The Linux CLI remains UID/GID2000 and reads a Root-owned `0:2000/0440` configuration on a readonly mount, retaining its original descriptor and exact bytes through cleanup. This selection lease records deployment policy; it does not prove server liveness. The closed selection fixes the server image for the skill resource mount and rejects other image digests before keeper adoption or SDK construction. Deployment v1 adopts the original inherited FD4 keeper and binds the retained exports, including their epoch-release check. Unknown observer closure remains unknown until actual process exit; construction itself creates no sandbox.

Deployment v2 explicitly selects `storage.mode: shared-path` and references the existing protected files plan. The [shared mount owner](src/shared-mounts.ts) selects stable project and Session-environment sources from that plan, measures the current source identities and hard quotas, and retains their directory descriptors until the allocation releases its share. This mode adopts no keeper or FIFO and publishes no export manifest. The plan lease checks protected configuration; each share separately requires its original files/native current-grant callback. Authority loss denies new execution while preserving physical-stop ownership and unresolved shares. Deployment owns persistent mounts, so account disposal does not unmount user volumes; actual native/Web qualification remains required. Shared-path v2 requires its separately pinned Native server image for the same account's `projects/<leaf>` and `environments/slot-0` or `slot-1` layout; legacy v1 retains its original image. Both preserve authenticated generation/socket binding and physical deletion-completion checks. When the protected bank selects `mode: session-directories`, Root requires the directory-aware image pinned in `bootstrap/deployment-input.ts`; the Native guard also verifies a direct UUID child of the same account’s original environment pool. Its [image overlay](runtime/server/Dockerfile) changes only [the guard module](runtime/server/completion_view.py); the original SDK bootstrap, workload image and quotas remain unchanged.

The files `staticStorage.maxMountInfoBytes` and the `storage.limits.maxMountInfoBytes` in the protected input referenced by `rootDeployment` are independent budgets; each must cover `/proc/self/mountinfo` in every actual Node mount namespace. Their respective `staticStorage.rootProbeReservationBytes` and `storage.limits.maxResidentBytes` must satisfy the [files probe](../pe-cloud-files/src/storage-probe.ts) and [shared mount](src/shared-mounts.ts) reservation formulas. Derive both limits from one deployment source to keep updates aligned.

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

A never-submitted foreground command can replace quiescent compute at the original four-record or 300-second residence limit. Root first joins the original physical stop, released metadata and mount release, then obtains a fresh files grant for the same Session environment and starts a fresh runtime. Active services, ranges, application I/O and unknown references block replacement. Confirmed stopped SDK, bootstrap and runtime records can be retired without reopening their original intent objects; unresolved records retain capacity.

When concurrent compute capacity is full, a new Session can retire one ready warm compute with no invocation, retained output, service or application I/O. Root fences only that Session, joins its original allocation stop and SDK/runtime retirement, then removes the cached selection before admitting a replacement. Concurrent callers share the same retirement; failed or unknown work is retained. Persistent environment data and all existing allocation, record and scope limits stay unchanged, so idle historical Sessions no longer consume compute capacity indefinitely. Shared-path environment layouts still require their reviewed, explicitly pinned Native guard.

The private [old-allocation recovery helper](src/allocation-recovery.ts) bounds and freezes every nonterminal row of one exact old account/epoch. Root's trusted verifier must prove old process/writer loss and permanent loss of late starts. Accepted creates require exact physical destruction and independent create binding for null sandbox ids, followed by original stopping/released CAS operations. Strict v2 evidence separately permits only completed `fixed-ttl-bounds` or `host-bind-bounds` refusals before provider creation: the exact intent and four refusal/completion/non-creation/late-start references authorize only original `failNotCreated` CAS to a fixed failed/null-id postimage. HTTP500 or an empty listing alone cannot qualify. Unknown writes reconcile the original captured postimage without replay; unresolved responsibilities keep recovery closed. The helper returns coverage references to runtime's separate recovery CAS and grants no provider authority. Actual maintenance, PostgreSQL and backend qualification remain separate requirements.

The existing Root entry also supports an explicitly closed maintenance composition: `mode: closed`, empty required capabilities, finite `managed` metadata budgets and one protected `recovery` publication reference. It constructs neither SDK execution nor account graphs. Its original execution participant rechecks process death and the complete immutable intent coverage, reconciles allocation rows through the original store, then invokes runtime's exact old-owner recovery and separate old-instance closure. Unknown actual work retains cleanup responsibility. The publication is pinned by SHA256 and a read-only Root-owned lease, not a cryptographic signature.

The private [command operation](src/command-operation.ts) supplies a synchronous preparing subprocess handle and a separate Shell publication step before command commit. Direct exit plus collected-stream EOF settles subprocess `done`; complete range and local I/O settlement settle its independent range latch. [Shell projection](src/shell-execution.ts) waits for that whole range. Output remains bounded and readable until the original native result owner releases it; revocation denies public access while Root retains unknown cleanup. The account-local [tool-call propagation](src/native-calls.ts) binds these operations to the original registry token, Agent, Session and project across awaits.

The private [development-service consumer](src/dev-service-consumer.ts) requires an explicit complete `commands.services` policy and the original native tools provider. Root attaches the original managed owner's callbacks after strict configuration resolution; omission keeps this consumer closed. It uses that owner's existing work rows and subprocess provider for a project-relative Python HTTP script on port 8000. Start reports process submission separately from HTTP readiness; status, bounded logs and stop refer to the same retained operation. The pinned installation/service payload declares one foreground and one registered-service range, with fixed Root-signed roles, run limits of 150s/120s and an absolute 300s residence. Four lifetime records and these component-tested limits do not qualify the full Session lifetime or actual service isolation.

The original service row binds its allocation once and retains bounded application reads independently of a tool invocation. Optional `commands.services.application` supplies explicit global, account and service request counts plus all HTTP transport limits; it grants no network authority. The private [HTTP adapter](src/application-http.ts) permits only GET through Root's selected server, with fixed target identity, bounded buffers and an actual local I/O terminal. Root reserves global/account request counts and charges the same resident-byte pool used by command output before transmission. The public `withAccountApplicationService` helper requires the original installed account port and providers. The fixed control hop opts out of access renewal; it never accepts that header from a caller. Service stop, scope release and retirement cancel reads and join their actual terminals; unknown cleanup retains the original row and capacity. Missing Root callbacks keep reads closed. The adapter and row checks do not qualify the deployed proxy, browser authorization or workload network isolation.

Service-enabled execution account rows require `inject: ['tools']`; service-absent and closed rows retain their original dependency declarations. `accountServiceAvailability(ctx)` checks the original installed consumer and application factory without creating work. Replacement of the tool definition or either the installation or actual consumer Tools provider refuses inspection.

The existing HTTP timer consumes the original operation and service-role remaining time, the original ingress deadline and a conservative resident deadline captured before fresh bootstrap. Retention and submitted observations never restart these budgets. Physical sandbox expiry is separate: early expiry follows the original request-failure and physical-stop confirmation paths, and time alone never releases capacity.

The private [managed coordinator](src/managed-coordinator.ts) connects these owners with the original lazy native authority and files grants. Active process slots and retained output have separate release points. Root startup checks durable nonterminal allocations before readiness; shutdown joins startup, allocations, transport and metadata responsibilities. The [SDK adapter](src/sdk-lifecycle.ts) fences privileged bootstrap requests before its single qualified physical DELETE. A bootstrap startup failure does not by itself mean a privileged start remains unresolved: a bounded initialized command stream with its execution-complete event may fail strict output/error validation while its actual dispatcher still joins. Missing terminal facts, exceeded observation limits or failed dispatcher closure retain unknown and block deletion; HTTP success alone supplies no terminal or physical-stop proof. The [trusted runtime registry](src/trusted-runtime.ts) retains ordinary authenticated requests until their actual local join; physical deletion alone does not release command capacity. Its finite [data carrier](src/agent-data/index.ts) preserves raw byte coordinates and original operation references. Their Loader installation still requires the original protected deployment; component installation alone does not qualify native/Web service execution.

The private [semantic observer](src/semantic-audit.ts) optionally publishes bounded SDK, bootstrap and native-operation facts to a protected receiver installed before application import. The receiver acknowledges each complete original-stderr write once; lost or failed delivery taints evidence. Observation preserves original Promises and grants no business control or recovery authority.

The optional trusted `ManagedExecutionDeployment.skillCopies` policy supplies an explicit `maxCopiesPerOperation`; it is not public Loader JSON or model input. It requires the original files owner’s `prepareSkillProject` and `borrowAllBundleWorkingCopies` implementations. Missing enumeration refuses before allocation. For each command, that owner derives the complete bounded legacy-and-full-tree set from its protected project associations and validates the issued `SkillBundleOperationCopies`; excess, unknown or unqualified members refuse the whole operation. Command text, paths and an API publication cache cannot select membership. The allocation retains its original parent/export borrow; each original command retains its real copies borrow until actual range completion and local settlement, or qualified joined physical stop. Output retention has a separate release point. The protected `rootDeployment` file accepts the optional closed `skillCopies: { maxCopiesPerOperation }` object. Its count must be an explicit positive integer at most 2147483647; omission leaves the policy absent. Assembly forwards the independent frozen policy to the original deployment.

The [fixed copy world](runtime/agent/paths.py) preserves project RW and the outer `.pe` RO mount, adding only the fixed `.pe/skills` child RW export. Inner preparation captures actual version-directory FDs, builds a readonly scaffold and binds only those version directories RW. Guardian verifies the actual parent/copy identities and mount modes before PREPARED, then enforces the existing eight-FD boundary. The public command remains exactly `argv`, `cwd`, `stdin`; normalized private facts are bound into its original spec hash and role HMAC. The complete 4096-byte Guardian frame includes those facts. Native admission first reserves a conservative scalar byte ceiling for the entire configured copy count, before command reservation or allocation; the final actual frame is checked again before transmission. Oversized commands refuse even when a smaller current set might fit. Original files source mount identity checks stay in their qualified source context; container mount ids are observed independently. Cross-namespace cold recovery and actual SDK nested-volume qualification remain required before enabling this policy. Native get also requires simultaneous files resident capacity for its retained source snapshot and materialization, plus retained parents and operations; a single-reservation configuration cannot admit that chain.

The managed coordinator observes local-update idleness on its original open account port, command records and allocation owner. Pending invocations, subprocess acquisition, incomplete descendant ranges or process I/O, development services, application requests, create/prepare/stop/reconcile work and unknown outcomes deny the update. Settled ready sandboxes, cached Session selections and completed retained output may remain without releasing their identity, mount or budget. The base coordinator denies this observation; terminal replacement still joins every warm allocation and retained result through the original stop/disposal path.

Explicit `shell.enforceSessionFilePolicy: true` enables the original Session policy for both Shell and Subprocess; omission retains the legacy path and cannot advertise permission controls. The policy service is a required peer dependency: published execution entries use the account's original `SandboxPolicyService` constructor rather than an inlined copy. The original command owner captures a read-only or workspace-write policy and includes it in the existing spec hash and Root role HMAC. A read-only Session cannot widen through a per-call override. The native workload binds the project, environment home/venv/tmp, `/tmp` alias and selected skill copies according to that mode. Guardian checks their actual mount flags before PREPARED, and the original complete 4096-byte frame budget includes the private policy. Permission changes require normal settlement of retained commands, unknown results and services. Function/argv tests and payload pins alone do not establish Linux kernel or deployed browser acceptance.

The first unexpected preparation refusal in an account epoch writes a fixed stage, process id, coordinator admission booleans and allowlisted own-data error codes to stderr. It omits messages, stacks, paths and request arguments and never invokes error accessors. Confirmed pre-allocation environment exhaustion keeps its existing capacity response. Observations neither change the retained original failure/cleanup nor prove sandbox readiness.

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

- Compute replacement runs only during a new foreground acquisition. It starts no idle timer and cannot migrate an active service. Actual same-Session environment persistence and native/Web continuity still require deployment verification.
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
