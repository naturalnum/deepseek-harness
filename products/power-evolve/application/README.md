# PowerEvolve application plugins

English | [中文](README.zh.md)

This private package supplies two separately launched applications. The host bundle loads `scope`, `persistence`, `model`, and `host`. The platform bundle loads `platform`. Sharing a package does not share a process, database connection, or provider credential.

## Host

`scope` calls one configured platform endpoint and holds grants by native Session identity. `persistence` implements the native Session storage service for leased root Sessions; authenticated session creation belongs to the platform API. Unleased access, forks, and arbitrary native creation are refused. Inactive histories stay in PostgreSQL. Each operation restores an Agent and disposes it after durable completion.

`model` uses the native DeepSeek Messages codec. It flushes the consumed input and request records before inference, then presents the operation grant to the platform. `host` exports only the product Typert namespace through authenticated JSON RPC and bounded NDJSON subscriptions. Agent-scoped native tools expose the controlled note query and approval proposal. Native operator-wide configuration, arbitrary filesystem access, process tools, plugin installation, and execution routes are absent from this composition.

## Trusted platform

Identity verifies seeded test accounts, issues separate expiring Agent and approval credentials, and revokes them on logout. Session APIs derive ownership from the authenticated identity. Task admission, request deduplication, per-user capacity, claims, and lease epochs commit in PostgreSQL transactions. Event appends require the current grant; repeated records must match exactly. Model egress validates the grant, model and output allowance and injects the real provider key. The platform also owns each user's POSIX workspace and personal skill library. File writes use expected revisions and request IDs; skill selections are frozen when a task is accepted. Skill instructions are read as data and included in that user's Agent prompt, without loading executable code into the host.

The connector queries a controlled HTTP note API without an execution sandbox. A write tool persists one exact proposal in PG, then returns an approval receipt; it cannot directly perform the write. A separate platform-origin page shows the content and fingerprint. The platform checks the action owner and reviewed fingerprint before deciding, checks the current permission before dispatch, and uses a stable remote idempotency key. Unknown results are queried before any retry. A terminal result queues one platform-origin follow-up in the original Session. The API credential stays in the platform process.

Configuration is explicit in the two bundle patches. Required secret values are read from private files at startup. Database pool, timeouts, request/history/output limits, per-user admission, host concurrency, polling, lease renewal, and subscription bounds are configuration inputs. Readiness files identify the owning process instance for the trial lifecycle script.

## Recovery and limits

A client receives `accepted` only after the operation commits. An unconsumed input can be delivered after restart. Consumed input with no completed turn is closed as interrupted by native DSH restoration and reported as failed. It is not automatically sent to the model again. A lost completion response is reconciled from the recorded turn when the lease is reclaimed.

This slice supports root text conversations, bounded file transfer and text editing, personal skill instructions, and two controlled remote API tools. Completed output arrives through durable event subscriptions; partial model tokens are not broadcast to browsers. The private profile does not promise compatibility with every native controller or Session persistence consumer. It refuses unknown Session generations rather than migrating the older PowerEvolve database. An unresolved remote write remains in PG for reconciliation; the host never replays it blindly.

The local trial runs separate processes under the current OS user. This does not enforce filesystem or network isolation against a compromised process. Production deployment must place the host and platform under separate identities, secret mounts, and network policies before accepting untrusted tenants. Writable sandbox mounts also require stronger path isolation. This connector is a loopback trial target, not a general third-party connector catalog. Sandboxes, desktop devices, and production ingress are later slices.

## Verification

`pnpm run test:power-evolve` runs built `dsh` profiles with a real, uniquely named test database and deterministic model and remote API endpoints. It checks identity and configuration separation, authorization refusal, streams, duplicate acceptance, interruption/restart, stale grants, logout, native history replay, Agent/Session cleanup, file bytes, personal skills, exact approvals, permission revocation, remote reconciliation, and original-Session continuation. Test listeners use OS-assigned ports; teardown waits for child exits and database connections to close. The local browser trial separately verifies real DeepSeek calls.
