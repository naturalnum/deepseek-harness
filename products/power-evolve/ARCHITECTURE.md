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
