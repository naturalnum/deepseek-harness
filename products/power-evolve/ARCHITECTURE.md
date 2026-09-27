# PowerEvolve architecture decision

## Scope

PowerEvolve uses a shared DSH application host and a separate trusted platform. The accepted delivery sequence is conversation, files and skills, API authorization, cloud execution, desktop execution, and multiple hosts. Each slice includes a working client and its applicable persistence and failure checks.

## Service ownership

The host composes the native Agent loop, Session, Inbox, and Typert dispatch with product plugins. It accepts authenticated session requests, obtains execution grants, restores the native log, runs Agents, and releases idle runtime state. Mutable user configuration and authority belong to the relevant session or operation, never to a process-wide current-user variable.

The platform owns identity and approval, durable state and tasks, user configuration, workspace files, provider calls and credentials, and execution/device management. These are internal modules of one service. The platform checks the authenticated resource scope at the operation that accesses data. Agent credentials cannot authorize management or approval confirmation.

PostgreSQL owns resource identity, input acceptance, Operation and Attempt state, the native Session event log, and lease epochs. PG notifications are optional wakeups; durable rows remain discoverable after restart. Every input has a stable request ID. A duplicate ID with different content is a conflict.

## Files and execution

A Workspace identifies authorized persistent files. An environment specification records the selected base image, configuration and mount policy; a persistent Home is stored separately from disposable computation. A SandboxInstance is one replaceable execution instance. None of these is the Session identity. Ordinary conversation does not create a workspace or sandbox.

The execution slice adds k3s and Agent Sandbox through platform APIs. User code, process-based tools, Git, and executable skills run only in an authorized cloud sandbox or desktop executor. A live sandbox and the file service expose the same authorized workspace. Instance recycling preserves durable files and history, not process memory or PTYs.

## Trust and recovery

Only the platform receives provider secrets, PostgreSQL credentials, storage-root access, and infrastructure management rights. The host receives user-scoped input credentials and short-lived grants issued for tasks selected by the platform. The shared process can see its active users' memory; plugin scope does not provide process isolation.

Acceptance commits before the client receives `accepted`. Session writes and execution requests require the current lease epoch. Completion follows a native log durability barrier. Recovery consults the durable Inbox and execution records before delivery or replay. An expired lease rejects further API writes; stopping old processes with writable mounts is an additional obligation when execution is introduced.

## Development and verification

Product assemblies live under this subtree and launch through the upstream `dsh` profile mechanism. Product changes remain separate from upstream synchronization. The reference PowerEvolve repository supplies reusable domain implementations and test cases; importing a component requires checking its old single-session Runtime assumptions.

The first deliverable is two independently authenticated browser sessions sharing one host and real PG, with real model calls made by the platform. Its acceptance includes private history and event access, duplicate-input handling, accepted-before-execution restart recovery, completed-history restoration, and no execution sandbox. Later slices retain a stable trial while the next slice is developed.


## Slice 1 ownership

The selected upstream revision is pinned in [baseline.json](baseline.json). The earlier PowerEvolve implementation remains a reference: its per-session Runtime and older Session integration are not imported into the shared host. The native Web operator identity is unsuitable for multiple users, so the product exports its own authenticated Typert methods while retaining native dispatch and Agent lifecycle.

| Architecture responsibility | Slice 1 implementation |
| --- | --- |
| P01 runtime scope | `application/src/host/scope.ts` |
| P02 session store | `application/src/host/persistence.ts` |
| P04 user configuration | Platform configuration snapshot in each grant; per-Agent options |
| P07 model gateway | `application/src/host/model.ts` |
| P09 application API | `application/src/host/index.ts` |
| P10 task scheduling | `application/src/host/scheduler.ts` |
| T01 identity and authorization | `application/src/platform/identity.ts` and authorization on each resource operation |
| T02 state and tasks | `application/src/platform/tasks.ts`, `events.ts`, and database transaction/schema modules |
| T03 user configuration | User settings in PG, copied into accepted operations |
| T05 credentials and model egress | `application/src/platform/model.ts` |

These are responsibilities, not a requirement for a package or process per row. The two bundles explicitly install only the plugins needed by this slice.

## Slice 2 ownership

T04 is implemented by `application/src/platform/files.ts` and `skills.ts`. PostgreSQL identifies each user's workspace, records conditional file mutations, owns the skill catalog, and freezes enabled skill revisions at task acceptance. A private POSIX root holds the file bytes and skill instructions. The platform checks identity on each operation; the shared host forwards bounded, validated requests and never reads the storage root. Ordinary file access and reading a skill do not create a sandbox. Skill instructions enter an Agent's prompt as selected user content; skill code cannot run in the host. T06 cloud execution and sandbox mounts remain for the execution slice. A writable sandbox mount will require stronger filesystem boundary enforcement than the current single-machine path checks.

## Slice 3 ownership

P05 supplies two native, Agent-scoped connector tools: a read-only note query and an exact write proposal. T01 issues a separate approval credential for the platform origin; an Agent credential cannot approve. T05 keeps the remote API credential and outbound HTTP client in `application/src/platform/connectors.ts`. An approval stores the action, owner, Session, originating Operation, content digest, and stable remote idempotency key in PG. The platform checks identity and fingerprint before deciding, rechecks permission before dispatch, and queries remote status before retrying an uncertain response. A terminal action queues one platform-origin message in the original Session. The host can display the result but cannot approve or execute the write itself. The trial target is a separate loopback HTTP process, not a production connector catalog.

## Slice 4 ownership

P06 exposes one Agent-scoped `cloud_exec` tool. It submits a stable call ID and receives a durable receipt; the result later enters the same Session as one platform-origin operation. T06 owns a bounded execution queue in PG, Kubernetes credentials, per-Session Agent Sandbox resources, and a root-only runner token. Only the runner spawns user code as UID 1000. The platform mounts exactly the authorized user's workspace and Home; other users' paths and the storage root are not mounted. A root Session may reuse its live Sandbox, while recycling removes computation and retains POSIX files and Git history.

The platform queries runner status before dispatching an accepted command again. The runner also checks its instance ID before starting a command. A changed Pod or runner identity moves the execution and Sandbox to an uncertain state without replay. Before recycling a Sandbox with a writable mount, the platform retains its Pod with a finalizer, observes native kubelet termination, records the exact Pod UID and stop evidence in PG, and only then releases the Pod. Missing stop evidence blocks replacement. The trial uses a dedicated namespace and a namespace-scoped ServiceAccount; production ingress, network egress policy, descriptor-relative file access, multi-node POSIX mount consistency, and operator recovery from an unknown Pod remain separate deployment work.

## Slice 5 ownership

P06 also exposes an Agent-scoped `desktop_exec` tool selected per input. T06 stores the selected device and directory in the accepted operation; it checks their owner before issuing a durable command. The device runs as a separate local DSH Profile with a loopback-only authorization page and a private credential. The local OS user explicitly registers each project directory. Its real path stays on the device; the platform holds only device and directory IDs and labels. A command runs in a disposable Docker container with only that directory mounted. The cloud Sandbox and desktop container never share a live mount.

The device records a local command journal before Docker creation. After restart it inspects the exact named container and reports a completed result or an unknown outcome; it never starts a missing container again after a previous claim. Device and directory revocation stop new authorization and request cancellation of active commands. A lost platform connection stops a running local container after a short grace period. Terminal results become platform-origin operations in the original Session. Commands, paths and outputs are labeled by execution target in the client.

Files move between cloud and desktop only through an explicit action on the local authorization page. The device reads or creates one file under its selected directory, while the platform rechecks the device credential and directory scope before accessing the owner's cloud workspace. Transfers are limited to 2 MiB and refuse to overwrite existing destinations. There is no automatic synchronization. The trial has not yet established production-grade device attestation, descriptor-relative local path traversal, or hardened separation between host and platform OS identities.

## Slice 6 ownership

Two identical host Profiles may serve the same client origin behind a load balancer. The balancer checks readiness and routes each request to a healthy host without replaying a failed POST. It does not own Session affinity or task state. Both hosts claim work from PG; the platform's per-Session lease and epoch select one active writer. The current grant gates native event append, renewal, and completion. An interrupted model turn whose input was consumed is marked failed rather than reissued.

The platform rotates eligible users when claiming work, subject to its per-user pending and active limits. Cloud execution workers renew leases during slow Sandbox creation and check ownership before dispatch or cancellation; a runner request keeps its stable execution ID. Completed results enqueue one durable continuation. Event streams await socket drain and stop on disconnect. Idle host Agents and Sessions are released; ordinary conversation still creates no Sandbox. The multi-host trial proxy is a local test component, not a production ingress controller. The trial runs one platform instance; platform replica safety and large-scale capacity remain separate deployment gates.
