# Cloud account integration

English | [中文](cloud.zh.md)

The [cloud package map](../../packages/cloud/README.md) locates the optional deployment components. This reference describes their shared runtime inputs; package READMEs own activation requirements. These components do not add a Session implementation.

<a id="account-identities"></a>
## Account identities

The runtime package owns [account identity and lifecycle types](../../packages/cloud/pe-cloud-runtime/src/types.ts). `AccountId` identifies an authenticated database account. `OwnerEpoch` preserves the PostgreSQL decimal value without conversion to a JavaScript number. `InstanceId` identifies a server process start, and `OperationId` identifies actual work whose responsibility may outlive a request.

`AccountBinding` is immutable trusted input for one account graph. Its lifetime signal belongs to the graph; cancelling a caller's wait does not cancel that lifetime. `AccountUse` borrows a native Context, checks current admission immediately before native work, and releases only the borrow. Neither value is accepted from browser JSON.

The private native boot adapter installs an independent `ProfileContext`, launch environment and account binding before mounting one native root Include. Port preparation receives the exact installed binding. After preparation, the adapter rechecks that lifetime before returning control to native boot; boot and disposal retain their actual Promises after a caller stops waiting. A mounted native tree still requires the factory's provider, save and exposure audits before it can serve an account.

<a id="actual-work-and-capacity"></a>
## Actual work and capacity

The runtime root registers exactly two required participant categories: `files` and `execution`. Contributions belong to their caller's Cordis effect and disappear when that effect is disposed. Duplicate registration and missing participants reject mount-capacity reservation.

`ParticipantReceipt` identifies its account, epoch, participant and evidence. A confirmed receipt has no pending operation ids. An unknown receipt retains pending work and a reason; a request deadline or rejected wait does not establish that actual work stopped.

Local mount and drain reservations bound concurrent work. Settling mount work releases its operation slot; the mounted-account slot remains reserved until its owner releases it after actual cleanup. These reservations do not acquire a database owner or establish account readiness.

The files root prestarts a fixed worker pool. Account drain retains the shared pool; root shutdown retains the service and participant until workers exit and held results are released. API configuration-save receipts separately track admitted native writes and required application through their actual Promises. Configuration saving is not a third drain participant, and failed or unresolved saves cannot establish a clean graph.

<a id="native-adapters"></a>
## Native adapters

Cloud request consistency uses the [access-owned request types](../../packages/cloud/pe-cloud-access/src/types.ts). Client account and generation fields are expectations, not authentication credentials. Native HTTP, stream and controller adapters retain the original transport messages and native Session state.

An endpoint allowlist does not install the internal Session adapter into native dispatch. The current native owner path bypasses remote-access policy, so opening Session methods also requires installed cloud project and preset checks before native effects. Public Controller adaptation is under verification; any additional native extension requires a contract review. Account admission remains closed until the actual dispatch path passes consumer validation.
